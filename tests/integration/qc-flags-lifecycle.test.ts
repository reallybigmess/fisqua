/**
 * Tests — QC flags lifecycle (integration)
 *
 * This suite is the end-to-end regression net for the QC-flag
 * lifecycle. It exercises the full raise → comment → resolve loop
 * through the real `api.qc-flags` action plus the dashboard-side
 * read path (`getProjectVolumes` — the loader the volumes
 * dashboard consumes to count open vs resolved flags per
 * volume).
 *
 * The integration shape matters because the dashboard's flag
 * counters are denormalised in a separate computation; unit-level
 * tests of the action alone would not catch a regression where
 * the action writes the row correctly but the dashboard read path
 * misses it. The cases here drive the full round-trip and assert
 * both the row-level state and the dashboard-visible counter at
 * each lifecycle stage.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext } from "../helpers/context";
import { action } from "../../app/routes/api.qc-flags";
import { getProjectVolumes } from "../../app/lib/volumes.server";

type Db = ReturnType<typeof drizzle>;

function buildUser(overrides: {
  id: string;
  email: string;
  isAdmin?: boolean;
  tenantId?: string;
}): User {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    email: overrides.email,
    name: null,
    isAdmin: overrides.isAdmin ?? false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
  };
}

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function readJson(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

async function seedFixture(db: Db) {
  const now = Date.now();

  const leadRow = await createTestUser({
    email: `lead-${crypto.randomUUID()}@example.com`,
  });
  const catRow = await createTestUser({
    email: `cat-${crypto.randomUUID()}@example.com`,
  });

  const projectId = crypto.randomUUID();
  const volumeId = crypto.randomUUID();
  const pageG1 = crypto.randomUUID();
  const pageG2 = crypto.randomUUID();

  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "QC Lifecycle P1",
    createdBy: leadRow.id,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.projectMembers).values([
    {
      id: crypto.randomUUID(),
      projectId,
      userId: leadRow.id,
      role: "lead",
      createdAt: now,
    },
    {
      id: crypto.randomUUID(),
      projectId,
      userId: catRow.id,
      role: "cataloguer",
      createdAt: now,
    },
  ]);

  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "V1",
    referenceCode: "co-lifecycle-v1",
    manifestUrl: "https://example.com/manifest.json",
    pageCount: 2,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.volumePages).values([
    {
      id: pageG1,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 1,
      imageUrl: "https://example.com/g1.jpg",
      width: 800,
      height: 1200,
      label: "f.1r",
      createdAt: now,
    },
    {
      id: pageG2,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 2,
      imageUrl: "https://example.com/g2.jpg",
      width: 800,
      height: 1200,
      label: "f.1v",
      createdAt: now,
    },
  ]);

  return {
    lead: buildUser({ id: leadRow.id, email: leadRow.email }),
    cat: buildUser({ id: catRow.id, email: catRow.email }),
    projectId,
    volumeId,
    pageG1,
    pageG2,
  };
}

async function postFlag(
  user: User,
  body: Record<string, unknown>
): Promise<Response> {
  const request = new Request("http://localhost/api/qc-flags", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return (await action({
    request,
    context: buildContext(user),
    params: {},
  } as any)) as Response;
}

async function patchFlag(
  user: User,
  body: Record<string, unknown>
): Promise<Response> {
  const request = new Request("http://localhost/api/qc-flags", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return (await action({
    request,
    context: buildContext(user),
    params: {},
  } as any)) as Response;
}

describe("QC flags lifecycle - raise, list, resolve, count, activity_log", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("exercises the full raise and resolve lifecycle with count and activity log", async () => {
    const fx = await seedFixture(db);

    // Step 1 — raise as cataloguer
    const raiseRes = await postFlag(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageG1,
      problemType: "damaged",
      description: "tear along lower margin",
    });
    expect(raiseRes.status).toBe(200);
    const { flagId } = await readJson(raiseRes);
    expect(typeof flagId).toBe("string");

    // Step 2 — row state matches
    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, flagId))
      .all();
    expect(row.status).toBe("open");
    expect(row.volumeId).toBe(fx.volumeId);
    expect(row.pageId).toBe(fx.pageG1);
    expect(row.reportedBy).toBe(fx.cat.id);
    expect(row.problemType).toBe("damaged");

    // Step 3 — volume overview shows openQcFlagCount = 1
    let volumes = await getProjectVolumes(db, fx.projectId);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].id).toBe(fx.volumeId);
    expect(volumes[0].openQcFlagCount).toBe(1);

    // Step 4 — activity_log carries qc_flag_raised with the flag id
    const raiseEvents = await db
      .select()
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.event, "qc_flag_raised"),
          eq(schema.activityLog.projectId, fx.projectId),
          eq(schema.activityLog.volumeId, fx.volumeId)
        )
      )
      .all();
    expect(raiseEvents).toHaveLength(1);
    const raiseDetail = JSON.parse(raiseEvents[0].detail ?? "{}");
    expect(raiseDetail.flagId).toBe(flagId);
    expect(raiseDetail.pageId).toBe(fx.pageG1);
    expect(raiseDetail.problemType).toBe("damaged");

    // Step 5 — cataloguer tries to resolve: 403
    const catResolve = await patchFlag(fx.cat, {
      flagId,
      status: "resolved",
      resolutionAction: "retake_requested",
    });
    expect(catResolve.status).toBe(403);

    // Step 6 — volume status is unchanged
    const [volumeBefore] = await db
      .select({ status: schema.volumes.status })
      .from(schema.volumes)
      .where(eq(schema.volumes.id, fx.volumeId))
      .all();
    expect(volumeBefore.status).toBe("in_progress");

    // Step 7 — lead resolves with retake_requested
    const leadResolve = await patchFlag(fx.lead, {
      flagId,
      status: "resolved",
      resolutionAction: "retake_requested",
    });
    expect(leadResolve.status).toBe(200);

    // Step 8 — row transitions cleanly
    const [resolvedRow] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, flagId))
      .all();
    expect(resolvedRow.status).toBe("resolved");
    expect(resolvedRow.resolutionAction).toBe("retake_requested");
    expect(resolvedRow.resolvedBy).toBe(fx.lead.id);
    expect(typeof resolvedRow.resolvedAt).toBe("number");

    // Step 9 — openQcFlagCount drops back to 0
    volumes = await getProjectVolumes(db, fx.projectId);
    expect(volumes).toHaveLength(1);
    expect(volumes[0].openQcFlagCount).toBe(0);

    // Step 10 — activity_log now carries qc_flag_resolved as well
    const resolveEvents = await db
      .select()
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.event, "qc_flag_resolved"),
          eq(schema.activityLog.projectId, fx.projectId),
          eq(schema.activityLog.volumeId, fx.volumeId)
        )
      )
      .all();
    expect(resolveEvents).toHaveLength(1);
    const resolveDetail = JSON.parse(resolveEvents[0].detail ?? "{}");
    expect(resolveDetail.flagId).toBe(flagId);
    expect(resolveDetail.resolutionAction).toBe("retake_requested");
    expect(resolveDetail.status).toBe("resolved");

    // Step 11 — volume status STILL unchanged after resolve
    const [volumeAfter] = await db
      .select({ status: schema.volumes.status })
      .from(schema.volumes)
      .where(eq(schema.volumes.id, fx.volumeId))
      .all();
    expect(volumeAfter.status).toBe("in_progress");
  });

  it("persists resolver_note when resolution_action='other'", async () => {
    const fx = await seedFixture(db);

    // Raise a second-style flag with problemType='other' + description
    const raiseRes = await postFlag(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageG2,
      problemType: "other",
      description: "colour cast on scan",
    });
    expect(raiseRes.status).toBe(200);
    const { flagId } = await readJson(raiseRes);

    const note = "ran a post-capture colour correction pass";
    const resolveRes = await patchFlag(fx.lead, {
      flagId,
      status: "resolved",
      resolutionAction: "other",
      resolverNote: note,
    });
    expect(resolveRes.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.qcFlags)
      .where(eq(schema.qcFlags.id, flagId))
      .all();
    expect(row.resolutionAction).toBe("other");
    expect(row.resolverNote).toBe(note);
  });

  it("returns 409 on the second resolve attempt for the same flag", async () => {
    const fx = await seedFixture(db);

    const raiseRes = await postFlag(fx.cat, {
      volumeId: fx.volumeId,
      pageId: fx.pageG1,
      problemType: "missing",
      description: "page jumps from fol. 3 to fol. 5",
    });
    const { flagId } = await readJson(raiseRes);

    const first = await patchFlag(fx.lead, {
      flagId,
      status: "resolved",
      resolutionAction: "retake_requested",
    });
    expect(first.status).toBe(200);

    const second = await patchFlag(fx.lead, {
      flagId,
      status: "wontfix",
      resolutionAction: "ignored",
    });
    expect(second.status).toBe(409);
  });
});

