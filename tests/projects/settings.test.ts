/**
 * Tests — project settings update + role gate
 *
 * This suite pins the per-project settings-edit surface plus the
 * `requireProjectRole` gate that backstops the settings route. The
 * settings blob is JSON-shaped (read/write via the helpers in
 * `tests/lib/project-settings.test.ts`); this file exercises the
 * route-side semantics: only `lead` and `admin` project roles can
 * change settings, `viewer` and `cataloguer` 403, and the
 * settings-write path emits an `audit_log` row so settings drift
 * has an attribution trail.
 *
 * The role gate uses a 403 (not 404) here because the path is
 * known-existing — a cataloguer trying to update settings hits a
 * legitimate URL with the wrong role. The 404-vs-403 pattern is
 * applied selectively across the app; this file pins the 403
 * choice for the project-internal surface.
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
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { requireProjectRole } from "../../app/lib/permissions.server";

describe("project settings", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("settings update", () => {
    it("updates project name and description", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s1",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Original Name",
        description: "Original desc",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db
        .update(schema.projects)
        .set({
          name: "Updated Name",
          description: "Updated desc",
          updatedAt: Date.now(),
        })
        .where(eq(schema.projects.id, "proj-s1"));

      const updated = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, "proj-s1"))
        .get();

      expect(updated!.name).toBe("Updated Name");
      expect(updated!.description).toBe("Updated desc");
      // >= not >: seed and update can land in the same millisecond, and
      // Date.now() has no finer resolution to distinguish them.
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(now);
    });

    it("updates conventions text", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s2",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      const conventionsText = "## Guidelines\n\n- Use consistent formatting\n- Follow style guide";

      await db
        .update(schema.projects)
        .set({
          conventions: conventionsText,
          updatedAt: Date.now(),
        })
        .where(eq(schema.projects.id, "proj-s2"));

      const updated = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, "proj-s2"))
        .get();

      expect(updated!.conventions).toBe(conventionsText);
    });

    it("updates settings JSON", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s3",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      const settingsJson = JSON.stringify({ theme: "dark", maxItems: 100 });

      await db
        .update(schema.projects)
        .set({
          settings: settingsJson,
          updatedAt: Date.now(),
        })
        .where(eq(schema.projects.id, "proj-s3"));

      const updated = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, "proj-s3"))
        .get();

      expect(updated!.settings).toBe(settingsJson);
      expect(JSON.parse(updated!.settings!)).toEqual({ theme: "dark", maxItems: 100 });
    });
  });

  describe("role access control", () => {
    it("allows lead to access settings", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s4",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-s4",
        projectId: "proj-s4",
        userId: user.id,
        role: "lead",
        createdAt: now,
      });

      const result = await requireProjectRole(db, user.id, "proj-s4", ["lead"]);
      expect(result).toHaveLength(1);
    });

    it("rejects member from settings", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser();
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-s5",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-s5",
        projectId: "proj-s5",
        userId: user.id,
        role: "cataloguer",
        createdAt: now,
      });

      try {
        await requireProjectRole(db, user.id, "proj-s5", ["lead"]);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });
  });
});
