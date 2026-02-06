#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "google-genai",
# ]
# ///
"""
Question Categorizer using Google Gemini

Merges all parsed.json files and categorizes each question into predefined categories.

Usage:
    export GOOGLE_API_KEY="your-api-key"
    uv run categorize_questions.py <extracted_questions_folder> [options]
"""

import argparse
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from google import genai
from google.genai import types


CATEGORIES = [
    "Általános anatómia és kortan",
    "A mozgás szerv rendszere",
    "Keringés",
    "Légzőrendszer",
    "Idegrendszer",
    "Kiválasztás szervrendszere",
    "Szaporodás szervrendszere",
    "A neuroendokrin rendszer",
    "Az érzékszervek és emlő",
    "Elsősegélynyújtás",
    "Emésztés",
]

SYSTEM_PROMPT = f"""You are a medical exam question categorizer. Your task is to categorize Hungarian medical exam questions into exactly one of these categories:

{chr(10).join(f'{i+1}. {cat}' for i, cat in enumerate(CATEGORIES))}

Rules:
- Choose the SINGLE most appropriate category based on the question content
- Return ONLY the category name exactly as written above
- If a question spans multiple topics, choose the PRIMARY topic
- Consider both the question text and the correct answer when categorizing

Category guidelines:
- "Általános anatómia és kortan": General anatomy, body types, cell biology, health factors, pathology basics
- "A mozgás szerv rendszere": Bones, muscles, joints, spine, limbs, musculoskeletal diseases
- "Keringés": Heart, blood vessels, blood, circulation, cardiovascular diseases
- "Légzőrendszer": Lungs, respiratory tract, breathing, respiratory diseases
- "Idegrendszer": Brain, spinal cord, nerves, neurological diseases, reflexes
- "Kiválasztás szervrendszere": Kidneys, urinary system, urine, excretion
- "Szaporodás szervrendszere": Reproductive organs, pregnancy, sexual development
- "A neuroendokrin rendszer": Hormones, glands (thyroid, pituitary, adrenal), endocrine diseases
- "Az érzékszervek és emlő": Eyes, ears, skin sensation, breast anatomy and diseases
- "Elsősegélynyújtás": First aid, emergency care, resuscitation, trauma care
- "Emésztés": Digestive system, stomach, intestines, liver, nutrition, vitamins
"""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {
            "type": "string",
            "enum": CATEGORIES
        },
        "reasoning": {
            "type": "string",
            "description": "Brief explanation for the categorization"
        }
    },
    "required": ["category", "reasoning"]
}


def setup_logging(log_file: Path) -> logging.Logger:
    """Setup logging to file and console."""
    logger = logging.getLogger("categorizer")
    logger.setLevel(logging.DEBUG)
    logger.handlers = []

    fh = logging.FileHandler(log_file, mode='w', encoding='utf-8')
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter('%(message)s'))

    logger.addHandler(fh)
    logger.addHandler(ch)

    return logger


def merge_parsed_files(input_dir: Path, logger: logging.Logger) -> list[dict]:
    """Merge all parsed.json files into a single list."""
    all_questions = []

    parsed_files = sorted(input_dir.glob("**/parsed.json"))
    logger.info(f"Found {len(parsed_files)} parsed.json files")

    for parsed_file in parsed_files:
        folder_name = parsed_file.parent.name
        try:
            with open(parsed_file, 'r', encoding='utf-8') as f:
                questions = json.load(f)

            for q in questions:
                if q.get("success") and q.get("data"):
                    q["source_folder"] = folder_name
                    all_questions.append(q)

            logger.debug(f"Loaded {len(questions)} questions from {folder_name}")
        except Exception as e:
            logger.error(f"Error loading {parsed_file}: {e}")

    logger.info(f"Total questions merged: {len(all_questions)}")
    return all_questions


def extract_json_from_response(text: str) -> dict:
    """Extract JSON from response, handling markdown code blocks."""
    if not text:
        raise ValueError("Empty response")

    # Try direct JSON parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to extract from markdown code block
    import re
    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if json_match:
        return json.loads(json_match.group(1).strip())

    # Try to find JSON object in text
    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        return json.loads(json_match.group(0))

    raise ValueError(f"Could not extract JSON from: {text[:100]}")


def categorize_question(
    question: dict,
    client: genai.Client,
    model: str,
    max_retries: int = 3
) -> dict:
    """Categorize a single question using Gemini."""

    data = question.get("data", {})
    question_text = data.get("question_text", "")
    correct_answer = data.get("correct_answer", "")

    prompt = f"""Categorize this Hungarian medical exam question:

Question: {question_text}

Correct Answer: {correct_answer}

Return ONLY a JSON object with "category" and "reasoning" fields. No markdown, no explanation."""

    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model=model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=prompt)]
                    )
                ],
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    temperature=0.1,
                    max_output_tokens=1024,
                )
            )

            result = extract_json_from_response(response.text)

            # Validate category
            category = result.get("category", "")
            if category not in CATEGORIES:
                # Try to find closest match
                for cat in CATEGORIES:
                    if cat.lower() in category.lower() or category.lower() in cat.lower():
                        category = cat
                        break

            return {
                "success": True,
                "category": category,
                "reasoning": result.get("reasoning", "")
            }

        except (json.JSONDecodeError, ValueError) as e:
            if attempt < max_retries - 1:
                time.sleep(0.5)
                continue
            return {
                "success": False,
                "error": f"JSON parse error: {e}",
                "raw_response": response.text if 'response' in locals() else None
            }
        except Exception as e:
            if "429" in str(e) and attempt < max_retries - 1:
                time.sleep((attempt + 1) * 2)
                continue
            return {
                "success": False,
                "error": str(e)
            }

    return {"success": False, "error": "Max retries exceeded"}


def categorize_all_questions(
    questions: list[dict],
    client: genai.Client,
    model: str,
    workers: int,
    logger: logging.Logger,
    output_file: Path
) -> list[dict]:
    """Categorize all questions in parallel with incremental saving."""

    results = [None] * len(questions)
    save_lock = threading.Lock()

    def save_results():
        """Save current results to file (thread-safe)."""
        with save_lock:
            # Filter out None values for partial saves
            current_results = [r for r in results if r is not None]
            with open(output_file, 'w', encoding='utf-8') as f:
                json.dump(current_results, f, indent=2, ensure_ascii=False)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_idx = {
            executor.submit(categorize_question, q, client, model): i
            for i, q in enumerate(questions)
        }

        completed = 0
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                cat_result = future.result()
                questions[idx]["categorization"] = cat_result
                results[idx] = questions[idx]
            except Exception as e:
                questions[idx]["categorization"] = {"success": False, "error": str(e)}
                results[idx] = questions[idx]

            completed += 1

            # Save every 10 questions or at the end
            if completed % 10 == 0 or completed == len(questions):
                save_results()
                logger.info(f"Progress: {completed}/{len(questions)} questions categorized (saved)")

    return results


def main():
    parser = argparse.ArgumentParser(
        description='Merge and categorize exam questions using Google Gemini.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  %(prog)s extracted_questions/
  %(prog)s extracted_questions/ -o categorized_questions.json
  %(prog)s extracted_questions/ -w 20 -m gemini-2.0-flash
        '''
    )

    parser.add_argument('input', type=Path, help='Folder containing parsed.json files')
    parser.add_argument('-m', '--model', default='gemini-3-flash-preview', help='Gemini model (default: gemini-3-flash-preview)')
    parser.add_argument('-o', '--output', type=Path, default=Path('categorized_questions.json'),
                        help='Output file (default: categorized_questions.json)')
    parser.add_argument('-w', '--workers', type=int, default=10, help='Parallel workers (default: 10)')
    parser.add_argument('-l', '--log', type=Path, default=Path('categorizer.log'), help='Log file')
    parser.add_argument('--merge-only', action='store_true', help='Only merge files, skip categorization')

    args = parser.parse_args()

    logger = setup_logging(args.log)

    # Merge all parsed.json files
    logger.info(f"Merging parsed.json files from {args.input}")
    questions = merge_parsed_files(args.input, logger)

    if not questions:
        logger.error("No questions found to process")
        sys.exit(1)

    if args.merge_only:
        # Save merged file without categorization
        merged_output = args.output.with_stem(args.output.stem + "_merged")
        with open(merged_output, 'w', encoding='utf-8') as f:
            json.dump(questions, f, indent=2, ensure_ascii=False)
        logger.info(f"Merged questions saved to {merged_output}")
        return

    # Check API key
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error("GOOGLE_API_KEY not set. Get key at: https://aistudio.google.com/apikey")
        sys.exit(1)

    client = genai.Client(api_key=api_key)

    logger.info(f"Model: {args.model}")
    logger.info(f"Workers: {args.workers}")
    logger.info(f"Starting categorization of {len(questions)} questions...\n")

    # Categorize all questions (saves incrementally)
    categorized = categorize_all_questions(questions, client, args.model, args.workers, logger, args.output)

    # Summary
    successful = sum(1 for q in categorized if q.get("categorization", {}).get("success"))
    logger.info(f"\nCategorization complete!")
    logger.info(f"Successfully categorized: {successful}/{len(categorized)}")
    logger.info(f"Output saved to: {args.output}")

    # Category distribution
    category_counts = {}
    for q in categorized:
        cat = q.get("categorization", {}).get("category", "Unknown")
        category_counts[cat] = category_counts.get(cat, 0) + 1

    logger.info(f"\nCategory distribution:")
    for cat in CATEGORIES:
        count = category_counts.get(cat, 0)
        logger.info(f"  {cat}: {count}")


if __name__ == '__main__':
    main()
