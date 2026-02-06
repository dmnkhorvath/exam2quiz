import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * BUG: The categorize worker (and the entire pipeline) uses a hardcoded
 * static `config/categories.json` file instead of reading the tenant's
 * categories from the database (`TenantCategory` table).
 *
 * This means:
 * 1. gemini-parse enqueues categorize with `categoriesConfigPath` pointing to
 *    `config/categories.json` (hardcoded filesystem path)
 * 2. categorize reads categories from that file, ignoring tenant DB categories
 * 3. similarity enqueues category-split with the same hardcoded path
 *
 * Tenants who customize their categories via the API (POST/PUT /api/categories)
 * will have their DB changes ignored by the pipeline.
 *
 * Expected behavior: Workers should load categories from TenantCategory DB
 * table for the given tenantId. If a tenant has no categories, categorization
 * should be skipped entirely.
 */
describe("categorize worker — tenant category bug", () => {
  it("should use tenant-specific categories from DB, not a static config file", () => {
    // The CategorizeJobData interface currently requires `categoriesConfigPath`
    // (a filesystem path), which proves categories come from a static file
    // rather than from the tenant's DB.
    //
    // Read the source to verify the worker reads from a file path
    // instead of querying TenantCategory from the database.
    const categorizeSource = readFileSync(
      path.join(__dirname, "categorize.ts"),
      "utf-8",
    );

    // BUG: The worker reads categories from a file on disk
    const readsFromFile = categorizeSource.includes(
      "readFile(categoriesConfigPath",
    );

    // EXPECTED: The worker should query the tenant's categories from DB
    const queriesTenantCategories = categorizeSource.includes(
      "tenantCategory.findMany",
    );

    // This test FAILS because the worker reads from a static file
    // and does NOT query tenant-specific categories from the database.
    expect(readsFromFile).toBe(false);
    expect(queriesTenantCategories).toBe(true);
  });

  it("should not hardcode config/categories.json path in gemini-parse", () => {
    const geminiParseSource = readFileSync(
      path.join(__dirname, "gemini-parse.ts"),
      "utf-8",
    );

    // BUG: gemini-parse hardcodes the path to config/categories.json
    const hardcodesConfigPath = geminiParseSource.includes(
      '"config"',
    ) && geminiParseSource.includes('"categories.json"');

    // This test FAILS because gemini-parse hardcodes the static file path
    expect(hardcodesConfigPath).toBe(false);
  });

  it("should not hardcode config/categories.json path in similarity", () => {
    const similaritySource = readFileSync(
      path.join(__dirname, "similarity.ts"),
      "utf-8",
    );

    // BUG: similarity worker hardcodes the path to config/categories.json
    // when enqueuing the category-split job (appears twice: early-exit + normal path)
    const hardcodesConfigPath = similaritySource.includes(
      '"config"',
    ) && similaritySource.includes('"categories.json"');

    // This test FAILS because similarity hardcodes the static file path
    expect(hardcodesConfigPath).toBe(false);
  });

  it("CategorizeJobData should not require categoriesConfigPath", () => {
    // The shared types define CategorizeJobData with a `categoriesConfigPath` field.
    // This field should not exist — categories should come from the DB.
    const typesSource = readFileSync(
      path.join(__dirname, "../../../shared/src/types/index.ts"),
      "utf-8",
    );

    // BUG: The interface includes a filesystem path for categories
    const hasCategoriesConfigPath = typesSource.includes(
      "categoriesConfigPath",
    );

    // This test FAILS because the interface still has categoriesConfigPath
    expect(hasCategoriesConfigPath).toBe(false);
  });
});
