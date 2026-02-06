import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  normalize,
  buildSimilarityMatrix,
  densityCluster,
  groupByCategory,
  trySplitWithHierarchical,
} from "./similarity.js";

describe("similarity helpers", () => {
  // ─── cosineSimilarity ──────────────────────────────────────────
  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    });

    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
    });

    it("returns -1 for opposite vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    });

    it("returns 0 for zero vectors", () => {
      expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it("handles empty vectors", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });
  });

  // ─── normalize ─────────────────────────────────────────────────
  describe("normalize", () => {
    it("normalizes a vector to unit length", () => {
      const result = normalize([3, 4]);
      const mag = Math.sqrt(result[0] ** 2 + result[1] ** 2);
      expect(mag).toBeCloseTo(1.0);
    });

    it("returns the same reference for zero vectors", () => {
      const zero = [0, 0, 0];
      expect(normalize(zero)).toBe(zero);
    });

    it("handles single-element vectors", () => {
      const result = normalize([5]);
      expect(result[0]).toBeCloseTo(1.0);
    });
  });

  // ─── buildSimilarityMatrix ─────────────────────────────────────
  describe("buildSimilarityMatrix", () => {
    it("returns empty matrix for empty input", () => {
      const result = buildSimilarityMatrix([]);
      expect(result).toEqual([]);
    });

    it("returns [[1]] for single embedding", () => {
      const result = buildSimilarityMatrix([[1, 0, 0]]);
      expect(result).toEqual([[1.0]]);
    });

    it("builds a symmetric matrix for 2 embeddings without crashing", () => {
      // BUG: buildSimilarityMatrix crashes with TypeError when n >= 2
      // because matrix[j] is undefined when j > i (uninitialized array slots)
      const embeddings = [
        [1, 0, 0],
        [0, 1, 0],
      ];
      const matrix = buildSimilarityMatrix(embeddings);
      expect(matrix).toHaveLength(2);
      expect(matrix[0]).toHaveLength(2);
      expect(matrix[1]).toHaveLength(2);
      expect(matrix[0][0]).toBeCloseTo(1.0);
      expect(matrix[1][1]).toBeCloseTo(1.0);
      expect(matrix[0][1]).toBeCloseTo(matrix[1][0]);
    });

    it("builds correct matrix for 3 embeddings", () => {
      const embeddings = [
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ];
      const matrix = buildSimilarityMatrix(embeddings);
      expect(matrix).toHaveLength(3);
      // Diagonal should be 1
      expect(matrix[0][0]).toBeCloseTo(1.0);
      expect(matrix[1][1]).toBeCloseTo(1.0);
      expect(matrix[2][2]).toBeCloseTo(1.0);
      // Symmetric
      expect(matrix[0][1]).toBeCloseTo(matrix[1][0]);
      expect(matrix[0][2]).toBeCloseTo(matrix[2][0]);
      expect(matrix[1][2]).toBeCloseTo(matrix[2][1]);
    });
  });

  // ─── densityCluster ────────────────────────────────────────────
  describe("densityCluster", () => {
    it("returns all -1 for fewer items than minClusterSize", () => {
      const result = densityCluster([[1, 0]], 2);
      expect(result).toEqual([-1]);
    });

    it("returns all -1 for empty input", () => {
      const result = densityCluster([], 2);
      expect(result).toEqual([]);
    });

    it("clusters identical embeddings together", () => {
      // BUG: When all embeddings are identical, medianDist=0, cutoff=0.
      // Floating point imprecision may cause merge.dist > 0 so no merges happen.
      const embeddings = [
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ];
      const labels = densityCluster(embeddings, 2);
      // All identical items should be in the same cluster
      const nonNoise = labels.filter((l) => l >= 0);
      expect(nonNoise.length).toBe(3);
      expect(new Set(nonNoise).size).toBe(1);
    });

    it("clusters very similar embeddings together", () => {
      // Near-identical embeddings with tiny perturbation
      const embeddings = [
        [1, 0.001, 0],
        [1, 0.002, 0],
        [1, 0.003, 0],
      ];
      const labels = densityCluster(embeddings, 2);
      const nonNoise = labels.filter((l) => l >= 0);
      expect(nonNoise.length).toBe(3);
      expect(new Set(nonNoise).size).toBe(1);
    });

    it("separates clearly distinct clusters", () => {
      const embeddings = [
        [1, 0, 0],
        [0.99, 0.01, 0],
        [0, 1, 0],
        [0.01, 0.99, 0],
      ];
      const labels = densityCluster(embeddings, 2);
      // Should form 2 clusters
      expect(labels[0]).toBe(labels[1]);
      expect(labels[2]).toBe(labels[3]);
      if (labels[0] >= 0 && labels[2] >= 0) {
        expect(labels[0]).not.toBe(labels[2]);
      }
    });
  });

  // ─── groupByCategory ──────────────────────────────────────────
  describe("groupByCategory", () => {
    it("groups questions by category", () => {
      const questions = [
        {
          file: "q1.png",
          success: true,
          categorization: { success: true, category: "anatomy" },
        },
        {
          file: "q2.png",
          success: true,
          categorization: { success: true, category: "anatomy" },
        },
        {
          file: "q3.png",
          success: true,
          categorization: { success: true, category: "physiology" },
        },
      ];
      const groups = groupByCategory(questions);
      expect(groups.size).toBe(2);
      expect(groups.get("anatomy")).toHaveLength(2);
      expect(groups.get("physiology")).toHaveLength(1);
    });

    it("skips questions with failed categorization", () => {
      const questions = [
        {
          file: "q1.png",
          success: true,
          categorization: { success: false, error: "failed" },
        },
        {
          file: "q2.png",
          success: true,
          categorization: { success: true, category: "anatomy" },
        },
      ];
      const groups = groupByCategory(questions);
      expect(groups.size).toBe(1);
    });

    it("returns empty map for empty input", () => {
      const groups = groupByCategory([]);
      expect(groups.size).toBe(0);
    });
  });

  // ─── trySplitWithHierarchical ──────────────────────────────────
  describe("trySplitWithHierarchical", () => {
    it("returns null for fewer than 4 items", () => {
      const simMatrix = [
        [1, 0.9, 0.1],
        [0.9, 1, 0.1],
        [0.1, 0.1, 1],
      ];
      expect(trySplitWithHierarchical(simMatrix, 0.7)).toBeNull();
    });

    it("splits clearly distinct groups", () => {
      // 2 pairs: (0,1) very similar, (2,3) very similar, pairs dissimilar
      const simMatrix = [
        [1.0, 0.95, 0.1, 0.1],
        [0.95, 1.0, 0.1, 0.1],
        [0.1, 0.1, 1.0, 0.95],
        [0.1, 0.1, 0.95, 1.0],
      ];
      const result = trySplitWithHierarchical(simMatrix, 0.7);
      expect(result).not.toBeNull();
      expect(result!.size).toBe(2);
    });

    it("returns null when all items are similar (single cluster)", () => {
      const simMatrix = [
        [1.0, 0.9, 0.85, 0.88],
        [0.9, 1.0, 0.87, 0.9],
        [0.85, 0.87, 1.0, 0.92],
        [0.88, 0.9, 0.92, 1.0],
      ];
      const result = trySplitWithHierarchical(simMatrix, 0.7);
      // All items are above threshold — should merge into 1 cluster → return null
      expect(result).toBeNull();
    });
  });
});
