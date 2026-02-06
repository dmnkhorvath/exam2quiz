#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sentence-transformers>=3.0.0",
#     "scikit-learn>=1.5.0",
#     "hdbscan>=0.8.0",
#     "scipy>=1.14.0",
#     "tqdm>=4.66.0",
#     "numpy>=1.26.0",
# ]
# ///
"""
Find and mark similar questions using a two-stage approach with automatic refinement.

Stage 1: Initial clustering
  - Bi-encoder (E5-large) for semantic embeddings
  - HDBSCAN for density-based clustering
  - Cross-encoder for verification

Stage 2: Refinement (automatic)
  - Re-process large groups with stricter parameters
  - Split groups that can be subdivided

Usage:
    uv run find_similar_questions.py
    uv run find_similar_questions.py -i input.json -o output.json
    uv run find_similar_questions.py --cross-encoder-threshold 0.8 --refine-threshold 10
"""

import json
import argparse
from collections import defaultdict
from typing import Optional

import numpy as np
from sentence_transformers import SentenceTransformer, CrossEncoder
import hdbscan
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import squareform
from tqdm import tqdm


# =============================================================================
# Utility Functions
# =============================================================================

def load_questions(filepath: str) -> list[dict]:
    """Load questions from JSON file."""
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


def save_questions(questions: list[dict], filepath: str) -> None:
    """Save questions to JSON file."""
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(questions, f, ensure_ascii=False, indent=2)


def get_question_text(question: dict) -> str:
    """Extract question text from a question dict."""
    return question.get("data", {}).get("question_text", "")


def prepare_e5_text(text: str) -> str:
    """Prepare text for E5 model (requires 'query: ' prefix)."""
    return f"query: {text}"


def group_by_category(questions: list[dict]) -> dict[str, list[tuple[int, dict]]]:
    """Group questions by their category, keeping track of original indices."""
    groups = defaultdict(list)
    for idx, q in enumerate(questions):
        cat = q.get("categorization", {})
        if cat.get("success") and cat.get("category"):
            groups[cat["category"]].append((idx, q))
    return groups


def find_large_groups(questions: list[dict], min_size: int) -> dict[str, list[int]]:
    """Find groups with more than min_size members."""
    groups = defaultdict(list)
    for idx, q in enumerate(questions):
        group_id = q.get("similarity_group_id")
        if group_id:
            groups[group_id].append(idx)
    return {gid: indices for gid, indices in groups.items() if len(indices) > min_size}


def print_stats(questions: list[dict], title: str = "Statistics") -> None:
    """Print statistics about similarity groups."""
    groups = defaultdict(list)
    for idx, q in enumerate(questions):
        gid = q.get("similarity_group_id")
        if gid:
            groups[gid].append(idx)

    if not groups:
        print(f"\n{title}: No groups found")
        return

    group_sizes = [len(v) for v in groups.values()]
    print(f"\n{'=' * 60}")
    print(title)
    print('=' * 60)
    print(f"Total questions: {len(questions)}")
    print(f"Questions with similarity group: {sum(group_sizes)}")
    print(f"Questions without group: {len(questions) - sum(group_sizes)}")
    print(f"Total unique groups: {len(groups)}")
    print(f"Largest group: {max(group_sizes)}")
    print(f"Smallest group: {min(group_sizes)}")
    print(f"Average group size: {sum(group_sizes) / len(groups):.2f}")


# =============================================================================
# Stage 1: Initial Similarity Detection
# =============================================================================

def find_similarity_groups(
    questions_with_indices: list[tuple[int, dict]],
    bi_encoder: SentenceTransformer,
    cross_encoder: CrossEncoder | None,
    min_cluster_size: int = 2,
    cross_encoder_threshold: float = 0.7,
    use_cross_encoder: bool = True,
) -> dict[int, str]:
    """Find similarity groups using HDBSCAN + cross-encoder verification."""
    if not questions_with_indices:
        return {}

    indices = [idx for idx, _ in questions_with_indices]
    texts = [get_question_text(q) for _, q in questions_with_indices]

    # Filter empty texts
    valid_data = [(i, idx, text) for i, (idx, text) in enumerate(zip(indices, texts)) if text.strip()]
    if len(valid_data) < 2:
        return {}

    original_indices = [d[1] for d in valid_data]
    valid_texts = [d[2] for d in valid_data]
    prepared_texts = [prepare_e5_text(t) for t in valid_texts]

    # Compute embeddings
    embeddings = bi_encoder.encode(
        prepared_texts,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True
    )

    # HDBSCAN clustering
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=1,
        metric='euclidean',
        cluster_selection_epsilon=0.0,
        cluster_selection_method='eom',
    )
    cluster_labels = clusterer.fit_predict(embeddings)

    # Group by cluster
    clusters = defaultdict(list)
    for i, label in enumerate(cluster_labels):
        if label >= 0:
            clusters[label].append(i)

    verified_clusters = {}

    if use_cross_encoder and cross_encoder is not None:
        cluster_id = 0
        for label, members in clusters.items():
            if len(members) < 2:
                continue

            member_texts = [valid_texts[i] for i in members]
            pairs = []
            pair_indices = []

            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    pairs.append([member_texts[i], member_texts[j]])
                    pair_indices.append((i, j))

            if not pairs:
                continue

            scores = cross_encoder.predict(pairs, show_progress_bar=False)

            # Build adjacency graph
            adjacency = defaultdict(set)
            for (i, j), score in zip(pair_indices, scores):
                if score >= cross_encoder_threshold:
                    adjacency[i].add(j)
                    adjacency[j].add(i)

            # Find connected components (BFS)
            visited = set()
            for start in range(len(members)):
                if start in visited or not adjacency[start]:
                    continue

                component = []
                queue = [start]
                while queue:
                    node = queue.pop(0)
                    if node in visited:
                        continue
                    visited.add(node)
                    component.append(members[node])
                    queue.extend(n for n in adjacency[node] if n not in visited)

                if len(component) >= 2:
                    cluster_id += 1
                    for local_idx in component:
                        verified_clusters[original_indices[local_idx]] = f"sim_group_{cluster_id}"
    else:
        cluster_id = 0
        for label, members in clusters.items():
            if len(members) >= 2:
                cluster_id += 1
                for local_idx in members:
                    verified_clusters[original_indices[local_idx]] = f"sim_group_{cluster_id}"

    return verified_clusters


def run_stage1(
    questions: list[dict],
    bi_encoder: SentenceTransformer,
    cross_encoder: CrossEncoder | None,
    min_cluster_size: int,
    cross_encoder_threshold: float,
    use_cross_encoder: bool,
) -> None:
    """Run Stage 1: Initial similarity detection."""
    print("\n" + "=" * 60)
    print("STAGE 1: Initial Similarity Detection")
    print("=" * 60)

    category_groups = group_by_category(questions)
    print(f"Found {len(category_groups)} categories")

    all_assignments = {}
    total_groups = 0

    for category, questions_with_indices in tqdm(category_groups.items(), desc="Processing categories"):
        similarity_map = find_similarity_groups(
            questions_with_indices,
            bi_encoder,
            cross_encoder,
            min_cluster_size=min_cluster_size,
            cross_encoder_threshold=cross_encoder_threshold,
            use_cross_encoder=use_cross_encoder,
        )

        category_prefix = category.replace(" ", "_")[:20]
        for orig_idx, group_id in similarity_map.items():
            all_assignments[orig_idx] = f"{category_prefix}_{group_id}"

        total_groups += len(set(similarity_map.values()))

    # Apply assignments
    for idx, question in enumerate(questions):
        question["similarity_group_id"] = all_assignments.get(idx)

    print(f"\nStage 1 complete: {total_groups} groups, {len(all_assignments)} questions assigned")


# =============================================================================
# Stage 2: Refinement of Large Groups
# =============================================================================

def try_split_group(
    questions: list[dict],
    indices: list[int],
    bi_encoder: SentenceTransformer,
    cross_encoder: CrossEncoder,
    cross_encoder_threshold: float = 0.85,
) -> Optional[dict[int, int]]:
    """Try to split a group into smaller sub-groups."""
    if len(indices) < 4:
        return None

    texts = [get_question_text(questions[i]) for i in indices]
    prepared_texts = [prepare_e5_text(t) for t in texts]

    embeddings = bi_encoder.encode(
        prepared_texts,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True
    )

    # Try HDBSCAN with leaf selection (more fine-grained)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=2,
        min_samples=2,
        metric='euclidean',
        cluster_selection_epsilon=0.0,
        cluster_selection_method='leaf',
    )
    cluster_labels = clusterer.fit_predict(embeddings)

    unique_labels = set(cluster_labels) - {-1}

    if len(unique_labels) <= 1:
        # Try cross-encoder based splitting
        return try_split_with_cross_encoder(questions, indices, texts, cross_encoder, cross_encoder_threshold)

    # Verify with cross-encoder
    clusters = defaultdict(list)
    for local_idx, label in enumerate(cluster_labels):
        if label >= 0:
            clusters[label].append(local_idx)

    verified_assignments = {}
    sub_group_counter = 0

    for label, members in clusters.items():
        if len(members) < 2:
            continue

        member_texts = [texts[i] for i in members]
        pairs = []
        pair_indices = []

        for i in range(len(members)):
            for j in range(i + 1, min(len(members), i + 51)):  # Limit pairs
                pairs.append([member_texts[i], member_texts[j]])
                pair_indices.append((i, j))

        if not pairs:
            continue

        scores = cross_encoder.predict(pairs, show_progress_bar=False)

        adjacency = defaultdict(set)
        for (i, j), score in zip(pair_indices, scores):
            if score >= cross_encoder_threshold:
                adjacency[i].add(j)
                adjacency[j].add(i)

        visited = set()
        for start in range(len(members)):
            if start in visited:
                continue

            component = []
            queue = [start]
            while queue:
                node = queue.pop(0)
                if node in visited:
                    continue
                visited.add(node)
                component.append(members[node])
                queue.extend(n for n in adjacency[node] if n not in visited)

            if len(component) >= 2:
                sub_group_counter += 1
                for local_idx in component:
                    verified_assignments[indices[local_idx]] = sub_group_counter

    return verified_assignments if len(set(verified_assignments.values())) > 1 else None


def try_split_with_cross_encoder(
    questions: list[dict],
    indices: list[int],
    texts: list[str],
    cross_encoder: CrossEncoder,
    threshold: float,
) -> Optional[dict[int, int]]:
    """Try to split using hierarchical clustering on cross-encoder similarities."""
    n = len(indices)
    if n < 4:
        return None

    pairs = [[texts[i], texts[j]] for i in range(n) for j in range(i + 1, n)]
    pair_indices = [(i, j) for i in range(n) for j in range(i + 1, n)]

    scores = cross_encoder.predict(pairs, show_progress_bar=False)

    sim_matrix = np.zeros((n, n))
    for (i, j), score in zip(pair_indices, scores):
        sim_matrix[i, j] = score
        sim_matrix[j, i] = score
    np.fill_diagonal(sim_matrix, 1.0)

    dist_matrix = np.clip(1 - sim_matrix, 0, 1)
    condensed_dist = squareform(dist_matrix)
    Z = linkage(condensed_dist, method='average')
    cluster_labels = fcluster(Z, t=1 - threshold, criterion='distance')

    if len(set(cluster_labels)) <= 1:
        return None

    assignments = {indices[i]: int(label) for i, label in enumerate(cluster_labels)}

    group_counts = defaultdict(int)
    for label in assignments.values():
        group_counts[label] += 1

    valid_groups = {l for l, c in group_counts.items() if c >= 2}
    if len(valid_groups) <= 1:
        return None

    filtered = {idx: label for idx, label in assignments.items() if label in valid_groups}
    return filtered if len(set(filtered.values())) > 1 else None


def run_stage2(
    questions: list[dict],
    bi_encoder: SentenceTransformer,
    cross_encoder: CrossEncoder,
    refine_threshold: int,
    refine_cross_encoder_threshold: float,
) -> None:
    """Run Stage 2: Refinement of large groups."""
    large_groups = find_large_groups(questions, refine_threshold)

    if not large_groups:
        print(f"\nNo groups larger than {refine_threshold} items. Skipping refinement.")
        return

    print("\n" + "=" * 60)
    print("STAGE 2: Refining Large Groups")
    print("=" * 60)
    print(f"Found {len(large_groups)} groups to refine (>{refine_threshold} items)")

    groups_split = 0
    groups_kept = 0

    for group_id, indices in tqdm(large_groups.items(), desc="Refining groups"):
        split_result = try_split_group(
            questions, indices, bi_encoder, cross_encoder,
            cross_encoder_threshold=refine_cross_encoder_threshold,
        )

        if split_result and len(set(split_result.values())) > 1:
            groups_split += 1
            for idx, sub_group_num in split_result.items():
                questions[idx]["similarity_group_id"] = f"{group_id}_sub{sub_group_num}"
            for idx in indices:
                if idx not in split_result:
                    questions[idx]["similarity_group_id"] = None
        else:
            groups_kept += 1

    print(f"\nRefinement complete: {groups_split} split, {groups_kept} kept as-is")


# =============================================================================
# Main Entry Point
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Find similar questions with automatic refinement",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  uv run scripts/find_similar_questions.py
  uv run scripts/find_similar_questions.py -i input.json -o output.json
  uv run scripts/find_similar_questions.py --cross-encoder-threshold 0.8
  uv run scripts/find_similar_questions.py --no-refine
  uv run scripts/find_similar_questions.py --refine-threshold 5
        """
    )
    # Default paths relative to project root (run from project root)
    parser.add_argument("-i", "--input", default="public/categorized_questions.json",
                        help="Input JSON file (default: public/categorized_questions.json)")
    parser.add_argument("-o", "--output", default="public/categorized_questions_with_similarity.json",
                        help="Output JSON file (default: public/categorized_questions_with_similarity.json)")
    parser.add_argument("--bi-encoder-model", default="intfloat/multilingual-e5-large",
                        help="Bi-encoder model (default: intfloat/multilingual-e5-large)")
    parser.add_argument("--cross-encoder-model", default="cross-encoder/ms-marco-MiniLM-L-12-v2",
                        help="Cross-encoder model (default: cross-encoder/ms-marco-MiniLM-L-12-v2)")
    parser.add_argument("--cross-encoder-threshold", type=float, default=0.7,
                        help="Stage 1 cross-encoder threshold (default: 0.7)")
    parser.add_argument("--min-cluster-size", type=int, default=2,
                        help="Minimum cluster size (default: 2)")
    parser.add_argument("--no-cross-encoder", action="store_true",
                        help="Skip cross-encoder verification (faster but less accurate)")
    parser.add_argument("--no-refine", action="store_true",
                        help="Skip Stage 2 refinement")
    parser.add_argument("--refine-threshold", type=int, default=10,
                        help="Refine groups larger than this (default: 10)")
    parser.add_argument("--refine-cross-encoder-threshold", type=float, default=0.85,
                        help="Stage 2 cross-encoder threshold (default: 0.85)")

    args = parser.parse_args()

    print(f"Loading questions from {args.input}...")
    questions = load_questions(args.input)
    print(f"Loaded {len(questions)} questions")

    print(f"\nLoading bi-encoder: {args.bi_encoder_model}...")
    bi_encoder = SentenceTransformer(args.bi_encoder_model)

    cross_encoder = None
    if not args.no_cross_encoder:
        print(f"Loading cross-encoder: {args.cross_encoder_model}...")
        cross_encoder = CrossEncoder(args.cross_encoder_model)

    # Stage 1: Initial similarity detection
    run_stage1(
        questions,
        bi_encoder,
        cross_encoder,
        min_cluster_size=args.min_cluster_size,
        cross_encoder_threshold=args.cross_encoder_threshold,
        use_cross_encoder=not args.no_cross_encoder,
    )

    print_stats(questions, "After Stage 1")

    # Stage 2: Refinement (optional)
    if not args.no_refine and cross_encoder is not None:
        run_stage2(
            questions,
            bi_encoder,
            cross_encoder,
            refine_threshold=args.refine_threshold,
            refine_cross_encoder_threshold=args.refine_cross_encoder_threshold,
        )
        print_stats(questions, "After Stage 2 (Final)")

    # Save output
    print(f"\nSaving to {args.output}...")
    save_questions(questions, args.output)
    print("Done!")


if __name__ == "__main__":
    main()
