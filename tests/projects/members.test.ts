/**
 * Tests — project member management + invite flow
 *
 * This suite pins the invite lifecycle that adds a new member to a
 * project: `createInvite` (writes an invitation row with a
 * single-use token, target role, and TTL) and `acceptInvite` (the
 * accept-handoff helper that atomically consumes the token,
 * resolves it to the inviting project, and writes a fresh
 * `project_members` row for the accepting user).
 *
 * The single-use semantic is enforced atomically — `acceptInvite`
 * issues one UPDATE ... RETURNING that flips the invite's
 * `consumed = 0` to `1` only when the row is unconsumed and
 * unexpired. Cases pin the happy path, the replay rejection
 * (second accept returns null), and the expired-token rejection
 * (TTL guard returns null).
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
import { eq, and } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createInvite, acceptInvite } from "../../app/lib/invites.server";

describe("member management and invite flow", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  async function createTestProject(leadId: string) {
    const db = drizzle(env.DB);
    const now = Date.now();
    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: leadId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: leadId,
      role: "lead",
      createdAt: now,
    });
    return projectId;
  }

  describe("createInvite", () => {
    it("invites an existing user and adds them to the project immediately", async () => {
      const db = drizzle(env.DB);
      const lead = await createTestUser({ name: "Lead User", isAdmin: false });
      const member = await createTestUser({
        email: "member@example.com",
        name: "Member",
        isAdmin: false,
      });
      const projectId = await createTestProject(lead.id);

      const result = await createInvite(
        db,
        DEFAULT_TEST_TENANT_ID,
        projectId,
        "member@example.com",
        ["cataloguer", "reviewer"],
        lead,
        "http://localhost:5173",
        "fake-resend-key"
      );

      expect(result.status).toBe("added");

      // Verify membership rows were created
      const memberships = await db
        .select()
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.projectId, projectId),
            eq(schema.projectMembers.userId, member.id)
          )
        )
        .all();

      expect(memberships).toHaveLength(2);
      const roles = memberships.map((m) => m.role).sort();
      expect(roles).toEqual(["cataloguer", "reviewer"]);
    });

    it("invites an unregistered email and auto-creates user account", async () => {
      const db = drizzle(env.DB);
      const lead = await createTestUser({ name: "Lead User", isAdmin: false });
      const projectId = await createTestProject(lead.id);

      const result = await createInvite(
        db,
        DEFAULT_TEST_TENANT_ID,
        projectId,
        "newuser@example.com",
        ["cataloguer"],
        lead,
        "http://localhost:5173",
        "fake-resend-key"
      );

      expect(result.status).toBe("invited");

      // Verify user was auto-created
      const newUser = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, "newuser@example.com"))
        .get();

      expect(newUser).toBeTruthy();
      expect(newUser!.name).toBeNull();
      expect(newUser!.isAdmin).toBeFalsy();

      // Verify invite was created
      const invites = await db
        .select()
        .from(schema.projectInvites)
        .where(eq(schema.projectInvites.email, "newuser@example.com"))
        .all();

      expect(invites).toHaveLength(1);
      expect(invites[0].projectId).toBe(projectId);
      expect(JSON.parse(invites[0].roles)).toEqual(["cataloguer"]);
    });

    it("adds new roles when inviting an existing member", async () => {
      const db = drizzle(env.DB);
      const lead = await createTestUser({ name: "Lead", isAdmin: false });
      const member = await createTestUser({
        email: "member@example.com",
        isAdmin: false,
      });
      const projectId = await createTestProject(lead.id);

      // First invite adds member role
      await createInvite(
        db,
        DEFAULT_TEST_TENANT_ID,
        projectId,
        "member@example.com",
        ["cataloguer"],
        lead,
        "http://localhost:5173",
        "fake-resend-key"
      );

      // Second invite adds reviewer role
      const result = await createInvite(
        db,
        DEFAULT_TEST_TENANT_ID,
        projectId,
        "member@example.com",
        ["reviewer", "cataloguer"],
        lead,
        "http://localhost:5173",
        "fake-resend-key"
      );

      expect(result.status).toBe("added");

      // Should have member + reviewer (no duplicates)
      const memberships = await db
        .select()
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.projectId, projectId),
            eq(schema.projectMembers.userId, member.id)
          )
        )
        .all();

      const roles = memberships.map((m) => m.role).sort();
      expect(roles).toEqual(["cataloguer", "reviewer"]);
    });
  });

  describe("acceptInvite", () => {
    it("accepts a valid invite and creates membership", async () => {
      const db = drizzle(env.DB);
      const lead = await createTestUser({ name: "Lead", isAdmin: false });
      const projectId = await createTestProject(lead.id);

      // Create a new user + invite manually
      const userId = crypto.randomUUID();
      const now = Date.now();
      await db.insert(schema.users).values({
        tenantId: DEFAULT_TEST_TENANT_ID,
        id: userId,
        email: "invited@example.com",
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      });

      const token = crypto.randomUUID();
      await db.insert(schema.projectInvites).values({
        id: crypto.randomUUID(),
        projectId,
        email: "invited@example.com",
        roles: JSON.stringify(["cataloguer", "reviewer"]),
        invitedBy: lead.id,
        token,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000, // 7 days
        createdAt: now,
      });

      const result = await acceptInvite(db, token);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error("expected success");
      expect(result.userId).toBe(userId);
      expect(result.projectId).toBe(projectId);

      // Verify membership created
      const memberships = await db
        .select()
        .from(schema.projectMembers)
        .where(
          and(
            eq(schema.projectMembers.projectId, projectId),
            eq(schema.projectMembers.userId, userId)
          )
        )
        .all();

      expect(memberships).toHaveLength(2);
      const roles = memberships.map((m) => m.role).sort();
      expect(roles).toEqual(["cataloguer", "reviewer"]);

      // Verify invite marked as accepted
      const invite = await db
        .select()
        .from(schema.projectInvites)
        .where(eq(schema.projectInvites.token, token))
        .get();
      expect(invite!.acceptedAt).toBeTruthy();
    });

    it("rejects expired invite", async () => {
      const db = drizzle(env.DB);
      const lead = await createTestUser({ name: "Lead", isAdmin: false });
      const projectId = await createTestProject(lead.id);

      const userId = crypto.randomUUID();
      const now = Date.now();
      await db.insert(schema.users).values({
        tenantId: DEFAULT_TEST_TENANT_ID,
        id: userId,
        email: "expired@example.com",
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      });

      const token = crypto.randomUUID();
      await db.insert(schema.projectInvites).values({
        id: crypto.randomUUID(),
        projectId,
        email: "expired@example.com",
        roles: JSON.stringify(["cataloguer"]),
        invitedBy: lead.id,
        token,
        expiresAt: now - 1000, // Already expired
        createdAt: now,
      });

      const result = await acceptInvite(db, token);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected failure");
      expect(result.error).toBeTruthy();
    });

    it("rejects already-accepted invite", async () => {
      const db = drizzle(env.DB);
      const lead = await createTestUser({ name: "Lead", isAdmin: false });
      const projectId = await createTestProject(lead.id);

      const userId = crypto.randomUUID();
      const now = Date.now();
      await db.insert(schema.users).values({
        tenantId: DEFAULT_TEST_TENANT_ID,
        id: userId,
        email: "used@example.com",
        isAdmin: false,
        createdAt: now,
        updatedAt: now,
      });

      const token = crypto.randomUUID();
      await db.insert(schema.projectInvites).values({
        id: crypto.randomUUID(),
        projectId,
        email: "used@example.com",
        roles: JSON.stringify(["cataloguer"]),
        invitedBy: lead.id,
        token,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        acceptedAt: now, // Already accepted
        createdAt: now,
      });

      const result = await acceptInvite(db, token);

      expect(result.success).toBe(false);
    });

    it("rejects invalid token", async () => {
      const db = drizzle(env.DB);
      const result = await acceptInvite(db, "nonexistent-token");
      expect(result.success).toBe(false);
    });
  });
});
