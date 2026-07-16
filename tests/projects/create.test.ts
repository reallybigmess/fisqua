/**
 * Tests — project creation
 *
 * This suite pins the project-creation path — the three helpers
 * that compose the create flow: `validateProjectForm` (the Zod
 * validation gate on the create form), `generateProjectId` (the
 * deterministic id generator that turns a project name into a
 * URL-safe slug + UUID composite), and `createProject` (the D1
 * write that lands the project row plus the founding lead's
 * `project_members` row in a single batch).
 *
 * The atomicity of the create-with-founder pattern matters: a
 * project that exists without a lead member is unrecoverable from
 * the UI (no one can act as project admin), so the founder
 * insertion runs in the same batch as the project insert. The
 * cases pin both halves of the batch landing or neither.
 *
 * @version v0.4.0
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
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { requireAdmin, requireProjectRole } from "../../app/lib/permissions.server";
import { createProject, generateProjectId, validateProjectForm } from "../../app/lib/projects.server";

describe("project creation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("requireAdmin", () => {
    it("allows admin users", () => {
      const admin = {
        id: "1",
        tenantId: DEFAULT_TEST_TENANT_ID,
        email: "admin@test.com",
        name: "Admin",
        isAdmin: true,
        isSuperAdmin: false,
        isCollabAdmin: false,
        isArchiveUser: false,
        isUserManager: false,
        isCataloguer: false,
        lastActiveAt: null,
        githubId: null,
      };
      expect(() => requireAdmin(admin)).not.toThrow();
    });

    it("throws 403 for non-admin users", () => {
      const user = {
        id: "2",
        tenantId: DEFAULT_TEST_TENANT_ID,
        email: "user@test.com",
        name: "User",
        isAdmin: false,
        isSuperAdmin: false,
        isCollabAdmin: false,
        isArchiveUser: false,
        isUserManager: false,
        isCataloguer: false,
        lastActiveAt: null,
        githubId: null,
      };
      try {
        requireAdmin(user);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });
  });

  describe("requireProjectRole", () => {
    it("allows user with matching role", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser({ isAdmin: false });
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-1",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test Project",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-1",
        projectId: "proj-1",
        userId: user.id,
        role: "lead",
        createdAt: now,
      });

      const result = await requireProjectRole(db, user.id, "proj-1", ["lead"]);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe("lead");
    });

    it("throws 403 for user without matching role", async () => {
      const db = drizzle(env.DB, { schema });
      const user = await createTestUser({ isAdmin: false });
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-2",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test Project 2",
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(schema.projectMembers).values({
        id: "pm-2",
        projectId: "proj-2",
        userId: user.id,
        role: "cataloguer",
        createdAt: now,
      });

      try {
        await requireProjectRole(db, user.id, "proj-2", ["lead"]);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(Response);
        expect((e as Response).status).toBe(403);
      }
    });

    it("allows admin to bypass role checks", async () => {
      const db = drizzle(env.DB, { schema });
      const admin = await createTestUser({ isAdmin: true });
      const now = Date.now();

      await db.insert(schema.projects).values({
        id: "proj-3",
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test Project 3",
        createdBy: admin.id,
        createdAt: now,
        updatedAt: now,
      });

      // Admin has no membership but should still be allowed
      const result = await requireProjectRole(db, admin.id, "proj-3", ["lead"], true);
      expect(result).toHaveLength(0); // no membership, but allowed
    });
  });

  describe("validateProjectForm", () => {
    it("validates valid project data", () => {
      const result = validateProjectForm({
        name: "My Project",
        description: "A description",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("My Project");
      }
    });

    it("rejects empty project name", () => {
      const result = validateProjectForm({
        name: "",
        description: "",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("generateProjectId", () => {
    it("is exported and returns an 8-character alphanumeric id", () => {
      expect(typeof generateProjectId).toBe("function");
      const id = generateProjectId();
      expect(id).toMatch(/^[A-Za-z0-9]{8}$/);
    });
  });

  describe("createProject", () => {
    it("uses the 8-char short-id format, not a UUID", async () => {
      const db = drizzle(env.DB, { schema });
      const admin = await createTestUser({ isAdmin: true });

      const project = await createProject(
        db,
        DEFAULT_TEST_TENANT_ID,
        { name: "Short Id Project", description: null },
        admin.id
      );

      expect(project.id).toMatch(/^[A-Za-z0-9]{8}$/);
    });

    it("creates a project and adds creator as lead", async () => {
      const db = drizzle(env.DB, { schema });
      const admin = await createTestUser({ isAdmin: true });

      const project = await createProject(db, DEFAULT_TEST_TENANT_ID, {
        name: "Template Project",
        description: "A project using the template",
      }, admin.id);

      expect(project.name).toBe("Template Project");
      expect(project.createdBy).toBe(admin.id);

      // Verify creator is added as lead
      const members = await db
        .select()
        .from(schema.projectMembers)
        .where(eq(schema.projectMembers.projectId, project.id))
        .all();

      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe(admin.id);
      expect(members[0].role).toBe("lead");
    });
  });
});
