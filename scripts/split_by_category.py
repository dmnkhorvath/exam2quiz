#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# ///

import json
import os
import re
from pathlib import Path

# Hungarian to English character mapping
HU_TO_EN = {
    'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ö': 'o', 'ő': 'o',
    'ú': 'u', 'ü': 'u', 'ű': 'u',
    'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ö': 'O', 'Ő': 'O',
    'Ú': 'U', 'Ü': 'U', 'Ű': 'U',
}

def transliterate(text: str) -> str:
    """Convert Hungarian characters to English equivalents."""
    for hu, en in HU_TO_EN.items():
        text = text.replace(hu, en)
    return text

def sanitize_filename(name: str) -> str:
    """Convert category name to safe English filename."""
    name = transliterate(name)
    name = re.sub(r'[^a-zA-Z0-9\s-]', '', name)
    name = re.sub(r'\s+', '_', name)
    return name.lower()

def group_by_similarity(items: list) -> list[list]:
    """
    Group questions by similarity_group_id.
    Questions with null/None similarity_group_id are placed in their own individual groups.
    """
    groups: dict[str, list] = {}
    null_counter = 0

    for item in items:
        group_id = item.get('similarity_group_id')

        if group_id is None:
            # Each null question gets its own unique group
            groups[f'__null_{null_counter}'] = [item]
            null_counter += 1
        else:
            if group_id not in groups:
                groups[group_id] = []
            groups[group_id].append(item)

    return list(groups.values())


def main():
    root_dir = Path(__file__).parent.parent
    input_file = root_dir / 'public' / 'categorized_questions_with_similarity.json'
    output_dir = root_dir / 'public' / 'categories'

    print(f"Reading {input_file}...")
    with open(input_file, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Group by category
    categories: dict[str, list] = {}
    skipped = []

    for item in data:
        category = item.get('categorization', {}).get('category')

        if not category:
            skipped.append(item.get('file', 'unknown'))
            continue

        if category not in categories:
            categories[category] = []

        categories[category].append(item)

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    print(f"Output directory: {output_dir}")

    print(f"\nFound {len(categories)} categories:\n")

    # Write separate files for each category
    for category, items in sorted(categories.items(), key=lambda x: -len(x[1])):
        filename = f"{sanitize_filename(category)}.json"
        output_path = output_dir / filename

        # Group questions by similarity
        grouped_items = group_by_similarity(items)

        output_data = {
            "category_name": category,
            "groups": grouped_items
        }

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(output_data, f, ensure_ascii=False, indent=2)

        print(f"  {category}: {len(items)} questions in {len(grouped_items)} groups -> {filename}")

    if skipped:
        print(f"\nSkipped {len(skipped)} items without category:")
        for file in skipped:
            print(f"  - {file}")

    print(f"\nDone!")

if __name__ == '__main__':
    main()
