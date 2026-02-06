import { describe, it, expect } from "vitest";
import { transliterate, sanitizeFilename, groupBySimilarity } from "./category-split.js";

describe("category-split helpers", () => {
  describe("transliterate", () => {
    it("converts Hungarian characters to English", () => {
      expect(transliterate("áéíóöőúüű")).toBe("aeiooouuu");
      expect(transliterate("ÁÉÍÓÖŐÚÜŰ")).toBe("AEIOOOUUU");
    });

    it("leaves non-Hungarian characters unchanged", () => {
      expect(transliterate("hello world")).toBe("hello world");
      expect(transliterate("abc123")).toBe("abc123");
    });

    it("handles mixed content", () => {
      expect(transliterate("Általános anatómia")).toBe("Altalanos anatomia");
    });
  });

  describe("sanitizeFilename", () => {
    it("converts to lowercase with underscores", () => {
      expect(sanitizeFilename("Hello World")).toBe("hello_world");
    });

    it("transliterates Hungarian characters", () => {
      expect(sanitizeFilename("Általános anatómia és kortan")).toBe(
        "altalanos_anatomia_es_kortan",
      );
    });

    it("removes special characters", () => {
      expect(sanitizeFilename("Test (123) / value")).toBe("test_123_value");
    });

    it("handles multiple spaces", () => {
      expect(sanitizeFilename("a   b")).toBe("a_b");
    });
  });

  describe("groupBySimilarity", () => {
    it("groups items by similarity_group_id", () => {
      const items = [
        { id: 1, similarity_group_id: "g1" },
        { id: 2, similarity_group_id: "g1" },
        { id: 3, similarity_group_id: "g2" },
      ];

      const groups = groupBySimilarity(items);
      expect(groups).toHaveLength(2);
      expect(groups[0]).toHaveLength(2);
      expect(groups[1]).toHaveLength(1);
    });

    it("puts null similarity_group_id items in individual groups", () => {
      const items = [
        { id: 1, similarity_group_id: null },
        { id: 2, similarity_group_id: null },
        { id: 3, similarity_group_id: "g1" },
      ];

      const groups = groupBySimilarity(items);
      expect(groups).toHaveLength(3);
      // Two individual groups for nulls + one group for g1
      expect(groups[0]).toHaveLength(1);
      expect(groups[1]).toHaveLength(1);
      expect(groups[2]).toHaveLength(1);
    });

    it("handles undefined similarity_group_id as null", () => {
      const items = [
        { id: 1 } as { id: number; similarity_group_id?: string | null },
        { id: 2, similarity_group_id: "g1" },
      ];

      const groups = groupBySimilarity(items);
      expect(groups).toHaveLength(2);
    });

    it("returns empty array for empty input", () => {
      const groups = groupBySimilarity([]);
      expect(groups).toHaveLength(0);
    });
  });
});
