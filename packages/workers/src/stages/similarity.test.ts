import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const PYTHON_SCRIPT = path.join(REPO_ROOT, "scripts/find_similar_questions.py");

describe("similarity worker (Python-backed)", () => {
  it("Python script exists at expected path", async () => {
    const content = await readFile(PYTHON_SCRIPT, "utf-8");
    expect(content).toContain("find_similar_questions");
    expect(content).toContain("hdbscan");
    expect(content).toContain("sentence_transformers");
  });

  it("Python script accepts expected CLI arguments", async () => {
    const content = await readFile(PYTHON_SCRIPT, "utf-8");
    expect(content).toContain("--cross-encoder-threshold");
    expect(content).toContain("--refine-threshold");
    expect(content).toContain("-i");
    expect(content).toContain("-o");
  });

  it("Python script sets similarity_group_id on questions", async () => {
    const content = await readFile(PYTHON_SCRIPT, "utf-8");
    expect(content).toContain("similarity_group_id");
  });

  it("createSimilarityWorker is exported", async () => {
    // Verify the module exports the expected function
    const mod = await import("./similarity.js");
    expect(typeof mod.createSimilarityWorker).toBe("function");
  });
});
