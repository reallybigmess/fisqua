/**
 * Tests — import uploads lifecycle
 *
 * This suite pins the `import_uploads` row lifecycle: create (staged,
 * headers + row count captured), tenant-scoped listing and lookup, and
 * discard as a status FLIP (never a DELETE) that only a `staged` row
 * transitions.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { importUploads } from "../../app/db/schema";
import {
  createUpload,
  listUploads,
  getUpload,
  discardUpload,
} from "../../app/lib/import/uploads.server";

function db() {
  return drizzle(env.DB);
}

async function makeUpload(id: string, tenantId = DEFAULT_TEST_TENANT_ID) {
  const user = await createTestUser({ tenantId });
  return createUpload(db(), {
    id,
    tenantId,
    userId: user.id,
    filename: `${id}.csv`,
    artifactKey: `${tenantId}/uploads/${id}.csv`,
    byteSize: 128,
    rowCount: 3,
    headers: ["identifier", "title"],
  });
}

describe("import uploads", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates a staged upload with headers and row count", async () => {
    const row = await makeUpload("up-1");
    expect(row.status).toBe("staged");
    expect(row.rowCount).toBe(3);
    expect(JSON.parse(row.headers!)).toEqual(["identifier", "title"]);
  });

  it("lists a tenant's uploads and scopes by tenant", async () => {
    await makeUpload("up-1", DEFAULT_TEST_TENANT_ID);
    await makeUpload("up-2", SECOND_TEST_TENANT_ID);
    const mine = await listUploads(db(), DEFAULT_TEST_TENANT_ID);
    expect(mine.map((u) => u.id)).toEqual(["up-1"]);
  });

  it("gets an upload only within its tenant", async () => {
    await makeUpload("up-1");
    expect(await getUpload(db(), DEFAULT_TEST_TENANT_ID, "up-1")).not.toBeNull();
    expect(await getUpload(db(), SECOND_TEST_TENANT_ID, "up-1")).toBeNull();
  });

  it("discards a staged upload as a status flip, never a delete", async () => {
    await makeUpload("up-1");
    expect(await discardUpload(db(), DEFAULT_TEST_TENANT_ID, "up-1")).toBe(true);

    const row = await getUpload(db(), DEFAULT_TEST_TENANT_ID, "up-1");
    expect(row!.status).toBe("discarded");
    // Row still exists — discard never deletes.
    const still = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, "up-1"))
      .get();
    expect(still).toBeDefined();
  });

  it("refuses to discard a non-staged upload", async () => {
    await makeUpload("up-1");
    await db()
      .update(importUploads)
      .set({ status: "committed" })
      .where(eq(importUploads.id, "up-1"));
    expect(await discardUpload(db(), DEFAULT_TEST_TENANT_ID, "up-1")).toBe(false);
  });

  it("refuses to discard another tenant's upload", async () => {
    await makeUpload("up-1", DEFAULT_TEST_TENANT_ID);
    expect(await discardUpload(db(), SECOND_TEST_TENANT_ID, "up-1")).toBe(false);
  });
});
