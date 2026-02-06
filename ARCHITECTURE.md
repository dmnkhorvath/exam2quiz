# CSUMPI Exam — Architectural Plan

> A comprehensive guide to recreating the Hungarian exam question processing platform via agentic coding.

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Processing Pipeline](#2-processing-pipeline)
   - [Step 1: PDF Extraction](#step-1-pdf-extraction)
   - [Step 2: Image Parsing via Gemini AI](#step-2-image-parsing-via-gemini-ai)
   - [Step 3: Question Categorization](#step-3-question-categorization)
   - [Step 4: Similarity Detection](#step-4-similarity-detection)
   - [Step 5: Category Split for Frontend](#step-5-category-split-for-frontend)
3. [Frontend Application](#3-frontend-application)
   - [Tech Stack](#tech-stack)
   - [Pages & Routing](#pages--routing)
   - [Data Flow](#data-flow)
4. [Data Models](#4-data-models)
5. [Deployment](#5-deployment)
6. [Dependency Reference](#6-dependency-reference)
7. [Reproduction Checklist](#7-reproduction-checklist)

---

## 1. System Overview

The platform processes Hungarian qualification exam PDFs through a multi-stage pipeline:

```
PDF Exams
    │
    ▼
┌──────────────────────────────────────────────┐
│  1. extract_questions.py   (PyMuPDF)         │  PDF → PNG images per question
│  2. process_questions.py   (Gemini AI)       │  PNG → structured JSON
│  3. categorize_questions.py (Gemini AI)      │  JSON → categories (from config)
│  4. find_similar_questions.py (ML pipeline)  │  Detect duplicate questions
│  5. split_by_category.py                     │  Organize for frontend
└──────────────────────────────────────────────┘
    │
    ▼
React/Vite Web UI  →  Docker/Nginx  →  :34729
```

**Scale:** ~327 exam PDFs, 5,000+ extracted questions, categories defined in `config/categories.json`.

---

## 2. Processing Pipeline

All scripts live in `scripts/` and are run with `uv run`.

### Step 1: PDF Extraction

**File:** `scripts/extract_questions.py` (~297 lines)

**Purpose:** Split each exam PDF into individual question images (PNG).

**How it works:**

1. Scans each PDF page for question markers using regex pattern matching on text containing `"X pont"` (Hungarian for "X points").
2. Uses `fitz` (PyMuPDF) to locate the text positions on the page.
3. Determines question boundaries: each question starts at its marker and ends where the next question (or page) begins.
4. Crops the page region for each question and saves it as a PNG image at configurable DPI (default 150).
5. Processes PDFs in parallel using `ThreadPoolExecutor` (4–8 workers).
6. Outputs per-PDF folder containing PNG images and a `manifest.json`.

**Key functions:**

| Function | Purpose |
|----------|---------|
| `find_question_positions(page)` | Regex-based detection of question markers and their y-coordinates on a page |
| `extract_question_images(pdf_path, output_dir, dpi)` | Crops question regions from all pages, saves PNGs |
| `process_pdfs_parallel(input_dir, output_dir, workers, dpi)` | Multi-threaded batch processing of all PDFs |

**Filename convention:** `{exam_name}_q{NNN}_{N}pt.png` — encodes question number and point value.

**Output structure:**
```
data/extracted_questions/
├── EU_2021_junius_16_XII_eumxii_210616/
│   ├── manifest.json
│   ├── ...q001_3pt.png
│   ├── ...q002_2pt.png
│   └── ...
├── EU_2022_.../
└── ... (327 folders)
```

**CLI:**
```bash
uv run scripts/extract_questions.py ./pdfs/ -o ./data/extracted_questions/ -w 8 --dpi 150
```

**Dependencies:** `fitz` (PyMuPDF), `Pillow`

---

### Step 2: Image Parsing via Gemini AI

**File:** `scripts/process_questions.py` (~522 lines)

**Purpose:** Send each question PNG to Google Gemini 2.0 Flash for OCR and structured field extraction.

**How it works:**

1. For each folder in `data/extracted_questions/`, iterates over PNG images.
2. Sends each image to Gemini with a system prompt that explains the Hungarian exam format:
   - Red text = answers filled in from the answer key
   - Black text = question content
   - Tables should use markdown format
3. Gemini returns a JSON object with structured fields.
4. Results are saved incrementally to `parsed.json` inside each folder.
5. Processing is parallel: 5 folder workers × 10 image workers.

**System prompt key instructions:**
- Identify question type: `multiple_choice`, `fill_in`, `matching`, or `open`
- Extract: `question_number`, `points`, `question_text`, `question_type`, `correct_answer`, `options`
- Use markdown tables for structured content
- Red text indicates the correct answer

**Retry logic:**
- Max 3 attempts per image with exponential backoff
- Handles HTTP 429 (rate limiting) with longer delays
- `retry-parse` subcommand re-processes images that failed initially
- JSON extraction fallback: strips markdown code fences if present

**Key functions:**

| Function | Purpose |
|----------|---------|
| `parse_single_image(image_path, client)` | Single Gemini API call with retry, returns parsed JSON |
| `process_folder(folder_path, client)` | Batch-process all images in one exam folder |
| `extract_json_from_response(text)` | Parse JSON from Gemini response, handle markdown wrapping |

**CLI:**
```bash
export GOOGLE_API_KEY="your-key"
uv run scripts/process_questions.py parse data/extracted_questions/
uv run scripts/process_questions.py retry-parse -f failed_images.json
```

**Dependencies:** `google-genai`

---

### Step 3: Question Categorization

**File:** `scripts/categorize_questions.py` (~354 lines)

**Purpose:** Classify every parsed question into categories defined in an external configuration file using Gemini AI.

**Category Configuration:**

Categories are defined in `config/categories.json` — a single source of truth shared by all pipeline scripts and the frontend. This file can be edited to add, remove, or rename categories without changing any code.

```json
[
  { "key": "ALTALANOS_ANATOMIA_ES_KORTAN", "name": "Általános anatómia és kortan", "file": "altalanos_anatomia_es_kortan.json" },
  { "key": "A_MOZGAS_SZERV_RENDSZERE", "name": "A mozgás szerv rendszere", "file": "a_mozgas_szerv_rendszere.json" },
  ...
]
```

Each entry has:
- `key`: Unique constant identifier (used internally and in code references).
- `name`: Display name (can contain Unicode/Hungarian characters).
- `file`: Sanitized filename for the per-category JSON output (used by `split_by_category.py` and the frontend).

**Default categories (shipped with the project):**

| # | `name` | English Translation |
|---|--------|---------------------|
| 1 | Általános anatómia és kortan | General anatomy & pathology |
| 2 | A mozgás szerv rendszere | Musculoskeletal system |
| 3 | Keringés | Cardiovascular system |
| 4 | Légzőrendszer | Respiratory system |
| 5 | Idegrendszer | Nervous system |
| 6 | Kiválasztás szervrendszere | Urinary/Excretory system |
| 7 | Szaporodás szervrendszere | Reproductive system |
| 8 | A neuroendokrin rendszer | Neuroendocrine system |
| 9 | Az érzékszervek és emlő | Sense organs & breast |
| 10 | Elsősegélynyújtás | First aid & emergency care |
| 11 | Emésztés | Digestive system |

**How it works:**

1. Loads the category list from `config/categories.json`.
2. Merges all `parsed.json` files from the extraction stage into a single list.
3. For each question, sends `question_text` + `correct_answer` to Gemini with the list of valid categories (read from config).
4. Gemini returns a JSON response with `category` and `reasoning`.
5. Uses response schema validation to constrain output to valid categories from the config.
6. Processing is parallel (10 workers default) and thread-safe with incremental saving every 10 questions.
7. Produces a category distribution report upon completion.

**Key functions:**

| Function | Purpose |
|----------|---------|
| `load_categories(config_path)` | Reads category definitions from `config/categories.json` |
| `merge_parsed_files(input_dir)` | Combines all per-folder `parsed.json` into one list |
| `categorize_question(question, client, categories)` | Single Gemini call returning `{category, reasoning}`, constrained to configured categories |
| `categorize_all_questions(questions, output, workers)` | Parallel batch categorization with progress tracking |

**Output:** `data/categorized_questions.json` — flat array of question objects, each now including a `categorization` field.

**CLI:**
```bash
uv run scripts/categorize_questions.py data/extracted_questions/ -o data/categorized_questions.json -w 20
```

**Dependencies:** `google-genai`

---

### Step 4: Similarity Detection

**File:** `scripts/find_similar_questions.py` (~535 lines)

**Purpose:** Detect duplicate and near-duplicate questions using a two-stage ML pipeline.

**Algorithm overview:**

```
Questions (grouped by category)
    │
    ▼
Stage 1: Initial Clustering
    ├─ Encode with intfloat/multilingual-e5-large  (bi-encoder, semantic embeddings)
    ├─ Cluster with HDBSCAN (density-based, min_cluster_size=2)
    ├─ For each cluster:
    │   ├─ Score all pairs with cross-encoder (ms-marco-MiniLM-L-12-v2)
    │   ├─ Build adjacency graph (edges where score ≥ 0.7)
    │   └─ Find connected components via BFS
    └─ Assign group IDs: {Category}_sim_group_{N}
    │
    ▼
Stage 2: Refinement (automatic for large groups)
    ├─ For groups with > threshold members (default 10):
    │   ├─ Re-cluster with HDBSCAN leaf selection (finer-grained)
    │   ├─ If that fails → hierarchical clustering fallback
    │   └─ Use stricter cross-encoder threshold (0.85 vs 0.7)
    └─ Assign sub-group IDs: {Category}_sim_group_{N}_sub{M}
```

**Stage 1 detail — Connected Components approach:**

1. Group all questions by their category (so similarity is only measured within the same topic).
2. Encode question texts with `intfloat/multilingual-e5-large` (a multilingual sentence embedding model).
3. Run HDBSCAN clustering on the embeddings to get candidate clusters.
4. For each candidate cluster, generate all pairwise question combinations.
5. Score each pair with the cross-encoder `cross-encoder/ms-marco-MiniLM-L-12-v2`.
6. Build an adjacency graph: add an edge between two questions if their cross-encoder score ≥ 0.7.
7. Run BFS to extract connected components from the graph — each component becomes a similarity group.

**Stage 2 detail — Refinement:**

1. After Stage 1, identify groups exceeding the `refine-threshold` (default 10).
2. Try splitting with HDBSCAN using `cluster_selection_method='leaf'` for finer granularity.
3. If HDBSCAN produces only one cluster or fails, fall back to `scipy.cluster.hierarchy` (agglomerative clustering).
4. Use a stricter cross-encoder threshold (0.85) when verifying sub-groups.
5. If splitting produces meaningful sub-groups, replace the original group.

**Key functions:**

| Function | Purpose |
|----------|---------|
| `find_similarity_groups(questions, bi_encoder, cross_encoder, threshold)` | Full Stage 1 pipeline for one category |
| `try_split_group(group, bi_encoder, cross_encoder)` | Stage 2: attempt HDBSCAN refinement |
| `try_split_with_cross_encoder(group, cross_encoder, threshold)` | Stage 2 fallback: hierarchical clustering |
| `group_by_category(questions)` | Partition questions by category |

**Output:** Adds `similarity_group_id` field to each question. Value is `null` for ungrouped questions.

**CLI:**
```bash
uv run scripts/find_similar_questions.py \
  -i public/categorized_questions.json \
  -o public/categorized_questions_with_similarity.json \
  --cross-encoder-threshold 0.7 \
  --refine-threshold 10
```

**Dependencies:** `sentence-transformers`, `scikit-learn`, `hdbscan`, `scipy`, `tqdm`, `numpy`

---

### Step 5: Category Split for Frontend

**File:** `scripts/split_by_category.py` (~112 lines)

**Purpose:** Take the final enriched JSON and split it into one file per category, organized by similarity groups, for the frontend to consume.

**How it works:**

1. Loads category definitions from `config/categories.json`.
2. Reads `public/categorized_questions_with_similarity.json`.
3. Groups questions by category.
4. Within each category, groups questions by `similarity_group_id`.
5. Questions without a similarity group (null) get a synthetic ID `__null_{index}` so each becomes its own single-item group.
6. Sorts groups by size (largest first).
7. Uses `file` field from the config for output filenames (no hardcoded transliteration logic — filenames are defined in the config).
8. Writes one JSON file per category to `public/categories/`.
9. Generates `public/categories/index.json` — a manifest listing all categories with their `key`, `name`, and `file` — consumed by the frontend at runtime.

**Output structure:**
```json
{
  "category_name": "Keringés",
  "groups": [
    [
      { "file": "...", "data": {...}, "similarity_group_id": "Keringés_sim_group_1" },
      { "file": "...", "data": {...}, "similarity_group_id": "Keringés_sim_group_1" }
    ],
    [ ... ]
  ]
}
```

**CLI:**
```bash
uv run scripts/split_by_category.py
```

---

## 3. Frontend Application

### Tech Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 18.3.1 | UI framework |
| React Router DOM | 7.1.0 | Client-side routing |
| Vite | 6.0.5 | Build tool & dev server |
| Tailwind CSS | 3.4.17 | Utility-first styling |
| DaisyUI | 4.12.22 | Component library (light/dark themes) |
| react-markdown | 9.0.1 | Render markdown content (question text, tables) |
| remark-gfm | 4.0.0 | GitHub-flavored markdown (tables, strikethrough) |
| remark-breaks | 4.0.0 | Soft line break support |

### Pages & Routing

**File:** `src/App.jsx` — defines three routes:

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `HomePage` | Category selection grid |
| `/category/:categoryName` | `CategoryPage` | Q&A display for one category |
| `/similarity-groups` | `SimilarityGroupsPage` | Browse all duplicate groups |

#### HomePage (`src/pages/HomePage.jsx`)

- Fetches category definitions from `/categories/index.json` (generated from `config/categories.json` by the split script).
- Renders a responsive grid (1/2/3 columns by breakpoint) of all categories.
- Each category is a link styled with DaisyUI `btn-outline-lg`.
- Secondary link navigates to the similarity groups page.

#### CategoryPage (`src/pages/CategoryPage.jsx`, ~145 lines)

- Fetches `/categories/{categoryName}.json` on mount.
- Sorts similarity groups by size (descending).
- For each group, selects the "best" representative question:
  1. Sort group members by `question_text` length (descending).
  2. Prefer the member that has a non-empty `correct_answer`.
  3. Fall back to the longest question.
- Renders question text as markdown (supports tables via remark-gfm).
- Answer reveal: toggle button flips `revealedAnswers[groupIndex]` state.
- Badge shows group size (e.g., "×3" if 3 similar questions exist).
- Custom markdown table styling: responsive, zebra-striped, with appropriate padding.

**Question selection logic:**
```javascript
const sorted = [...group].sort((a, b) =>
  (b.data?.question_text?.length || 0) - (a.data?.question_text?.length || 0)
);
const item = sorted.find(q => q.data?.correct_answer?.trim()) || sorted[0];
```

#### SimilarityGroupsPage (`src/pages/SimilarityGroupsPage.jsx`, ~158 lines)

- Loads the category index from `/categories/index.json`, then fetches all category JSON files in parallel.
- Aggregates every question that has a non-null `similarity_group_id` (filters out `__null_` prefixed IDs).
- Groups questions by their `similarity_group_id`.
- Filters to groups with 2+ members and sorts by size (descending).
- Displays expandable cards: click to reveal all questions in a group.
- Each expanded question shows source folder, filename, question text (markdown), and answer.
- Header shows total group count and total questions in similar groups.

#### Category Definitions — Dynamic Loading

Categories are **not hardcoded** in the frontend. Instead, the `split_by_category.py` script generates a `public/categories/index.json` manifest from `config/categories.json`:

```json
[
  { "key": "A_MOZGAS_SZERV_RENDSZERE", "name": "A mozgás szerv rendszere", "file": "a_mozgas_szerv_rendszere.json" },
  { "key": "KERINGES", "name": "Keringés", "file": "keringes.json" },
  ...
]
```

The frontend fetches this manifest at runtime. `src/helpers/categories.js` exports a loader function:

```javascript
export async function loadCategories() {
  const res = await fetch('/categories/index.json');
  return res.json(); // array of { key, name, file }
}
```

This means adding or removing a category only requires editing `config/categories.json` and re-running the pipeline — no frontend code changes needed.

### Data Flow

```
config/categories.json          ← single source of truth
    │
    ▼
public/categories/index.json    ← generated manifest for frontend
public/categories/*.json        ← per-category data files
    │
    ├─── HomePage fetches /categories/index.json (dynamic category list)
    │
    ├─── CategoryPage fetches /categories/{name}.json
    │    └─ Renders groups with best-question selection
    │
    └─── SimilarityGroupsPage fetches /categories/index.json + ALL per-category JSONs
         └─ Aggregates cross-category similarity groups
```

---

## 4. Data Models

### Parsed Question (after Step 2)

```json
{
  "file": "EU_2021_junius_16_XII_eumxii_210616_q001_3pt.png",
  "success": true,
  "data": {
    "question_number": "1.*",
    "points": 3,
    "question_text": "Határozza meg az antigén fogalmát!",
    "question_type": "open",
    "correct_answer": "Azok a testidegen anyagok...",
    "options": []
  },
  "source_folder": "EU_2021_junius_16_XII_eumxii_210616"
}
```

### Categorized Question (after Step 3)

Adds to the above:

```json
{
  "categorization": {
    "success": true,
    "category": "Idegrendszer",
    "reasoning": "The question concerns sclerosis multiplex..."
  }
}
```

### Final Question (after Step 4)

Adds to the above:

```json
{
  "similarity_group_id": "Idegrendszer_sim_group_1"
}
```

`similarity_group_id` is `null` when the question has no detected duplicates.

### Question Types

| Type | `options` | `correct_answer` |
|------|-----------|-------------------|
| `multiple_choice` | Array of choice strings | Selected option(s) as text |
| `fill_in` | Empty array | Free text or markdown table |
| `matching` | Array of items to match | Mapping like "B, C, A" |
| `open` | Empty array | Free-text answer, may be multi-line |

### Category Output (Step 5)

```json
{
  "category_name": "Keringés",
  "groups": [
    [
      { "file": "...", "success": true, "data": {...}, "source_folder": "...",
        "categorization": {...}, "similarity_group_id": "Keringés_sim_group_1" },
      { "file": "...", "success": true, "data": {...}, "source_folder": "...",
        "categorization": {...}, "similarity_group_id": "Keringés_sim_group_1" }
    ]
  ]
}
```

Groups are sorted by member count (descending). Single-question "groups" use synthetic `__null_N` IDs.

---

## 5. Deployment

### Docker (Multi-stage Build)

**`Dockerfile`:**

```
Stage 1: node:20-alpine
  - npm ci
  - npm run build → dist/

Stage 2: nginx:alpine
  - Copy dist/ to /usr/share/nginx/html
  - Apply custom nginx.conf
```

**`docker-compose.yml`:**
- Single service, port `34729:80`
- `NODE_ENV=production`
- DNS: `8.8.8.8`

**`nginx.conf`:**
- SPA fallback: `try_files $uri $uri/ /index.html`
- Gzip compression for CSS, JS, JSON
- Static `/assets/` cached for 1 year with `immutable` flag
- Listens on port 80 inside container

### Development

```bash
npm install
npm run dev          # Vite dev server at :5173
```

**`vite.config.js`:**
- React plugin
- Server binds `0.0.0.0:5173` with file-polling (for Docker compatibility)
- HMR client port: 5174

**`tailwind.config.js`:**
- Content: `index.html`, `src/**/*.{js,ts,jsx,tsx}`
- Plugins: `@tailwindcss/typography`, `daisyui`
- DaisyUI themes: `light`, `dark`

---

## 6. Dependency Reference

### Python (run via `uv run`)

| Package | Used In | Purpose |
|---------|---------|---------|
| `PyMuPDF` (fitz) | extract_questions.py | PDF rendering & text extraction |
| `Pillow` | extract_questions.py | Image cropping and saving |
| `google-genai` | process_questions.py, categorize_questions.py | Gemini 2.0 Flash API client |
| `sentence-transformers` | find_similar_questions.py | `intfloat/multilingual-e5-large` embeddings |
| `scikit-learn` | find_similar_questions.py | ML utilities |
| `hdbscan` | find_similar_questions.py | Density-based clustering |
| `scipy` | find_similar_questions.py | Hierarchical clustering fallback |
| `tqdm` | find_similar_questions.py | Progress bars |
| `numpy` | find_similar_questions.py | Array operations |

### Node.js (package.json)

| Package | Purpose |
|---------|---------|
| `react`, `react-dom` | UI framework |
| `react-router-dom` | Client-side routing |
| `react-markdown` | Render markdown in questions |
| `remark-gfm` | GitHub-flavored markdown tables |
| `remark-breaks` | Soft line breaks |
| `tailwindcss` | Utility-first CSS |
| `daisyui` | Tailwind component library |
| `@tailwindcss/typography` | Prose plugin for markdown rendering |
| `vite` | Build tool |
| `@vitejs/plugin-react` | React support for Vite |
| `eslint` + plugins | Linting |
| `postcss`, `autoprefixer` | CSS processing |

---

## 7. Reproduction Checklist

Follow these steps to recreate the entire system from scratch:

### Phase 1: Project Setup

1. Initialize a Node.js project with `npm init`.
2. Install frontend dependencies: `react`, `react-dom`, `react-router-dom`, `react-markdown`, `remark-gfm`, `remark-breaks`.
3. Install dev dependencies: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `daisyui`, `@tailwindcss/typography`, `postcss`, `autoprefixer`, `eslint`.
4. Configure `vite.config.js` with React plugin, `0.0.0.0` host, polling for Docker.
5. Configure `tailwind.config.js` with typography and daisyui plugins.
6. Configure `postcss.config.js` with tailwindcss and autoprefixer.
7. Set up `uv` for Python script management (or use pip/venv).

### Phase 2: PDF Extraction Script

1. Create `scripts/extract_questions.py`.
2. Implement PDF page scanning with regex for `"X pont"` markers.
3. Use PyMuPDF (`fitz`) to get text positions and render page regions as images.
4. Implement question boundary detection: each question runs from its marker to the next marker (or page end).
5. Add parallel processing with `ThreadPoolExecutor`.
6. Output: per-PDF folder with PNGs + `manifest.json`.
7. Accept CLI args: input dir, output dir, workers, DPI.

### Phase 3: Gemini Parsing Script

1. Create `scripts/process_questions.py` with `parse` and `retry-parse` subcommands.
2. Write a system prompt that explains Hungarian exam format (red text = answers, black text = questions, markdown tables).
3. Define the response schema: `question_number`, `points`, `question_text`, `question_type`, `correct_answer`, `options`.
4. Implement image-to-JSON parsing via `google-genai` (Gemini 2.0 Flash model).
5. Add retry logic (3 attempts, exponential backoff, 429 handling).
6. Add JSON extraction with markdown code fence stripping.
7. Process folders in parallel (5 folder workers × 10 image workers).
8. Save `parsed.json` incrementally per folder.

### Phase 4: Category Configuration

1. Create `config/categories.json` with the initial category definitions (see Section 2, Step 3 for the default set).
2. Each entry must have `key`, `name`, and `file` fields.
3. All pipeline scripts and the frontend read categories from this single file — no categories are hardcoded in code.

### Phase 5: Categorization Script

1. Create `scripts/categorize_questions.py`.
2. Load categories dynamically from `config/categories.json`.
3. Implement `merge_parsed_files()` to combine all `parsed.json` files.
4. Send each question's text + answer to Gemini with category list (from config).
5. Use response schema validation to constrain output to configured categories.
6. Process in parallel (10+ workers) with thread-safe incremental saving.
7. Output: `data/categorized_questions.json`.

### Phase 6: Similarity Detection Script

1. Create `scripts/find_similar_questions.py`.
2. Group questions by category before processing.
3. **Stage 1:**
   - Encode texts with `intfloat/multilingual-e5-large` bi-encoder.
   - Cluster with HDBSCAN (`min_cluster_size=2`).
   - For each cluster, score all pairs with `cross-encoder/ms-marco-MiniLM-L-12-v2`.
   - Build adjacency graph (edge if score ≥ 0.7).
   - BFS to find connected components → similarity groups.
4. **Stage 2:**
   - For groups exceeding refine-threshold (default 10), attempt splitting.
   - Try HDBSCAN with `cluster_selection_method='leaf'`.
   - Fallback to `scipy.cluster.hierarchy` agglomerative clustering.
   - Use stricter cross-encoder threshold (0.85) for sub-groups.
5. Assign `similarity_group_id` field: `{Category}_sim_group_{N}` or `{Category}_sim_group_{N}_sub{M}`.
6. Output: `public/categorized_questions_with_similarity.json`.

### Phase 7: Category Split Script

1. Create `scripts/split_by_category.py`.
2. Load categories from `config/categories.json`.
3. Read the similarity-enriched JSON.
4. Group by category, then by `similarity_group_id`.
5. Assign `__null_{index}` IDs to ungrouped questions.
6. Sort groups by size (descending).
7. Use `file` field from config for output filenames (no hardcoded transliteration needed).
8. Write one JSON per category to `public/categories/`.
9. Generate `public/categories/index.json` manifest from the config for the frontend to consume.

### Phase 8: Frontend — Entry Point & Routing

1. Create `src/main.jsx`: render React app with `BrowserRouter`.
2. Create `src/App.jsx`: define routes for `/`, `/category/:categoryName`, `/similarity-groups`.
3. Create `src/index.css` with Tailwind imports.
4. Create `src/helpers/categories.js` with a `loadCategories()` function that fetches `/categories/index.json` at runtime — no hardcoded category list.

### Phase 9: Frontend — HomePage

1. Create `src/pages/HomePage.jsx`.
2. Fetch categories dynamically via `loadCategories()` on mount.
3. Render responsive grid of category buttons from the fetched list.
4. Each button links to `/category/{file_without_extension}`.
5. Add secondary link to `/similarity-groups`.

### Phase 10: Frontend — CategoryPage

1. Create `src/pages/CategoryPage.jsx`.
2. Fetch `/categories/{categoryName}.json` using route param.
3. Sort groups by member count (descending).
4. For each group, select best question: prefer non-empty answer, then longest text.
5. Render question text with `react-markdown` + `remark-gfm` + `remark-breaks`.
6. Custom table styling: responsive, zebra-striped.
7. Toggle-able answer reveal with DaisyUI success-colored box.
8. Display group size as badge.

### Phase 11: Frontend — SimilarityGroupsPage

1. Create `src/pages/SimilarityGroupsPage.jsx`.
2. Fetch `/categories/index.json` to discover all categories, then fetch all category JSONs in parallel.
3. Filter to questions with non-null, non-`__null_` similarity group IDs.
4. Group by `similarity_group_id`, filter to size ≥ 2, sort descending.
5. Expandable cards: click reveals all questions in group.
6. Show source folder, filename, markdown-rendered text, and answer.
7. Header with total group and question counts.

### Phase 12: Deployment

1. Create `Dockerfile`: Node 20 Alpine build stage → Nginx Alpine serve stage.
2. Create `nginx.conf`: SPA fallback, gzip, 1-year asset caching.
3. Create `docker-compose.yml`: single service on port 34729.
4. `npm run build` → `dist/` → Nginx serves from `/usr/share/nginx/html`.

### Phase 13: End-to-End Pipeline Run

```bash
# 0. (Optional) Edit categories before running the pipeline
#    vim config/categories.json

# 1. Extract questions from PDFs
uv run scripts/extract_questions.py ./pdfs/ -o ./data/extracted_questions/ -w 8 --dpi 150

# 2. Parse question images with Gemini
export GOOGLE_API_KEY="your-key"
uv run scripts/process_questions.py parse data/extracted_questions/

# 3. Categorize using categories from config/categories.json
uv run scripts/categorize_questions.py data/extracted_questions/ -o data/categorized_questions.json -w 20

# 4. Copy to public for similarity processing
cp data/categorized_questions.json public/categorized_questions.json

# 5. Detect similar/duplicate questions
uv run scripts/find_similar_questions.py \
  -i public/categorized_questions.json \
  -o public/categorized_questions_with_similarity.json \
  --cross-encoder-threshold 0.7 \
  --refine-threshold 10

# 6. Split into per-category files + generate index.json for frontend
uv run scripts/split_by_category.py

# 7. Build and deploy
npm run build
docker-compose up -d
```
