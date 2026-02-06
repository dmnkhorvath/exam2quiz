#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "httpx",
#     "beautifulsoup4",
# ]
# ///
"""
Downloads all PDF files linked on the naturasanat.hu TGY megoldolapok page.

Usage:
    uv run download_tgy_pdfs.py
"""

import httpx
from bs4 import BeautifulSoup
from pathlib import Path
from urllib.parse import urljoin

URL = "http://naturasanat.hu/megoldolapok/tgy-megoldolapok"
OUTPUT_DIR = Path("tgy_megoldolapok")


def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    print(f"Fetching page: {URL}")
    with httpx.Client(follow_redirects=True, timeout=30) as client:
        resp = client.get(URL)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        pdf_links = [
            urljoin(URL, a["href"])
            for a in soup.find_all("a", href=True)
            if a["href"].lower().endswith(".pdf")
        ]

        # deduplicate while preserving order
        seen = set()
        unique_links = []
        for link in pdf_links:
            if link not in seen:
                seen.add(link)
                unique_links.append(link)

        print(f"Found {len(unique_links)} PDF files. Downloading...\n")

        for i, pdf_url in enumerate(unique_links, 1):
            filename = pdf_url.rsplit("/", 1)[-1]
            dest = OUTPUT_DIR / filename

            if dest.exists():
                print(f"[{i}/{len(unique_links)}] SKIP (exists): {filename}")
                continue

            print(f"[{i}/{len(unique_links)}] Downloading: {filename}")
            try:
                pdf_resp = client.get(pdf_url)
                pdf_resp.raise_for_status()
                dest.write_bytes(pdf_resp.content)
            except httpx.HTTPError as e:
                print(f"  ERROR: {e}")

    print(f"\nDone! Files saved to: {OUTPUT_DIR.resolve()}")


if __name__ == "__main__":
    main()
