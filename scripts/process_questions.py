#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "google-genai",
# ]
# ///
"""
Unified Question Processing Script using Google Gemini.

Commands:
  parse              Parse question images from folders
  retry-parse        Retry failed image parsing
  retry-categorize   Retry failed categorizations

Usage:
    export GOOGLE_API_KEY="your-api-key"

    uv run scripts/process_questions.py parse data/extracted_questions/
    uv run scripts/process_questions.py retry-parse
    uv run scripts/process_questions.py retry-categorize
"""

import argparse
import json
import logging
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from google import genai
from google.genai import types


# =============================================================================
# Constants & Prompts
# =============================================================================

PARSE_SYSTEM_PROMPT = """Parse this Hungarian medical exam image. RED TEXT = correct answers filled in by solution key.

Extract these fields:
- question_number: e.g. "1.", "2.*", "19."
- points: integer from "X pont"
- question_text: ALL BLACK text. For tables, use markdown format with empty cells where red answers appear.
- question_type: "multiple_choice" or "fill_in" or "matching" or "open"
- correct_answer: RED text only. For tables, use markdown format showing the filled answers.
- options: list of all choices for multiple choice, empty [] otherwise

TABLE FORMATTING (use markdown):
- question_text table: show structure with EMPTY cells where red answers would go
- correct_answer table: show the RED answers in their positions

RULES:
- Tables MUST be markdown format in both question_text and correct_answer
- question_text: include all BLACK text, leave answer cells EMPTY
- correct_answer: show only RED text (answers), can be markdown table or plain text
- If no red text visible, set correct_answer to ""
- Keep Hungarian characters exact (á, é, í, ó, ö, ő, ú, ü, ű)"""

PARSE_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "question_number": {"type": "string"},
        "points": {"type": "integer"},
        "question_text": {"type": "string"},
        "question_type": {"type": "string", "enum": ["multiple_choice", "fill_in", "matching", "open"]},
        "correct_answer": {"type": "string"},
        "options": {"type": "array", "items": {"type": "string"}}
    },
    "required": ["question_number", "points", "question_text", "question_type", "correct_answer"]
}

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

CATEGORIZE_SYSTEM_PROMPT = f"""You are a medical exam question categorizer. Categorize Hungarian medical exam questions into exactly one of these categories:

{chr(10).join(f'{i+1}. {cat}' for i, cat in enumerate(CATEGORIES))}

Rules:
- Choose the SINGLE most appropriate category based on the question content
- Return ONLY a JSON object with "category" and "reasoning" fields
- If a question spans multiple topics, choose the PRIMARY topic

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


# =============================================================================
# Logging Setup
# =============================================================================

def setup_logging(log_file: Path | None = None) -> logging.Logger:
    logger = logging.getLogger("question_processor")
    logger.setLevel(logging.DEBUG)
    logger.handlers = []

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter('%(message)s'))
    logger.addHandler(ch)

    if log_file:
        fh = logging.FileHandler(log_file, mode='w', encoding='utf-8')
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
        logger.addHandler(fh)

    return logger


def get_client() -> genai.Client:
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Error: GOOGLE_API_KEY not set. Get key at: https://aistudio.google.com/apikey")
        sys.exit(1)
    return genai.Client(api_key=api_key)


# =============================================================================
# Command: parse - Parse question images
# =============================================================================

def parse_single_image(image_path: Path, client: genai.Client, model: str, max_retries: int = 3) -> dict:
    """Parse a single question image using Gemini."""
    for attempt in range(max_retries):
        try:
            with open(image_path, "rb") as f:
                image_data = f.read()

            response = client.models.generate_content(
                model=model,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(data=image_data, mime_type="image/png"),
                            types.Part.from_text(text=PARSE_SYSTEM_PROMPT)
                        ]
                    )
                ],
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    max_output_tokens=2048,
                    response_mime_type="application/json",
                    response_schema=PARSE_RESPONSE_SCHEMA,
                )
            )

            parsed = json.loads(response.text)
            return {"file": image_path.name, "success": True, "data": parsed}

        except json.JSONDecodeError as e:
            if attempt < max_retries - 1:
                time.sleep(1)
                continue
            return {
                "file": image_path.name,
                "success": False,
                "error": f"JSON parse error: {e}",
                "error_type": "json_parse_error"
            }
        except Exception as e:
            if "429" in str(e) and attempt < max_retries - 1:
                time.sleep((attempt + 1) * 2)
                continue
            if attempt < max_retries - 1:
                time.sleep(1)
                continue
            return {"file": image_path.name, "success": False, "error": str(e), "error_type": "api_error"}

    return {"file": image_path.name, "success": False, "error": "Max retries exceeded"}


def process_folder(folder_path: Path, client: genai.Client, model: str, image_workers: int, logger: logging.Logger) -> dict:
    """Process all images in a folder."""
    image_files = sorted(
        list(folder_path.glob("*.png")) +
        list(folder_path.glob("*.jpg")) +
        list(folder_path.glob("*.jpeg"))
    )

    if not image_files:
        return {"folder": folder_path.name, "success": True, "question_count": 0, "questions": []}

    results = [None] * len(image_files)

    with ThreadPoolExecutor(max_workers=image_workers) as executor:
        future_to_idx = {
            executor.submit(parse_single_image, img, client, model): i
            for i, img in enumerate(image_files)
        }

        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                results[idx] = future.result()
            except Exception as e:
                results[idx] = {"file": image_files[idx].name, "success": False, "error": str(e)}

    output_file = folder_path / "parsed.json"
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    successful = sum(1 for r in results if r and r.get("success"))
    logger.info(f"  ✓ {folder_path.name}: {successful}/{len(results)} questions")

    return {"folder": folder_path.name, "success": True, "question_count": len(results), "successful": successful}


def cmd_parse(args):
    """Parse command - parse question images from folders."""
    logger = setup_logging(args.log)
    client = get_client()

    logger.info(f"Model: {args.model}")
    logger.info(f"Workers: {args.folder_workers} folders × {args.image_workers} images")

    if not args.input.is_dir():
        logger.error(f"{args.input} is not a directory")
        sys.exit(1)

    folders = [item for item in sorted(args.input.iterdir())
               if item.is_dir() and (any(item.glob("*.png")) or any(item.glob("*.jpg")))]

    if not folders:
        logger.error(f"No folders with images found in {args.input}")
        sys.exit(1)

    logger.info(f"Found {len(folders)} folders\n")

    results = []
    with ThreadPoolExecutor(max_workers=args.folder_workers) as executor:
        futures = {executor.submit(process_folder, f, client, args.model, args.image_workers, logger): f for f in folders}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                results.append({"folder": futures[future].name, "success": False, "error": str(e)})

    total_questions = sum(r.get('question_count', 0) for r in results)
    total_successful = sum(r.get('successful', 0) for r in results)

    logger.info(f"\n{'=' * 50}")
    logger.info(f"Folders: {len([r for r in results if r.get('success')])}/{len(folders)}")
    logger.info(f"Questions: {total_successful}/{total_questions} parsed")


# =============================================================================
# Command: retry-parse - Retry failed image parsing
# =============================================================================

def cmd_retry_parse(args):
    """Retry failed image parsing."""
    logger = setup_logging()
    client = get_client()

    if not args.failed_file.exists():
        logger.error(f"{args.failed_file} not found")
        sys.exit(1)

    with open(args.failed_file, 'r') as f:
        failed_items = json.load(f)

    logger.info(f"Retrying {len(failed_items)} failed images...\n")

    # Group by folder
    folders = {}
    for item in failed_items:
        folder = item['folder']
        folders.setdefault(folder, []).append(item)

    total_fixed = 0
    total_still_failed = 0

    for folder_name, items in folders.items():
        folder_path = args.data_dir / folder_name
        parsed_file = folder_path / "parsed.json"

        if not parsed_file.exists():
            continue

        with open(parsed_file, 'r', encoding='utf-8') as f:
            parsed_data = json.load(f)

        parsed_lookup = {p['file']: i for i, p in enumerate(parsed_data)}

        for item in items:
            image_path = folder_path / item['file']
            if not image_path.exists():
                continue

            print(f"  Retrying: {folder_name}/{item['file']}...", end=" ", flush=True)
            result = parse_single_image(image_path, client, args.model)

            if item['file'] in parsed_lookup:
                parsed_data[parsed_lookup[item['file']]] = result

            if result['success']:
                print("✓")
                total_fixed += 1
            else:
                print(f"✗ {result.get('error', '')[:50]}")
                total_still_failed += 1

            time.sleep(0.2)

        with open(parsed_file, 'w', encoding='utf-8') as f:
            json.dump(parsed_data, f, indent=2, ensure_ascii=False)

    logger.info(f"\n{'=' * 50}")
    logger.info(f"Fixed: {total_fixed}")
    logger.info(f"Still failed: {total_still_failed}")


# =============================================================================
# Command: retry-categorize - Retry failed categorizations
# =============================================================================

def extract_json_from_response(text: str) -> dict:
    """Extract JSON from response, handling markdown code blocks."""
    if not text:
        raise ValueError("Empty response")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if json_match:
        return json.loads(json_match.group(1).strip())

    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        return json.loads(json_match.group(0))

    raise ValueError(f"Could not extract JSON from: {text[:100]}")


def categorize_question(question: dict, client: genai.Client, model: str, max_retries: int = 3) -> dict:
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
                contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
                config=types.GenerateContentConfig(
                    system_instruction=CATEGORIZE_SYSTEM_PROMPT,
                    temperature=0.1,
                    max_output_tokens=1024,
                )
            )

            result = extract_json_from_response(response.text)
            category = result.get("category", "")

            # Validate category
            if category not in CATEGORIES:
                for cat in CATEGORIES:
                    if cat.lower() in category.lower() or category.lower() in cat.lower():
                        category = cat
                        break

            return {"success": True, "category": category, "reasoning": result.get("reasoning", "")}

        except (json.JSONDecodeError, ValueError) as e:
            if attempt < max_retries - 1:
                time.sleep(0.5)
                continue
            return {"success": False, "error": f"JSON parse error: {e}"}
        except Exception as e:
            if "429" in str(e) and attempt < max_retries - 1:
                time.sleep((attempt + 1) * 2)
                continue
            return {"success": False, "error": str(e)}

    return {"success": False, "error": "Max retries exceeded"}


def cmd_retry_categorize(args):
    """Retry failed categorizations."""
    logger = setup_logging()
    client = get_client()

    with open(args.input, 'r', encoding='utf-8') as f:
        all_questions = json.load(f)

    failed_indices = [i for i, q in enumerate(all_questions)
                      if not q.get("categorization", {}).get("success", False)]

    logger.info(f"Found {len(failed_indices)} failed categorizations to retry")

    if not failed_indices:
        logger.info("Nothing to retry!")
        return

    save_lock = threading.Lock()

    def save_results():
        with save_lock:
            with open(args.input, 'w', encoding='utf-8') as f:
                json.dump(all_questions, f, indent=2, ensure_ascii=False)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_idx = {
            executor.submit(categorize_question, all_questions[i], client, args.model): i
            for i in failed_indices
        }

        completed = 0
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                all_questions[idx]["categorization"] = future.result()
            except Exception as e:
                all_questions[idx]["categorization"] = {"success": False, "error": str(e)}

            completed += 1
            if completed % 10 == 0 or completed == len(failed_indices):
                save_results()
                logger.info(f"Progress: {completed}/{len(failed_indices)} retried")

    still_failed = sum(1 for i in failed_indices
                       if not all_questions[i].get("categorization", {}).get("success"))

    logger.info(f"\n{'=' * 50}")
    logger.info(f"Fixed: {len(failed_indices) - still_failed}/{len(failed_indices)}")
    logger.info(f"Still failing: {still_failed}")


# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Unified Question Processing Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  uv run scripts/process_questions.py parse data/extracted_questions/
  uv run scripts/process_questions.py retry-parse
  uv run scripts/process_questions.py retry-categorize -i data/categorized_questions.json
        """
    )

    subparsers = parser.add_subparsers(dest='command', required=True)

    # parse command
    parse_parser = subparsers.add_parser('parse', help='Parse question images from folders')
    parse_parser.add_argument('input', type=Path, help='Folder containing subfolders with images')
    parse_parser.add_argument('-m', '--model', default='gemini-2.0-flash', help='Gemini model')
    parse_parser.add_argument('-fw', '--folder-workers', type=int, default=5, help='Parallel folder workers')
    parse_parser.add_argument('-iw', '--image-workers', type=int, default=10, help='Parallel image workers per folder')
    parse_parser.add_argument('-l', '--log', type=Path, default=Path('gemini_parser.log'), help='Log file')

    # retry-parse command
    retry_parse_parser = subparsers.add_parser('retry-parse', help='Retry failed image parsing')
    retry_parse_parser.add_argument('-f', '--failed-file', type=Path, default=Path('failed_images.json'),
                                     help='File with failed images list')
    retry_parse_parser.add_argument('-d', '--data-dir', type=Path, default=Path('data/extracted_questions'),
                                     help='Directory with extracted questions')
    retry_parse_parser.add_argument('-m', '--model', default='gemini-2.0-flash', help='Gemini model')

    # retry-categorize command
    retry_cat_parser = subparsers.add_parser('retry-categorize', help='Retry failed categorizations')
    retry_cat_parser.add_argument('-i', '--input', type=Path, default=Path('data/categorized_questions.json'),
                                   help='Input file with categorized questions')
    retry_cat_parser.add_argument('-m', '--model', default='gemini-2.0-flash', help='Gemini model')
    retry_cat_parser.add_argument('-w', '--workers', type=int, default=10, help='Parallel workers')

    args = parser.parse_args()

    if args.command == 'parse':
        cmd_parse(args)
    elif args.command == 'retry-parse':
        cmd_retry_parse(args)
    elif args.command == 'retry-categorize':
        cmd_retry_categorize(args)


if __name__ == '__main__':
    main()
