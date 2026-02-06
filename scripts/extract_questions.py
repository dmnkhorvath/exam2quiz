#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "pymupdf",
#     "Pillow",
# ]
# ///
"""
PDF Question Extractor (Image-based, Parallel)

Extracts numbered question sections from PDF documents as images,
preserving visual formatting, colors, and layout.

Usage:
    uv run extract_questions.py <pdf_or_folder> [options]
"""

import argparse
import json
import logging
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image


# Question delimiter pattern - matches "X pont" (Hungarian for "X points")
QUESTION_PATTERN = re.compile(
    r'(?<!\d[-–])\b(\d+)\s*pont\b(?!\s*adható)',
    re.IGNORECASE
)


def setup_logging(log_file: Path) -> logging.Logger:
    """Setup logging to file and console."""
    logger = logging.getLogger("pdf_extractor")
    logger.setLevel(logging.DEBUG)

    fh = logging.FileHandler(log_file, mode='w', encoding='utf-8')
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter('%(message)s'))

    logger.addHandler(fh)
    logger.addHandler(ch)

    return logger


def find_question_positions(page: fitz.Page) -> list[dict]:
    """Find positions of question delimiters ("X pont") on a page."""
    questions = []
    page_width = page.rect.width

    text_instances = page.search_for("pont", quads=False)

    for rect in text_instances:
        if rect.x0 < page_width * 0.5:
            continue

        # Expand search area to capture surrounding context
        expanded_rect = fitz.Rect(rect.x0 - 100, rect.y0 - 5, rect.x1 + 50, rect.y1 + 5)
        text_around = page.get_text("text", clip=expanded_rect).strip()

        # Skip scoring instructions like "Helyes válaszonként 1-1 pont adható!"
        skip_words = ['adható', 'válaszonként', 'helyes válasz', 'pontonként']
        if any(word in text_around.lower() for word in skip_words):
            continue

        match = QUESTION_PATTERN.search(text_around)
        if match:
            points = int(match.group(1))
            questions.append({
                'number': f"{points}pt",
                'points': points,
                'bbox': rect,
                'y_top': rect.y0,
                'line_text': text_around[:80]
            })

    questions.sort(key=lambda q: (q['y_top'], q['bbox'].x0))

    filtered = []
    last_y = -100
    for q in questions:
        if abs(q['y_top'] - last_y) > 10:
            filtered.append(q)
            last_y = q['y_top']

    return filtered


def extract_question_images(
    pdf_path: Path,
    output_dir: Path,
    dpi: int = 150,
    padding: int = 10,
    logger: logging.Logger = None
) -> list[dict]:
    """Extract questions from PDF as individual images."""
    doc = fitz.open(pdf_path)
    results = []
    question_counter = 0
    pdf_stem = pdf_path.stem

    for page_num in range(len(doc)):
        page = doc[page_num]
        page_height = page.rect.height

        questions = find_question_positions(page)
        if not questions:
            continue

        zoom = dpi / 72
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)

        for i, q in enumerate(questions):
            question_counter += 1
            y_top = q['y_top'] - padding

            if i + 1 < len(questions):
                y_bottom = questions[i + 1]['y_top'] - padding
            else:
                y_bottom = page_height

            px_top = int(max(0, y_top * zoom))
            px_bottom = int(min(pix.height, y_bottom * zoom))

            if px_top >= px_bottom or px_bottom <= 0 or px_top >= pix.height:
                continue

            cropped = img.crop((0, px_top, pix.width, px_bottom))

            if cropped.width <= 0 or cropped.height <= 0:
                continue

            output_filename = f"{pdf_stem}_q{question_counter:03d}_{q['points']}pt.png"
            output_path = output_dir / output_filename
            cropped.save(output_path, "PNG")

            results.append({
                'question_number': q['number'],
                'global_index': question_counter,
                'page': page_num + 1,
                'image_file': output_filename,
                'preview': q['line_text']
            })

    doc.close()
    return results


def process_pdf(pdf_path: Path, output_dir: Path, dpi: int, logger: logging.Logger) -> dict:
    """Process a single PDF file and extract question images."""
    logger.debug(f"Starting: {pdf_path.name}")

    pdf_output_dir = output_dir / pdf_path.stem
    pdf_output_dir.mkdir(parents=True, exist_ok=True)

    try:
        questions = extract_question_images(pdf_path, pdf_output_dir, dpi=dpi, logger=logger)

        result = {
            'file': str(pdf_path.name),
            'path': str(pdf_path.absolute()),
            'output_dir': str(pdf_output_dir),
            'question_count': len(questions),
            'questions': questions
        }

        manifest_path = pdf_output_dir / "manifest.json"
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        logger.info(f"✓ {pdf_path.name} -> {len(questions)} questions")

        return result

    except Exception as e:
        logger.error(f"✗ {pdf_path.name} - Error: {e}")
        return {
            'file': str(pdf_path.name),
            'error': str(e),
            'questions': []
        }


def process_pdfs_parallel(
    pdf_files: list[Path],
    output_dir: Path,
    dpi: int,
    logger: logging.Logger,
    workers: int = 4
) -> list[dict]:
    """Process multiple PDFs in parallel."""
    results = [None] * len(pdf_files)

    logger.info(f"Processing {len(pdf_files)} PDFs with {workers} workers...\n")

    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_idx = {
            executor.submit(process_pdf, pdf, output_dir, dpi, logger): i
            for i, pdf in enumerate(pdf_files)
        }

        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                results[idx] = future.result()
            except Exception as e:
                results[idx] = {
                    'file': pdf_files[idx].name,
                    'error': str(e),
                    'questions': []
                }

    return results


def main():
    parser = argparse.ArgumentParser(
        description='Extract numbered questions from PDFs as images (parallel processing).',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  %(prog)s document.pdf
  %(prog)s ./pdfs/ -o ./output/ -w 8
  %(prog)s ./pdfs/ --dpi 200 --json manifest.json
        '''
    )

    parser.add_argument('input', type=Path, help='PDF file or folder containing PDFs')
    parser.add_argument('-o', '--output-dir', type=Path, default=Path('./extracted_questions'),
                        help='Output directory (default: ./extracted_questions)')
    parser.add_argument('--dpi', type=int, default=150, help='Image DPI (default: 150)')
    parser.add_argument('-w', '--workers', type=int, default=4, help='Parallel workers (default: 4)')
    parser.add_argument('--json', type=Path, help='Save combined manifest to JSON')
    parser.add_argument('-l', '--log', type=Path, default=Path('extract_questions.log'), help='Log file')

    args = parser.parse_args()

    logger = setup_logging(args.log)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    logger.info(f"Output: {args.output_dir}")
    logger.info(f"DPI: {args.dpi}")
    logger.info(f"Workers: {args.workers}")
    logger.info(f"Log: {args.log}")

    # Get PDF files
    if args.input.is_file():
        if args.input.suffix.lower() != '.pdf':
            logger.error(f"{args.input} is not a PDF file")
            sys.exit(1)
        pdf_files = [args.input]
    elif args.input.is_dir():
        pdf_files = sorted(args.input.glob('*.pdf'))
        if not pdf_files:
            logger.error(f"No PDF files found in {args.input}")
            sys.exit(1)
    else:
        logger.error(f"{args.input} does not exist")
        sys.exit(1)

    # Process
    if len(pdf_files) == 1:
        results = [process_pdf(pdf_files[0], args.output_dir, args.dpi, logger)]
    else:
        results = process_pdfs_parallel(pdf_files, args.output_dir, args.dpi, logger, args.workers)

    # Save combined manifest
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        logger.info(f"Manifest: {args.json}")

    # Summary
    total_questions = sum(r.get('question_count', 0) for r in results if r)
    successful = len([r for r in results if r and 'error' not in r])

    logger.info(f"\n{'=' * 50}")
    logger.info(f"Completed: {successful}/{len(pdf_files)} PDFs")
    logger.info(f"Total: {total_questions} questions extracted")
    logger.info(f"Output: {args.output_dir}/")


if __name__ == '__main__':
    main()
