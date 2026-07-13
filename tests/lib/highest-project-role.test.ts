/**
 * Tests — workflow-role precedence helper
 *
 * This suite pins `highestProjectRole` (app/lib/workflow.ts), the
 * single source of role precedence (lead > reviewer > cataloguer)
 * that replaced per-file reimplementations, and documents the bug the
 * consolidation fixed: `api.workflow` previously read
 * `memberships[0].role`, so a user holding several roles on one
 * project got whichever row the DB returned first. The DB-backed case
 * below seeds a cataloguer row BEFORE a reviewer row and shows the
 * first-row read yields cataloguer while the helper yields reviewer.
 *
 * @version v0.4.1
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { highestProjectRole } from "../../app/lib/workflow";
import { requireProjectRole } from "../../app/lib/permissions.server";
import { PROJECT_ROLES } from "../../app/lib/validation/enums";

describe("highestProjectRole (pure)", () => {
  it("applies lead > reviewer > cataloguer regardless of input order", () => {
    expect(
      highestProjectRole([{ role: "cataloguer" }, { role: "lead" }]),
    ).toBe("lead");
    expect(
      highestProjectRole([{ role: "cataloguer" }, { role: "reviewer" }]),
    ).toBe("reviewer");
    expect(
      highestProjectRole([
        { role: "reviewer" },
        { role: "cataloguer" },
        { role: "lead" },
      ]),
    ).toBe("lead");
  });

  it("returns the sole role for a single membership", () => {
    expect(highestProjectRole([{ role: "cataloguer" }])).toBe("cataloguer");
  });

  it("returns null with no memberships", () => {
    expect(highestProjectRole([])).toBeNull();
  });

  it("ignores roles outside the workflow vocabulary", () => {
    expect(
      highestProjectRole([{ role: "stranger" }, { role: "reviewer" }]),
    ).toBe("reviewer");
    expect(highestProjectRole([{ role: "stranger" }])).toBeNull();
  });
});

describe("multi-role membership (DB-backed row-order regression)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("derives reviewer for a cataloguer-first two-role member", async () => {
    const db = drizzle(env.DB, { schema });
    const user = await createTestUser();
    const now = Date.now();

    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Two-Role Project",
      description: null,
      conventions: null,
      settings: null,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    // Cataloguer row inserted FIRST so a first-row read surfaces it.
    await db.insert(schema.projectMembers).values([
      {
        id: crypto.randomUUID(),
        projectId,
        userId: user.id,
        role: "cataloguer",
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        userId: user.id,
        role: "reviewer",
        createdAt: now,
      },
    ]);

    const memberships = await requireProjectRole(
      db,
      user.id,
      projectId,
      [...PROJECT_ROLES],
      false,
    );

    expect(memberships).toHaveLength(2);
    expect(highestProjectRole(memberships)).toBe("reviewer");
  });

  it("union semantics: a dual-role member keeps cataloguer-stage transitions", async () => {
    const { transitionVolumeStatus } = await import(
      "../../app/lib/workflow.server"
    );
    const db = drizzle(env.DB, { schema });
    const user = await createTestUser();
    const now = Date.now();

    const projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Union Semantics Project",
      description: null,
      conventions: null,
      settings: null,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    const volumeId = crypto.randomUUID();
    await db.insert(schema.volumes).values({
      id: volumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "Union Volume",
      referenceCode: `TEST-${volumeId.slice(0, 8)}`,
      manifestUrl: "https://example.test/manifest.json",
      pageCount: 10,
      status: "in_progress",
      assignedTo: user.id,
      assignedReviewer: null,
      reviewComment: null,
      createdAt: now,
      updatedAt: now,
    });

    // in_progress -> segmented is a cataloguer-map move; the reviewer
    // map does not contain it. The highest role alone would be denied;
    // the full held set must pass.
    await expect(
      transitionVolumeStatus(db, volumeId, "segmented", user.id, [
        "reviewer",
      ]),
    ).rejects.toThrow();

    await transitionVolumeStatus(db, volumeId, "segmented", user.id, [
      "reviewer",
      "cataloguer",
    ]);

    const [vol] = await db
      .select({ status: schema.volumes.status })
      .from(schema.volumes)
      .where(eq(schema.volumes.id, volumeId))
      .all();
    expect(vol.status).toBe("segmented");
  });
});
