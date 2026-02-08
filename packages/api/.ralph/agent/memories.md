# Memories

## Patterns

### mem-1770553544-6dcd
> Added POST /api/pipelines/:id/similarity-url endpoint to submit external similarity result. Downloads JSON from URL, validates format, writes to similarity.json, enqueues category-split stage, and resumes pipeline from PAUSED/MANUAL_SIMILARITY_UPLOAD to RUNNING/CATEGORY_SPLIT.
<!-- tags: api, pipeline, similarity | created: 2026-02-08 -->

### mem-1770553423-4f36
> Added GET /api/pipelines/:id/categorized endpoint to download categorized_merged.json for manual similarity processing. Endpoint checks pipeline is at MANUAL_SIMILARITY_UPLOAD stage, validates tenant access, and serves file with Content-Disposition header for download.
<!-- tags: api, pipeline, download | created: 2026-02-08 -->

## Decisions

## Fixes

## Context
