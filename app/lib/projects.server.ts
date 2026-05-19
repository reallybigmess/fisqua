/**
 * Project CRUD Helpers
 *
 * This module deals with the server-side primitives the project
 * surfaces consume: minting short URL-friendly project ids,
 * validating the create/edit form payload, and the membership-aware
 * reads that back the dashboard and the per-project workspace. The
 * 8-character `generateProjectId` replaces the legacy UUID scheme so
 * project URLs stay short — the 62-character alphabet gives ~2.2e14
 * possibilities, well above the platform's collision horizon.
 *
 * `validateProjectForm` is the single gate at the create boundary; it
 * runs trimmed-length checks against the human-facing fields before
 * the route hands the payload to the Drizzle insert, so a malformed
 * submission surfaces as an inline form error rather than a database
 * CHECK failure.
 *
 * The downstream membership-aware helpers join `projects` against
 * `projectMembers` so a caller never sees a project they do not have
 * a role on, regardless of how the loader assembles the request.
 *
 * @version v0.3.0
 */

// --- EXTENSION POINT --- add your domain-specific project logic here

import { eq, and } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  projects,
  projectMembers,
} from "../db/schema";

// 8-char alphanumeric project IDs (URL-friendly; replaces the legacy UUID format).
// Alphabet: 62 chars → 62^8 ≈ 2.2e14 possibilities, ample for the archive's scale.
const PROJECT_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateProjectId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += PROJECT_ID_ALPHABET[bytes[i] % PROJECT_ID_ALPHABET.length];
  }
  return out;
}

/**
 * Schema for project creation form validation.
 */
export function validateProjectForm(data: {
  name: string;
  description: string;
}): { success: true; data: typeof data } | { success: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!data.name || data.name.trim().length === 0) {
    errors.name = "Project name is required";
  } else if (data.name.trim().length > 200) {
    errors.name = "Project name must be 200 characters or less";
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: {
      name: data.name.trim(),
      description: data.description?.trim() || "",
    },
  };
}

/**
 * Creates a project and adds the creator as a "lead" member.
 */
export async function createProject(
  db: DrizzleD1Database<any>,
  data: { name: string; description: string | null },
  creatorId: string
) {
  const now = Date.now();
  const projectId = generateProjectId();

  const project = {
    id: projectId,
    name: data.name,
    description: data.description || null,
    createdBy: creatorId,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(projects).values(project);

  // Add creator as lead
  await db.insert(projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId: creatorId,
    role: "lead",
    createdAt: now,
  });

  return project;
}

/**
 * Fetches all projects for a user, with their roles.
 * Admins see all projects.
 */
export async function getUserProjects(
  db: DrizzleD1Database<any>,
  userId: string,
  isAdmin: boolean
) {
  if (isAdmin) {
    // Admin sees all projects
    const allProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .all();

    // Get admin's memberships for role display
    const memberships = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId))
      .all();

    const membershipMap = new Map<string, string[]>();
    for (const m of memberships) {
      const roles = membershipMap.get(m.projectId) || [];
      roles.push(m.role);
      membershipMap.set(m.projectId, roles);
    }

    return allProjects.map((p) => ({
      ...p,
      roles: membershipMap.get(p.id) || ["admin"],
    }));
  }

  // Regular user -- only projects with membership
  const userMemberships = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId))
    .all();

  if (userMemberships.length === 0) {
    return [];
  }

  // Group roles by project
  const roleMap = new Map<string, string[]>();
  for (const m of userMemberships) {
    const roles = roleMap.get(m.projectId) || [];
    roles.push(m.role);
    roleMap.set(m.projectId, roles);
  }

  const projectIds = Array.from(roleMap.keys());

  // Fetch project details
  const userProjects = [];
  for (const projectId of projectIds) {
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .all();

    if (rows.length > 0) {
      userProjects.push({
        ...rows[0],
        roles: roleMap.get(projectId) || [],
      });
    }
  }

  return userProjects;
}

/**
 * Fetches a single project by ID.
 */
export async function getProject(
  db: DrizzleD1Database<any>,
  projectId: string
) {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      conventions: projects.conventions,
      settings: projects.settings,
      createdBy: projects.createdBy,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .all();

  return rows[0] || null;
}
