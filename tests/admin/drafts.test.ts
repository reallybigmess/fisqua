/**
 * Tests — drafts and changelog
 *
 * This suite pins the autosave-draft substrate plus the post-save
 * changelog computation. The draft side covers `saveDraft` (upsert on
 * `tenantId + recordId + recordType`), `getDraft` (per-tenant fetch by
 * record pair), `getConflictDraft` (same-tenant any-user fetch
 * surfacing concurrent edits), and `deleteDraft` (per-tenant cleanup
 * on successful save), plus the two-tenant isolation cases: entities
 * and places are federation-SHARED records, so two tenants must be
 * able to hold independent drafts on the SAME (recordId, recordType)
 * without reading, clobbering, or deleting each other's (migration
 * 0050). The changelog side exercises `computeDiff` (structural JSON
 * diff collapsing unchanged keys) and `createChangelogEntry` (writes
 * the diff to `changelog` so the description detail page can render
 * an audit trail of substantive field-level edits).
 *
 * The two surfaces share this file because they run in sequence on
 * the save path: the editor autosaves into `drafts`, and on commit
 * the route diffs current vs draft, writes a `changelog` row, and
 * clears the draft. The end-to-end ordering is implicit in the test
 * sequence here even though each describe block is independent.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";

import {
  saveDraft,
  getDraft,
  getConflictDraft,
  deleteDraft,
} from "../../app/lib/drafts.server";
import {
  computeDiff,
  createChangelogEntry,
} from "../../app/lib/changelog.server";

describe("drafts and changelog", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // -----------------------------------------------------------------------
  // Draft utilities
  // -----------------------------------------------------------------------

  describe("saveDraft", () => {
    it("creates a draft record and upserts on same recordId+recordType", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      // Create initial draft
      await saveDraft(db, DEFAULT_TEST_TENANT_ID, "rec-1", "description", user.id, '{"title":"A"}');

      const first = await db
        .select()
        .from(schema.drafts)
        .where(
          and(
            eq(schema.drafts.recordId, "rec-1"),
            eq(schema.drafts.recordType, "description")
          )
        )
        .get();

      expect(first).toBeTruthy();
      expect(first!.snapshot).toBe('{"title":"A"}');
      expect(first!.userId).toBe(user.id);

      // Upsert with new snapshot
      await saveDraft(db, DEFAULT_TEST_TENANT_ID, "rec-1", "description", user.id, '{"title":"B"}');

      const all = await db
        .select()
        .from(schema.drafts)
        .where(
          and(
            eq(schema.drafts.recordId, "rec-1"),
            eq(schema.drafts.recordType, "description")
          )
        )
        .all();

      // Should still be exactly one draft
      expect(all).toHaveLength(1);
      expect(all[0].snapshot).toBe('{"title":"B"}');
    });
  });

  describe("getDraft", () => {
    it("returns null when no draft exists", async () => {
      const db = drizzle(env.DB);
      const result = await getDraft(db, DEFAULT_TEST_TENANT_ID, "nonexistent", "description");
      expect(result).toBeNull();
    });

    it("returns the draft when it exists", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });
      await saveDraft(db, DEFAULT_TEST_TENANT_ID, "rec-2", "entity", user.id, '{"name":"X"}');

      const result = await getDraft(db, DEFAULT_TEST_TENANT_ID, "rec-2", "entity");
      expect(result).toBeTruthy();
      expect(result!.userId).toBe(user.id);
      expect(result!.snapshot).toBe('{"name":"X"}');
      expect(result!.updatedAt).toBeGreaterThan(0);
    });
  });

  describe("getConflictDraft", () => {
    it("returns null when no other user has a draft", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      // Same user's draft should not count as conflict
      await saveDraft(db, DEFAULT_TEST_TENANT_ID, "rec-3", "repository", user.id, '{"code":"X"}');

      const result = await getConflictDraft(
        db,
        DEFAULT_TEST_TENANT_ID,
        "rec-3",
        "repository",
        user.id
      );
      expect(result).toBeNull();
    });

    it("returns the draft when another user has one", async () => {
      const db = drizzle(env.DB);
      const userA = await createTestUser({ isAdmin: true, name: "User A" });
      const userB = await createTestUser({ isAdmin: true, name: "User B" });

      await saveDraft(db, DEFAULT_TEST_TENANT_ID, "rec-4", "place", userA.id, '{"label":"Y"}');

      const result = await getConflictDraft(db, DEFAULT_TEST_TENANT_ID, "rec-4", "place", userB.id);
      expect(result).toBeTruthy();
      expect(result!.userId).toBe(userA.id);
      expect(result!.updatedAt).toBeGreaterThan(0);
    });
  });

  describe("deleteDraft", () => {
    it("removes the draft for a record", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });
      await saveDraft(db, DEFAULT_TEST_TENANT_ID, "rec-5", "description", user.id, '{"title":"Z"}');

      // Verify draft exists
      const before = await getDraft(db, DEFAULT_TEST_TENANT_ID, "rec-5", "description");
      expect(before).toBeTruthy();

      await deleteDraft(db, DEFAULT_TEST_TENANT_ID, "rec-5", "description");

      const after = await getDraft(db, DEFAULT_TEST_TENANT_ID, "rec-5", "description");
      expect(after).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Cross-tenant draft isolation (migration 0050)
  //
  // Entities and places are federation-SHARED records, so two tenants of
  // one federation autosave against the SAME (recordId, recordType). Each
  // tenant must hold its own independent draft: neither read leaks the
  // other's snapshot, an upsert never clobbers or re-tenants the other's
  // row, a delete removes only the caller's, and same-record drafts in
  // different tenants are not "conflicts".
  // -----------------------------------------------------------------------

  describe("cross-tenant draft isolation on a shared record", () => {
    const SHARED_ENTITY_ID = "shared-entity-1";

    it("two tenants hold independent drafts on the same record; upserts do not cross", async () => {
      const db = drizzle(env.DB);
      const userA = await createTestUser({ isAdmin: true });
      const userB = await createTestUser({
        isAdmin: true,
        tenantId: SECOND_TEST_TENANT_ID,
      });

      // Both tenants autosave against the same shared entity record.
      await saveDraft(db, DEFAULT_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity", userA.id, '{"name":"lead edit"}');
      await saveDraft(db, SECOND_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity", userB.id, '{"name":"member edit"}');

      // Two rows coexist under the per-tenant unique index.
      const all = await db
        .select()
        .from(schema.drafts)
        .where(
          and(
            eq(schema.drafts.recordId, SHARED_ENTITY_ID),
            eq(schema.drafts.recordType, "entity")
          )
        )
        .all();
      expect(all).toHaveLength(2);

      // Neither tenant reads the other's in-progress edits.
      const draftA = await getDraft(db, DEFAULT_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity");
      const draftB = await getDraft(db, SECOND_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity");
      expect(draftA!.snapshot).toBe('{"name":"lead edit"}');
      expect(draftA!.userId).toBe(userA.id);
      expect(draftB!.snapshot).toBe('{"name":"member edit"}');
      expect(draftB!.userId).toBe(userB.id);

      // Tenant B's upsert (the step-6 clobber shape) touches only its own
      // row: tenant A's snapshot, author, and tenant are unchanged.
      await saveDraft(db, SECOND_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity", userB.id, '{"name":"member edit v2"}');
      const draftAAfter = await getDraft(db, DEFAULT_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity");
      expect(draftAAfter!.snapshot).toBe('{"name":"lead edit"}');
      expect(draftAAfter!.userId).toBe(userA.id);
      const rowA = await db
        .select({ tenantId: schema.drafts.tenantId })
        .from(schema.drafts)
        .where(eq(schema.drafts.id, draftAAfter!.id))
        .get();
      expect(rowA!.tenantId).toBe(DEFAULT_TEST_TENANT_ID);
    });

    it("cross-tenant drafts are not conflicts, and delete removes only the caller's", async () => {
      const db = drizzle(env.DB);
      const userA = await createTestUser({ isAdmin: true });
      const userB = await createTestUser({
        isAdmin: true,
        tenantId: SECOND_TEST_TENANT_ID,
      });

      await saveDraft(db, DEFAULT_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity", userA.id, '{"name":"lead edit"}');
      await saveDraft(db, SECOND_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity", userB.id, '{"name":"member edit"}');

      // Tenant B's draft on the shared record is NOT a conflict for
      // tenant A's editor (and vice versa).
      const conflictForA = await getConflictDraft(
        db,
        DEFAULT_TEST_TENANT_ID,
        SHARED_ENTITY_ID,
        "entity",
        userA.id
      );
      expect(conflictForA).toBeNull();

      // Tenant A's post-save cleanup deletes only tenant A's draft.
      await deleteDraft(db, DEFAULT_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity");
      expect(await getDraft(db, DEFAULT_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity")).toBeNull();
      const draftB = await getDraft(db, SECOND_TEST_TENANT_ID, SHARED_ENTITY_ID, "entity");
      expect(draftB!.snapshot).toBe('{"name":"member edit"}');
    });
  });

  // -----------------------------------------------------------------------
  // Changelog utilities
  // -----------------------------------------------------------------------

  describe("computeDiff", () => {
    it("returns null when no fields changed", () => {
      const original = { title: "A", notes: "B" };
      const updated = { title: "A", notes: "B" };
      expect(computeDiff(original, updated)).toBeNull();
    });

    it("returns { field: { old, new } } for changed fields", () => {
      const original = { title: "A", notes: "B", extent: "10" };
      const updated = { title: "X", notes: "B", extent: "20" };
      const diff = computeDiff(original, updated);

      expect(diff).toEqual({
        title: { old: "A", new: "X" },
        extent: { old: "10", new: "20" },
      });
    });

    it("detects changes in array/object fields via JSON comparison", () => {
      const original = { genre: ["a", "b"] };
      const updated = { genre: ["a", "c"] };
      const diff = computeDiff(original, updated);

      expect(diff).toEqual({
        genre: { old: ["a", "b"], new: ["a", "c"] },
      });
    });
  });

  describe("createChangelogEntry", () => {
    it("stores the diff with all required fields", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      const diff = { title: { old: "A", new: "B" } };
      await createChangelogEntry(
        db,
        "rec-6",
        "description",
        user.id,
        diff,
        "Fixed title"
      );

      const entries = await db
        .select()
        .from(schema.changelog)
        .where(
          and(
            eq(schema.changelog.recordId, "rec-6"),
            eq(schema.changelog.recordType, "description")
          )
        )
        .all();

      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(user.id);
      expect(entries[0].note).toBe("Fixed title");
      expect(JSON.parse(entries[0].diff)).toEqual(diff);
      expect(entries[0].createdAt).toBeGreaterThan(0);
    });

    it("stores null note when none provided", async () => {
      const db = drizzle(env.DB);
      const user = await createTestUser({ isAdmin: true });

      const diff = { notes: { old: "X", new: "Y" } };
      await createChangelogEntry(db, "rec-7", "entity", user.id, diff);

      const entries = await db
        .select()
        .from(schema.changelog)
        .where(eq(schema.changelog.recordId, "rec-7"))
        .all();

      expect(entries).toHaveLength(1);
      expect(entries[0].note).toBeNull();
    });
  });
});
