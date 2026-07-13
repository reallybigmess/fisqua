/**
 * Tests — description field validation (DESC-08)
 *
 * This suite pins the field-level validation gate on the
 * `saveDescription` and `submitForReview` helpers. `saveDescription`
 * is intentionally permissive — it writes any subset of the
 * description columns the editor passes, so an in-progress entry
 * can park half-typed values across multiple sessions. The strict
 * gate lives on `submitForReview`: before flipping the status from
 * `in_progress` to `under_review`, the helper runs the standard-aware
 * validator factory against the row and refuses on missing
 * mandatory fields.
 *
 * Cases pin both halves: a save with partial data writes the row
 * (no errors), but a submit on the same row surfaces a
 * `MissingFieldsError` carrying the list of unfilled mandatory
 * columns. The error shape is what the editor's "submit blocked"
 * UI consumes to render per-field hints.
 *
 * @version v0.3.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  saveDescription,
  submitForReview,
} from "../../app/lib/description.server";

describe("Description field validation (DESC-08)", () => {
  let db: ReturnType<typeof drizzle>;
  let entryId: string;
  let userId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    const user = await createTestUser({ isAdmin: false });
    userId = user.id;
    const now = Date.now();

    const projectId = crypto.randomUUID();
    const volumeId = crypto.randomUUID();
    entryId = crypto.randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: user.id,
      role: "lead",
      createdAt: now,
    });

    await db.insert(schema.volumes).values({
      id: volumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "Test Volume",
      referenceCode: "co-test-vol001",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 10,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.entries).values({
      id: entryId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 0,
      startPage: 1,
      startY: 0,
      type: "item",
      descriptionStatus: "in_progress",
      assignedDescriber: user.id,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("submitForReview rejects when title is missing", async () => {
    // Set all fields except title
    await saveDescription(db, entryId, {
      resourceType: "texto",
      dateExpression: "1920",
      scopeContent: "Test content",
      language: "es",
      extent: "3 folios",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.some((e) => e.field === "title")).toBe(true);
    }
  });

  it("submitForReview rejects when resourceType is missing", async () => {
    // Set title on the entry directly (title is the original field)
    await db
      .update(schema.entries)
      .set({ title: "Test title" })
      .where(eq(schema.entries.id, entryId));

    await saveDescription(db, entryId, {
      dateExpression: "1920",
      scopeContent: "Test content",
      language: "es",
      extent: "3 folios",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.some((e) => e.field === "resourceType")).toBe(true);
    }
  });

  it("submitForReview rejects when dateExpression is missing", async () => {
    await db
      .update(schema.entries)
      .set({ title: "Test title" })
      .where(eq(schema.entries.id, entryId));

    await saveDescription(db, entryId, {
      resourceType: "texto",
      scopeContent: "Test content",
      language: "es",
      extent: "3 folios",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.some((e) => e.field === "dateExpression")).toBe(true);
    }
  });

  it("submitForReview rejects when scopeContent is missing", async () => {
    await db
      .update(schema.entries)
      .set({ title: "Test title" })
      .where(eq(schema.entries.id, entryId));

    await saveDescription(db, entryId, {
      resourceType: "texto",
      dateExpression: "1920",
      language: "es",
      extent: "3 folios",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.some((e) => e.field === "scopeContent")).toBe(true);
    }
  });

  it("submitForReview rejects when language is missing", async () => {
    await db
      .update(schema.entries)
      .set({ title: "Test title" })
      .where(eq(schema.entries.id, entryId));

    await saveDescription(db, entryId, {
      resourceType: "texto",
      dateExpression: "1920",
      scopeContent: "Test content",
      extent: "3 folios",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.some((e) => e.field === "language")).toBe(true);
    }
  });

  it("submitForReview rejects when extent is missing", async () => {
    await db
      .update(schema.entries)
      .set({ title: "Test title" })
      .where(eq(schema.entries.id, entryId));

    await saveDescription(db, entryId, {
      resourceType: "texto",
      dateExpression: "1920",
      scopeContent: "Test content",
      language: "es",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validationErrors.some((e) => e.field === "extent")).toBe(true);
    }
  });

  it("submitForReview accepts when all required fields present", async () => {
    // Set title on entry and all description fields
    await db
      .update(schema.entries)
      .set({ title: "Test title" })
      .where(eq(schema.entries.id, entryId));

    await saveDescription(db, entryId, {
      resourceType: "texto",
      dateExpression: "1920",
      scopeContent: "Test content describing the document",
      language: "es",
      extent: "3 folios",
    });

    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(true);
  });

  it("validation returns field-level errors", async () => {
    // Submit with no fields at all -- should get errors for each required field
    const result = await submitForReview(db, entryId, userId, "lead");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errorFields = result.validationErrors.map((e) => e.field);
      expect(errorFields).toContain("title");
      expect(errorFields).toContain("resourceType");
      expect(errorFields).toContain("dateExpression");
      expect(errorFields).toContain("scopeContent");
      expect(errorFields).toContain("language");
      expect(errorFields).toContain("extent");

      // Each error should have a message
      for (const err of result.validationErrors) {
        expect(err.message).toBeTruthy();
      }
    }
  });
});
