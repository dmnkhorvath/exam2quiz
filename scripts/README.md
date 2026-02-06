# Question Processing Scripts

Python scripts for extracting, parsing, categorizing, and analyzing Hungarian medical exam questions.

## Prerequisites

- [uv](https://github.com/astral-sh/uv) - Fast Python package manager
- Google API key for Gemini (for parsing and categorization)

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Set API key
export GOOGLE_API_KEY="your-api-key"
```

Get your API key at: https://aistudio.google.com/apikey

## Scripts Overview

| Script | Purpose |
|--------|---------|
| `extract_questions.py` | Extract question images from PDF files |
| `process_questions.py` | Parse images & retry failed operations (Gemini) |
| `categorize_questions.py` | Categorize questions into medical topics |
| `find_similar_questions.py` | Find and group similar questions |
| `split_by_category.py` | Split questions into separate JSON files by category |

## Workflow

```
PDF Files → extract → Images → parse → JSON → categorize → find similarities → split by category
```

---

## 1. Extract Questions from PDFs

Extract question images from scanned PDF exam files.

```bash
uv run scripts/extract_questions.py <input_folder> <output_folder>
```

**Example:**
```bash
uv run scripts/extract_questions.py data/scrape/ data/extracted_questions/
```

---

## 2. Parse Question Images

Parse extracted images using Google Gemini Vision to extract structured question data.

```bash
uv run scripts/process_questions.py parse <folder_with_images>
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-m, --model` | `gemini-2.0-flash` | Gemini model to use |
| `-fw, --folder-workers` | `5` | Parallel folder workers |
| `-iw, --image-workers` | `10` | Parallel image workers per folder |
| `-l, --log` | `gemini_parser.log` | Log file path |

**Examples:**
```bash
# Basic usage
uv run scripts/process_questions.py parse data/extracted_questions/

# With custom parallelism
uv run scripts/process_questions.py parse data/extracted_questions/ -fw 5 -iw 15

# With different model
uv run scripts/process_questions.py parse data/extracted_questions/ -m gemini-1.5-flash
```

**Output:** Creates `parsed.json` in each subfolder.

---

## 3. Retry Failed Operations

### Retry Failed Image Parsing

Re-process images that failed during initial parsing.

```bash
uv run scripts/process_questions.py retry-parse
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-f, --failed-file` | `failed_images.json` | File listing failed images |
| `-d, --data-dir` | `data/extracted_questions` | Base directory for images |
| `-m, --model` | `gemini-2.0-flash` | Gemini model |

**Example:**
```bash
uv run scripts/process_questions.py retry-parse -f failed_images.json
```

### Retry Failed Categorizations

Re-categorize questions that failed during initial categorization.

```bash
uv run scripts/process_questions.py retry-categorize
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-i, --input` | `data/categorized_questions.json` | Input file |
| `-m, --model` | `gemini-2.0-flash` | Gemini model |
| `-w, --workers` | `10` | Parallel workers |

**Example:**
```bash
uv run scripts/process_questions.py retry-categorize -i data/categorized_questions.json
```

---

## 4. Categorize Questions

Categorize parsed questions into medical topic categories.

```bash
uv run scripts/categorize_questions.py
```

**Categories:**
- Általános anatómia és kortan
- A mozgás szerv rendszere
- Keringés
- Légzőrendszer
- Idegrendszer
- Kiválasztás szervrendszere
- Szaporodás szervrendszere
- A neuroendokrin rendszer
- Az érzékszervek és emlő
- Elsősegélynyújtás
- Emésztés

**Output:** `categorized_questions.json`

---

## 5. Find Similar Questions

Detect and group similar questions using semantic embeddings.

```bash
uv run scripts/find_similar_questions.py
```

**Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `-i, --input` | `public/categorized_questions.json` | Input file |
| `-o, --output` | `public/categorized_questions_with_similarity.json` | Output file |
| `--cross-encoder-threshold` | `0.7` | Similarity threshold (Stage 1) |
| `--refine-threshold` | `10` | Refine groups larger than this |
| `--no-cross-encoder` | - | Skip cross-encoder (faster) |
| `--no-refine` | - | Skip refinement stage |

**Examples:**
```bash
# Default (recommended)
uv run scripts/find_similar_questions.py

# Stricter grouping
uv run scripts/find_similar_questions.py --cross-encoder-threshold 0.85

# Fast mode
uv run scripts/find_similar_questions.py --no-cross-encoder --no-refine
```

**Output:** Adds `similarity_group_id` field to each question.

See [SIMILARITY_GUIDE.md](SIMILARITY_GUIDE.md) for detailed documentation.

---

## 6. Split by Category

Split the main questions file into separate JSON files for each category, with questions grouped by similarity.

```bash
./scripts/split_by_category.py
```

**Input:** `public/categorized_questions_with_similarity.json`

**Output:** Creates `public/categories/` folder with one JSON file per category:

| Category | Output File |
|----------|-------------|
| Keringés | `keringes.json` |
| A mozgás szerv rendszere | `a_mozgas_szerv_rendszere.json` |
| Általános anatómia és kortan | `altalanos_anatomia_es_kortan.json` |
| A neuroendokrin rendszer | `a_neuroendokrin_rendszer.json` |
| Idegrendszer | `idegrendszer.json` |
| Szaporodás szervrendszere | `szaporodas_szervrendszere.json` |
| Kiválasztás szervrendszere | `kivalasztas_szervrendszere.json` |
| Emésztés | `emesztes.json` |
| Légzőrendszer | `legzorendszer.json` |
| Az érzékszervek és emlő | `az_erzekszervek_es_emlo.json` |
| Elsősegélynyújtás | `elsosegelynyujtas.json` |

**Output Format:**
```json
{
  "category_name": "Keringés",
  "groups": [
    [{ ... }, { ... }],  // similar questions grouped together
    [{ ... }],           // unique question (null similarity_group_id)
    [{ ... }, { ... }, { ... }]  // another group of similar questions
  ]
}
```

**Grouping Logic:**
- Questions with the same `similarity_group_id` are grouped together
- Questions with `null` similarity_group_id are placed in their own individual group

---

## Complete Pipeline Example

```bash
# 1. Set API key
export GOOGLE_API_KEY="your-api-key"

# 2. Extract images from PDFs
uv run scripts/extract_questions.py data/scrape/ data/extracted_questions/

# 3. Parse images with Gemini
uv run scripts/process_questions.py parse data/extracted_questions/

# 4. Retry any failures
uv run scripts/process_questions.py retry-parse

# 5. Categorize questions
uv run scripts/categorize_questions.py

# 6. Retry failed categorizations
uv run scripts/process_questions.py retry-categorize

# 7. Find similar questions
uv run scripts/find_similar_questions.py

# 8. Split into category files for web app
./scripts/split_by_category.py
```

---

## Output Files

| File | Location | Description |
|------|----------|-------------|
| `parsed.json` | Each extracted folder | Parsed question data per exam |
| `categorized_questions.json` | `data/` | All questions with categories |
| `categorized_questions.json` | `public/` | Copy for web app |
| `categorized_questions_with_similarity.json` | `public/` | With similarity groups |
| `unique_questions.json` | `public/` | Questions without duplicates |
| `*.json` | `public/categories/` | Questions split by category |

---

## Troubleshooting

### Rate Limiting (429 errors)
Reduce parallel workers:
```bash
uv run scripts/process_questions.py parse data/extracted_questions/ -fw 2 -iw 5
```

### API Key Issues
Ensure the key is set:
```bash
echo $GOOGLE_API_KEY
```

### Check Failed Items
```bash
# Count failed categorizations
jq '[.[] | select(.categorization.success == false)] | length' data/categorized_questions.json

# Count failed parsing in a folder
jq '[.[] | select(.success == false)] | length' data/extracted_questions/EMIII_0213/parsed.json
```
