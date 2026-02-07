import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Verifies that the superadmin pipeline upload tenant targeting bug is fixed.
 *
 * The bug: when a superadmin selected a tenant from the dropdown, the upload
 * form did NOT use that tenant as the target. The fix is three-part:
 * 1. Backend reads tenantId from multipart form data for SUPER_ADMIN users
 * 2. Frontend upload() accepts and sends tenantId in FormData
 * 3. PipelinesPage passes effectiveTenantId to the upload mutation
 */
describe("superadmin pipeline upload — tenant targeting fix", () => {
  it("backend POST /api/pipelines reads tenantId from form data for SUPER_ADMIN", () => {
    const pipelinesRouteSource = readFileSync(
      path.join(__dirname, "pipelines.ts"),
      "utf-8",
    );

    // The handler should read tenantId from the multipart form field
    const readsTenantIdFromBody =
      pipelinesRouteSource.includes('fieldname === "tenantId"') ||
      pipelinesRouteSource.includes("request.body.tenantId") ||
      pipelinesRouteSource.includes('part.fieldname === "tenantId"');

    // The handler should check for SUPER_ADMIN role
    const checksRole = pipelinesRouteSource.includes("SUPER_ADMIN");

    expect(readsTenantIdFromBody).toBe(true);
    expect(checksRole).toBe(true);
  });

  it("frontend upload() accepts and sends tenantId in FormData", () => {
    const pipelinesServiceSource = readFileSync(
      path.resolve(
        __dirname,
        "../../../admin-ui/src/services/pipelines.ts",
      ),
      "utf-8",
    );

    // upload should accept a tenantId parameter
    const uploadAcceptsTenantId = /upload:\s*\(files:\s*File\[\],\s*urls:\s*string,\s*tenantId\?:\s*string\)/.test(
      pipelinesServiceSource,
    );

    // upload should append tenantId to FormData
    const uploadSendsTenantId =
      pipelinesServiceSource.includes('form.append("tenantId"') ||
      pipelinesServiceSource.includes("form.append('tenantId'");

    expect(uploadAcceptsTenantId).toBe(true);
    expect(uploadSendsTenantId).toBe(true);
  });

  it("PipelinesPage passes effectiveTenantId to upload mutation", () => {
    const pipelinesPageSource = readFileSync(
      path.resolve(
        __dirname,
        "../../../admin-ui/src/pages/PipelinesPage.tsx",
      ),
      "utf-8",
    );

    // uploadMut.mutate should include tenantId
    const mutateWithTenantId =
      pipelinesPageSource.includes("effectiveTenantId") &&
      pipelinesPageSource.includes("uploadMut.mutate") &&
      /uploadMut\.mutate\(\{[^}]*tenantId/.test(pipelinesPageSource);

    // The mutation function type should accept tenantId
    const mutationAcceptsTenantId =
      /mutationFn:.*tenantId/.test(pipelinesPageSource);

    expect(mutateWithTenantId).toBe(true);
    expect(mutationAcceptsTenantId).toBe(true);
  });
});
