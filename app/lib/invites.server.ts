/**
 * Project Invite Helpers
 *
 * This module deals with the server-side helpers that resolve a
 * project-level invite request: if the email already maps to a
 * registered user, add them as a project member directly; otherwise
 * create a `projectInvites` row and dispatch the appropriate
 * transactional email.
 *
 * Multi-tenancy: `users.tenant_id` is NOT NULL, so newly-created users
 * from the new-invite path must carry an explicit tenant id at INSERT
 * time. Callers pass the request-boundary tenant via the `tenantId`
 * argument from `context.get(tenantContext).id`, and newly-invited
 * users inherit the tenant of the inviting workspace.
 *
 * @version v0.4.2
 */

import { eq, and, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  users,
  projects,
  projectMembers,
  projectInvites,
} from "../db/schema";
import {
  sendNewUserInviteEmail,
  sendExistingUserInviteEmail,
} from "./email.server";
import { getAppConfig } from "./config.server";
import type { ProjectRole } from "./validation/enums";

type InviterUser = {
  id: string;
  email: string;
  name: string | null;
};

type InviteResult = {
  status: "added" | "invited" | "error";
  error?: string;
};

/**
 * Invites a user to a project by email.
 *
 * - If the email belongs to an existing user who is already a member,
 *   only adds any new roles they don't already have.
 * - If the email belongs to an existing user who is NOT a member,
 *   adds them immediately and sends a notification email.
 * - If the email is unregistered, auto-creates the user account,
 *   creates an invite token, and sends a combined invite+login email.
 */
export async function createInvite(
  db: DrizzleD1Database<any>,
  tenantId: string,
  projectId: string,
  email: string,
  roles: string[],
  invitedByUser: InviterUser,
  origin: string,
  resendApiKey: string,
  env: { APP_NAME?: string; SENDER_EMAIL?: string } = {}
): Promise<InviteResult> {
  const normalizedEmail = email.toLowerCase().trim();

  // Look up the project for its name (used in emails), scoped to the
  // calling tenant so a projectId from another tenant cannot resolve.
  const project = await db
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
    .get();

  if (!project) {
    return { status: "error", error: "Project not found" };
  }

  // Check if user exists
  let existingUser = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .get();

  const appConfig = getAppConfig(env);
  const inviterName = invitedByUser.name || invitedByUser.email;

  if (existingUser) {
    // User exists -- check current memberships
    const currentMemberships = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, existingUser.id)
        )
      )
      .all();

    const existingRoles: Set<string> = new Set(currentMemberships.map((m) => m.role));
    const newRoles = roles.filter((r) => !existingRoles.has(r));

    if (newRoles.length > 0) {
      const now = Date.now();
      for (const role of newRoles) {
        await db.insert(projectMembers).values({
          id: crypto.randomUUID(),
          projectId,
          userId: existingUser.id,
          role: role as ProjectRole,
          createdAt: now,
        });
      }
    }

    // Send notification email if they weren't already a member
    if (currentMemberships.length === 0) {
      try {
        const projectUrl = `${origin}/projects/${projectId}`;
        await sendExistingUserInviteEmail(
          resendApiKey,
          normalizedEmail,
          inviterName,
          project.name,
          projectUrl,
          appConfig
        );
      } catch {
        // Email failure is non-blocking
      }
    }

    return { status: "added" };
  }

  // User does not exist -- auto-create account
  const now = Date.now();
  const newUserId = crypto.randomUUID();

  await db.insert(users).values({
    tenantId,
    id: newUserId,
    email: normalizedEmail,
    isAdmin: false,
    createdAt: now,
    updatedAt: now,
  });

  // Create invite token
  const token = crypto.randomUUID();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  await db.insert(projectInvites).values({
    id: crypto.randomUUID(),
    projectId,
    email: normalizedEmail,
    roles: JSON.stringify(roles),
    invitedBy: invitedByUser.id,
    token,
    expiresAt: now + sevenDays,
    createdAt: now,
  });

  // Send combined invite + login email
  try {
    const acceptUrl = `${origin}/invite/accept?token=${token}`;
    await sendNewUserInviteEmail(
      resendApiKey,
      normalizedEmail,
      inviterName,
      project.name,
      acceptUrl,
      appConfig
    );
  } catch {
    // Email failure is non-blocking
  }

  return { status: "invited" };
}

type AcceptResult =
  | { success: true; userId: string; projectId: string }
  | { success: false; error: string };

/**
 * Accepts an invite by token.
 * Validates the token, marks it as accepted, and creates membership rows.
 */
export async function acceptInvite(
  db: DrizzleD1Database<any>,
  token: string
): Promise<AcceptResult> {
  const invite = await db
    .select()
    .from(projectInvites)
    .where(
      and(
        eq(projectInvites.token, token),
        isNull(projectInvites.acceptedAt)
      )
    )
    .get();

  if (!invite) {
    return { success: false, error: "Invalid or already-used invite link." };
  }

  // Check expiry
  if (invite.expiresAt < Date.now()) {
    return { success: false, error: "This invite link has expired." };
  }

  // Find the user by email
  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, invite.email))
    .get();

  if (!user) {
    return { success: false, error: "User account not found." };
  }

  // Mark invite as accepted
  await db
    .update(projectInvites)
    .set({ acceptedAt: Date.now() })
    .where(eq(projectInvites.id, invite.id));

  // Parse roles and create membership rows
  const roles: string[] = JSON.parse(invite.roles);
  const now = Date.now();

  // Check existing memberships to avoid duplicates
  const existingMemberships = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, invite.projectId),
        eq(projectMembers.userId, user.id)
      )
    )
    .all();

  const existingRoles: Set<string> = new Set(existingMemberships.map((m) => m.role));

  for (const role of roles) {
    if (!existingRoles.has(role)) {
      await db.insert(projectMembers).values({
        id: crypto.randomUUID(),
        projectId: invite.projectId,
        userId: user.id,
        role: role as ProjectRole,
        createdAt: now,
      });
    }
  }

  return {
    success: true,
    userId: user.id,
    projectId: invite.projectId,
  };
}
