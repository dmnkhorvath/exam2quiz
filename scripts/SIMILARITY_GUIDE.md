# Question Similarity Detection Guide

Find and group similar questions using semantic embeddings with automatic refinement.

## Quick Start

```bash
# Run from project root
uv run scripts/find_similar_questions.py
```

That's it. The script handles dependencies automatically via UV.

## How It Works

**Stage 1: Initial Clustering**
- Uses `intfloat/multilingual-e5-large` bi-encoder for semantic embeddings
- HDBSCAN for density-based clustering (finds natural groups)
- Cross-encoder verification for precise similarity scoring

**Stage 2: Automatic Refinement**
- Re-processes groups larger than threshold (default: 10)
- Attempts to split into smaller, more precise sub-groups
- Uses stricter cross-encoder threshold (0.85 vs 0.7)

## Usage

```bash
# Default settings (recommended)
uv run scripts/find_similar_questions.py

# Custom input/output
uv run scripts/find_similar_questions.py -i input.json -o output.json

# Skip refinement stage (faster)
uv run scripts/find_similar_questions.py --no-refine

# Stricter grouping (fewer, more precise groups)
uv run scripts/find_similar_questions.py --cross-encoder-threshold 0.8

# Fast mode (skip cross-encoder, less accurate)
uv run scripts/find_similar_questions.py --no-cross-encoder

# Refine smaller groups
uv run scripts/find_similar_questions.py --refine-threshold 5
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `-i, --input` | `public/categorized_questions.json` | Input JSON file |
| `-o, --output` | `public/categorized_questions_with_similarity.json` | Output JSON file |
| `--bi-encoder-model` | `intfloat/multilingual-e5-large` | Model for embeddings |
| `--cross-encoder-model` | `cross-encoder/ms-marco-MiniLM-L-12-v2` | Model for verification |
| `--cross-encoder-threshold` | `0.7` | Stage 1 similarity threshold |
| `--min-cluster-size` | `2` | Minimum questions per group |
| `--no-cross-encoder` | `false` | Skip cross-encoder (faster) |
| `--no-refine` | `false` | Skip Stage 2 refinement |
| `--refine-threshold` | `10` | Refine groups larger than this |
| `--refine-cross-encoder-threshold` | `0.85` | Stage 2 threshold |

## Output Format

Each question gets a `similarity_group_id` field:

```json
{
  "file": "EMIII_0213_q001_4pt.png",
  "data": {
    "question_text": "..."
  },
  "categorization": {
    "category": "Keringés"
  },
  "similarity_group_id": "Keringés_sim_group_18"
}
```

- Format: `{category_prefix}_sim_group_{number}`
- Value is `null` if no similar questions found

## Querying Results

### With jq

```bash
# List all groups by size (descending)
jq '[.[] | select(.similarity_group_id) | .similarity_group_id] \
  | group_by(.) | map({group: .[0], count: length}) \
  | sort_by(-.count)' public/categorized_questions_with_similarity.json

# Get questions in a specific group
jq '[.[] | select(.similarity_group_id == "Keringés_sim_group_18")]' \
  public/categorized_questions_with_similarity.json

# Statistics
jq '[.[] | select(.similarity_group_id) | .similarity_group_id] | unique | length' public/categorized_questions_with_similarity.json
jq '[.[] | select(.similarity_group_id) | .similarity_group_id] | group_by(.) | map(length) | max' public/categorized_questions_with_similarity.json
jq '[.[] | select(.similarity_group_id) | .similarity_group_id] | group_by(.) | map(length) | add/length' public/categorized_questions_with_similarity.json
```

### With JavaScript

```javascript
const data = require('./public/categorized_questions_with_similarity.json');

// Get all questions in a group
const getSimilarQuestions = (groupId) =>
  data.filter(q => q.similarity_group_id === groupId);

// Get unique questions only
const uniqueQuestions = data.filter(q => !q.similarity_group_id);

// One representative per group
const grouped = Object.groupBy(data.filter(q => q.similarity_group_id), q => q.similarity_group_id);
const representatives = Object.values(grouped).map(g => g[0]);
```

## Performance

- ~5 minutes for 8,600 questions (with cross-encoder + refinement)
- ~2 minutes with `--no-cross-encoder`
- Models cached after first download (~1.5GB)

## Tuning

| Goal | Adjustment |
|------|------------|
| Fewer, larger groups | `--cross-encoder-threshold 0.6` |
| More, smaller groups | `--cross-encoder-threshold 0.85` |
| Faster processing | `--no-cross-encoder` or `--no-refine` |
| Split smaller groups | `--refine-threshold 5` |
