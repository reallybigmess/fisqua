/**
 * Tests — revert action + run-scoped report download (spec §4)
 *
 * Pins the run-detail route's revert intent (the gated compensating act)
 * and the revert report download loader:
 *   - revert gating: a non-complete target is refused (`notComplete`); an
 *     already-reverted target is refused (`alreadyReverted`); an empty
 *     message is refused (`messageRequired`); a valid revert mints the
 *     kind='revert' run, stamps the target's reverted_by_run_id, and
 *     launches the Workflow under a target-derived deterministic instance
 *     id. A second revert of the same target mints nothing, launches
 *     nothing, and errors by name — the double-submit defence.
 *   - authorisation: the action rejects a non-admin (403) and a tenant
 *     without the imports capability (404); a cross-tenant target id 404s.
 *   - the report loader streams a revert run's report tenant-scoped, and a
 *     cross-tenant run id 404s.
 *
 * The staging store is mocked to a shared in-memory backing and the
 * IMPORT_REVERT Workflow binding is stubbed, so no Workflow actually runs.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { stagingKey } from "../../app/lib/import/staging.server";
import { stewardshipRuns } from "../../app/db/schema";

const stagingMem = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("~/lib/import/staging.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/lib/import/staging.server")>();
  return {
    ...actual,
    getStagingStore: () => ({
      put: async (key: string, body: unknown) => {
        stagingMem.set(
          key,
          typeof body === "string" ? new TextEncoder().encode(body) : (body as Uint8Array),
        );
      },
      getBytes: async (key: string) => stagingMem.get(key) ?? null,
      head: async (key: string) => {
        const b = stagingMem.get(key);
        return b ? { size: b.byteLength } : null;
      },
      exists: async (key: string) => stagingMem.has(key),
      delete: async (key: string) => {
        stagingMem.delete(key);
      },
    }),
  };
});

const RUN_DETAIL_ROUTE = "../../app/routes/_auth.admin.imports.runs.$runId";
const REPORT_ROUTE = "../../app/routes/_auth.admin.imports.runs.$runId.report";

function db() {
  return drizzle(env.DB);
}

interface RevertCtx {
  context: any;
  workflowCreate: ReturnType<typeof vi.fn>;
  settle: () => Promise<void>;
}

function revertCtx(user: User, tenantId: string): RevertCtx {
  const workflowCreate = vi.fn().mockResolvedValue(undefined);
  const promises: Promise<unknown>[] = [];
  const testEnv = new Proxy(env as any, {
    get(target, prop) {
      if (prop === "IMPORT_REVERT") return { create: workflowCreate };
      return target[prop];
    },
  });
  const c = new RouterContextProvider();
  c.set(userContext, user);
  c.set(tenantContext, makeTenantContext({ id: tenantId, importsEnabled: true }));
  (c as any).cloudflare = {
    env: testEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => promises.push(p) },
  };
  return { context: c, workflowCreate, settle: async () => void (await Promise.all(promises)) };
}

function loaderCtx(user: User, tenantId: string, importsEnabled = true): any {
  const c = new RouterContextProvider();
  c.set(userContext, user);
  c.set(tenantContext, makeTenantContext({ id: tenantId, importsEnabled }));
  (c as any).cloudflare = { env };
  return c;
}

async function adminFor(tenantId: string): Promise<User> {
  const u = await createTestUser({ isAdmin: true, tenantId });
  return makeUserContext({ id: u.id, tenantId, isAdmin: true });
}

/** Insert a stewardship run row directly (no pipeline needed for gating). */
async function makeRun(opts: {
  tenantId: string;
  userId: string;
  kind?: "import" | "revert";
  status?: "pending" | "running" | "complete" | "error";
  revertedByRunId?: string | null;
  reportArtifact?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db()
    .insert(stewardshipRuns)
    .values({
      id,
      tenantId: opts.tenantId,
      kind: opts.kind ?? "import",
      message: "target run",
      userId: opts.userId,
      status: opts.status ?? "complete",
      revertedByRunId: opts.revertedByRunId ?? null,
      reportArtifact: opts.reportArtifact ?? null,
      createdAt: Date.now(),
    });
  return id;
}

function revertForm(fields: Record<string, string>): Request {
  const form = new FormData();
  form.set("intent", "revert");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://neogranadina.fisqua.test/admin/imports/runs/x", {
    method: "POST",
    body: form,
  });
}

describe("revert action — gating", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  it("refuses an empty revert message", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const runId = await makeRun({ tenantId, userId: user.id });
    const { action } = await import(RUN_DETAIL_ROUTE);
    const rc = revertCtx(user, tenantId);
    const result = (await action({
      request: revertForm({ message: "   " }),
      context: rc.context,
      params: { runId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("messageRequired");
    expect(rc.workflowCreate).not.toHaveBeenCalled();
  });

  it("refuses a target that is not complete", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const runId = await makeRun({ tenantId, userId: user.id, status: "running" });
    const { action } = await import(RUN_DETAIL_ROUTE);
    const rc = revertCtx(user, tenantId);
    const result = (await action({
      request: revertForm({ message: "Revert it" }),
      context: rc.context,
      params: { runId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("notComplete");
    expect(rc.workflowCreate).not.toHaveBeenCalled();
  });

  it("refuses a target already reverted", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const runId = await makeRun({ tenantId, userId: user.id, revertedByRunId: crypto.randomUUID() });
    const { action } = await import(RUN_DETAIL_ROUTE);
    const rc = revertCtx(user, tenantId);
    const result = (await action({
      request: revertForm({ message: "Revert it" }),
      context: rc.context,
      params: { runId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("alreadyReverted");
    expect(rc.workflowCreate).not.toHaveBeenCalled();
  });

  it("mints the revert run, stamps the target, and launches the Workflow", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const targetId = await makeRun({ tenantId, userId: user.id });
    const { action } = await import(RUN_DETAIL_ROUTE);
    const rc = revertCtx(user, tenantId);
    const res = (await action({
      request: revertForm({ message: "Reverting the diezmos import", justification: "wrong profile" }),
      context: rc.context,
      params: { runId: targetId },
    } as any)) as Response;
    await rc.settle();

    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/admin\/imports\/runs\/[0-9a-f-]+$/);
    const revertRunId = location.split("/").pop()!;

    const revertRun = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, revertRunId))
      .get();
    expect(revertRun!.kind).toBe("revert");
    expect(revertRun!.message).toBe("Reverting the diezmos import");
    expect(revertRun!.revertsRunId).toBe(targetId);
    expect(revertRun!.userId).toBe(user.id);

    const target = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, targetId))
      .get();
    expect(target!.revertedByRunId).toBe(revertRunId);

    expect(rc.workflowCreate).toHaveBeenCalledTimes(1);
    const arg = rc.workflowCreate.mock.calls[0][0];
    expect(arg.id).toBe(`revert-${targetId}`);
    expect(arg.params).toMatchObject({ runId: revertRunId });
  });

  it("a second revert of the same target mints nothing, launches nothing, errors by name", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const targetId = await makeRun({ tenantId, userId: user.id });
    const { action } = await import(RUN_DETAIL_ROUTE);

    const first = revertCtx(user, tenantId);
    const res1 = (await action({
      request: revertForm({ message: "First revert" }),
      context: first.context,
      params: { runId: targetId },
    } as any)) as Response;
    await first.settle();
    expect(res1.status).toBe(302);
    expect(first.workflowCreate).toHaveBeenCalledTimes(1);

    const second = revertCtx(user, tenantId);
    const res2 = (await action({
      request: revertForm({ message: "Second revert" }),
      context: second.context,
      params: { runId: targetId },
    } as any)) as any;
    await second.settle();
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe("alreadyReverted");
    expect(second.workflowCreate).not.toHaveBeenCalled();

    const revertRuns = await db()
      .select({ id: stewardshipRuns.id })
      .from(stewardshipRuns)
      .where(and(eq(stewardshipRuns.tenantId, tenantId), eq(stewardshipRuns.kind, "revert")))
      .all();
    expect(revertRuns).toHaveLength(1);
  });
});

describe("revert action — authorisation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  it("rejects a non-admin with 403", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const admin = await adminFor(tenantId);
    const runId = await makeRun({ tenantId, userId: admin.id });
    const nonAdmin = makeUserContext({ id: admin.id, tenantId, isAdmin: false });
    const { action } = await import(RUN_DETAIL_ROUTE);
    const rc = revertCtx(nonAdmin, tenantId);
    try {
      await action({
        request: revertForm({ message: "Revert it" }),
        context: rc.context,
        params: { runId },
      } as any);
      expect.fail("should have thrown 403");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("404s when the imports capability is off", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const runId = await makeRun({ tenantId, userId: user.id });
    // A revert ctx but with imports disabled on the tenant.
    const workflowCreate = vi.fn();
    const c = new RouterContextProvider();
    c.set(userContext, user);
    c.set(tenantContext, makeTenantContext({ id: tenantId, importsEnabled: false }));
    (c as any).cloudflare = {
      env: new Proxy(env as any, {
        get: (t, p) => (p === "IMPORT_REVERT" ? { create: workflowCreate } : t[p]),
      }),
      ctx: { waitUntil: () => {} },
    };
    const { action } = await import(RUN_DETAIL_ROUTE);
    try {
      await action({
        request: revertForm({ message: "Revert it" }),
        context: c,
        params: { runId },
      } as any);
      expect.fail("should have thrown 404");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  it("404s a cross-tenant target id (never reverts another tenant's run)", async () => {
    const otherRunId = await makeRun({
      tenantId: SECOND_TEST_TENANT_ID,
      userId: (await createTestUser({ isAdmin: true, tenantId: SECOND_TEST_TENANT_ID })).id,
    });
    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { action } = await import(RUN_DETAIL_ROUTE);
    const rc = revertCtx(user, DEFAULT_TEST_TENANT_ID);
    try {
      await action({
        request: revertForm({ message: "Revert it" }),
        context: rc.context,
        params: { runId: otherRunId },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
    // No revert row minted for the acting tenant.
    const runs = await db()
      .select({ id: stewardshipRuns.id })
      .from(stewardshipRuns)
      .where(and(eq(stewardshipRuns.tenantId, DEFAULT_TEST_TENANT_ID), eq(stewardshipRuns.kind, "revert")))
      .all();
    expect(runs).toHaveLength(0);
  });
});

describe("revert report download loader", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  it("streams a revert run's report tenant-scoped", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const runId = crypto.randomUUID();
    const reportKey = stagingKey.revertReport(tenantId, runId);
    stagingMem.set(reportKey, new TextEncoder().encode(JSON.stringify({ reverted: 5, kept: 1 })));
    await db()
      .insert(stewardshipRuns)
      .values({
        id: runId,
        tenantId,
        kind: "revert",
        message: "a revert",
        userId: user.id,
        status: "complete",
        reportArtifact: reportKey,
        createdAt: Date.now(),
      });

    const { loader } = await import(REPORT_ROUTE);
    const res = (await loader({
      request: new Request(`http://x/admin/imports/runs/${runId}/report`),
      context: loaderCtx(user, tenantId),
      params: { runId },
    } as any)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(await res.text());
    expect(body).toMatchObject({ reverted: 5, kept: 1 });
  });

  it("404s a cross-tenant run id", async () => {
    const otherUser = await createTestUser({ isAdmin: true, tenantId: SECOND_TEST_TENANT_ID });
    const runId = crypto.randomUUID();
    const reportKey = stagingKey.revertReport(SECOND_TEST_TENANT_ID, runId);
    stagingMem.set(reportKey, new TextEncoder().encode("{}"));
    await db()
      .insert(stewardshipRuns)
      .values({
        id: runId,
        tenantId: SECOND_TEST_TENANT_ID,
        kind: "revert",
        message: "a revert",
        userId: otherUser.id,
        status: "complete",
        reportArtifact: reportKey,
        createdAt: Date.now(),
      });

    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(REPORT_ROUTE);
    try {
      await loader({
        request: new Request(`http://x/admin/imports/runs/${runId}/report`),
        context: loaderCtx(user, DEFAULT_TEST_TENANT_ID),
        params: { runId },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});
