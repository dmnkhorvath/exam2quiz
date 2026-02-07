import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("CI configuration", () => {
  it("package.json must specify packageManager for pnpm/action-setup@v4", () => {
    const rootPkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../package.json"), "utf-8"),
    );
    expect(rootPkg.packageManager).toBeDefined();
    expect(rootPkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});
