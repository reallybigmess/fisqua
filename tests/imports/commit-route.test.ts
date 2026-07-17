/**
 * Tests — commit action + run surfaces (spec §5; stewardship spec §2)
 *
 * Pins the report route's commit intent (the gated write act) and the two
 * run surfaces:
 *   - commit gating: a profile that drifted since the dry-run is refused
 *     (`profileStale`), an empty run message is refused (`messageRequired`),
 *     a missing repository is refused (`noRepository`); a valid commit mints
 *     the run, flips the upload to committed, and launches the Workflow
 *     under an upload-derived deterministic instance id. A second commit of
 *     the same upload mints nothing, launches nothing, and errors by name
 *     (`alreadyCommitted`) — the double-submit defence.
 *   - run list + detail loaders: tenant-scoped, so a second tenant's run id
 *     404s on the detail loader and never appears in the first tenant's list.
 *
 * The staging store is mocked to a shared in-memory backing (the real R2
 * binding cannot be written under the Workers pool) and the IMPORT_COMMIT
 * Workflow binding is stubbed, so no Workflow actually runs.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { createUpload } from "../../app/lib/import/uploads.server";
import { createProfile } from "../../app/lib/import/profiles.server";
import { runDryRun } from "../../app/lib/import/dry-run.server";
import { stagingKey, type StagingStore } from "../../app/lib/import/staging.server";
import { importProfiles, importUploads, stewardshipRuns } from "../../app/db/schema";
import { parseCsv } from "../../app/lib/import/csv";
import { parseProfileBindings } from "../../app/lib/import/profile-schema";
import { mintImportRun } from "../../app/lib/import/commit.server";
import { makeSbmalCsv, SBMAL_REAL_ROWS, SBMAL_DACS_BINDINGS, withBom } from "./fixtures";

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

const REPORT_ROUTE = "../../app/routes/_auth.admin.imports.uploads.$uploadId";
const RUNS_ROUTE = "../../app/routes/_auth.admin.imports.runs";
const RUN_DETAIL_ROUTE = "../../app/routes/_auth.admin.imports.runs.$runId";

function db() {
  return drizzle(env.DB);
}

/** The captured waitUntil promises + a stubbed IMPORT_COMMIT.create. */
interface CommitCtx {
  context: any;
  workflowCreate: ReturnType<typeof vi.fn>;
  settle: () => Promise<void>;
}

function commitCtx(user: User, tenantId: string): CommitCtx {
  const workflowCreate = vi.fn().mockResolvedValue(undefined);
  const promises: Promise<unknown>[] = [];
  const testEnv = new Proxy(env as any, {
    get(target, prop) {
      if (prop === "IMPORT_COMMIT") return { create: workflowCreate };
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
  return {
    context: c,
    workflowCreate,
    settle: async () => {
      await Promise.all(promises);
    },
  };
}

/** A read-only ctx (loaders) — cloudflare.env only. */
function ctx(user: User, tenantId: string, importsEnabled = true): any {
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

/** Stage a CSV, make a profile, run the dry-run — leaving a report stamped. */
async function stageWithReport(tenantId: string, userId: string, updateExisting = false) {
  const uploadId = crypto.randomUUID();
  const csv = makeSbmalCsv(SBMAL_REAL_ROWS);
  const bytes = withBom(csv);
  stagingMem.set(stagingKey.upload(tenantId, uploadId), bytes);
  const parsed = parseCsv(csv);
  await createUpload(db(), {
    id: uploadId,
    tenantId,
    userId,
    filename: "sbmal.csv",
    artifactKey: stagingKey.upload(tenantId, uploadId),
    byteSize: bytes.byteLength,
    rowCount: parsed.rowCount,
    headers: parsed.headers,
  });
  const created = await createProfile(db(), {
    tenantId,
    standard: "isadg",
    name: "SBMAL DACS",
    bindings: SBMAL_DACS_BINDINGS,
    sharedWithFederation: false,
    userId,
  });
  if (!created.ok) throw new Error("profile create failed");
  const pb = parseProfileBindings(SBMAL_DACS_BINDINGS);
  if (!pb.success) throw new Error("bindings invalid");
  const { getUpload } = await import("../../app/lib/import/uploads.server");
  const upload = (await getUpload(db(), tenantId, uploadId))!;
  await runDryRun({
    db: db(),
    store: {
      put: async (k: string, b: unknown) =>
        void stagingMem.set(k, typeof b === "string" ? new TextEncoder().encode(b) : (b as Uint8Array)),
      getBytes: async (k: string) => stagingMem.get(k) ?? null,
      head: async () => null,
      exists: async (k: string) => stagingMem.has(k),
      delete: async (k: string) => void stagingMem.delete(k),
    } as unknown as StagingStore,
    tenantId,
    upload,
    profile: { id: created.id, version: created.version, bindings: pb.data },
    standard: "isadg",
    updateExisting,
  });
  return { uploadId, profileId: created.id, profileVersion: created.version };
}

function commitForm(fields: Record<string, string>): Request {
  const form = new FormData();
  form.set("intent", "commit");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://neogranadina.fisqua.test/admin/imports/uploads/x", {
    method: "POST",
    body: form,
  });
}

describe("commit action — gating", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  it("refuses an empty run message", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const repo = await createTestRepository({ tenantId });
    const { uploadId } = await stageWithReport(tenantId, user.id);

    const { action } = await import(REPORT_ROUTE);
    const cc = commitCtx(user, tenantId);
    const result = (await action({
      request: commitForm({ message: "   ", repositoryId: repo.id }),
      context: cc.context,
      params: { uploadId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("messageRequired");
    expect(cc.workflowCreate).not.toHaveBeenCalled();
  });

  it("refuses a missing repository", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    await createTestRepository({ tenantId });
    const { uploadId } = await stageWithReport(tenantId, user.id);

    const { action } = await import(REPORT_ROUTE);
    const cc = commitCtx(user, tenantId);
    const result = (await action({
      request: commitForm({ message: "Real message", repositoryId: "" }),
      context: cc.context,
      params: { uploadId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("noRepository");
  });

  it("refuses a commit when the profile drifted since the dry-run", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const repo = await createTestRepository({ tenantId });
    const { uploadId, profileId } = await stageWithReport(tenantId, user.id);

    // Bump the profile version out from under the stamped report.
    await db()
      .update(importProfiles)
      .set({ version: 99 })
      .where(eq(importProfiles.id, profileId));

    const { action } = await import(REPORT_ROUTE);
    const cc = commitCtx(user, tenantId);
    const result = (await action({
      request: commitForm({ message: "Commit it", repositoryId: repo.id }),
      context: cc.context,
      params: { uploadId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("profileStale");
    expect(cc.workflowCreate).not.toHaveBeenCalled();
  });

  it("mints the run, flips the upload, and launches the Workflow on a valid commit", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const repo = await createTestRepository({ tenantId });
    const { uploadId } = await stageWithReport(tenantId, user.id);

    const { action } = await import(REPORT_ROUTE);
    const cc = commitCtx(user, tenantId);
    const res = (await action({
      request: commitForm({
        message: "ACC diezmos, first import",
        justification: "migration",
        repositoryId: repo.id,
      }),
      context: cc.context,
      params: { uploadId },
    } as any)) as Response;
    await cc.settle();

    // Redirect to the run detail page.
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/admin\/imports\/runs\/[0-9a-f-]+$/);
    const runId = location.split("/").pop()!;

    // Run minted, pending, with the required message + attribution.
    const run = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, runId))
      .get();
    expect(run!.message).toBe("ACC diezmos, first import");
    expect(run!.userId).toBe(user.id);
    expect(run!.tenantId).toBe(tenantId);
    expect(run!.kind).toBe("import");

    // Upload flipped to committed with the run id stamped.
    const upload = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, uploadId))
      .get();
    expect(upload!.status).toBe("committed");
    expect(upload!.runId).toBe(runId);

    // Workflow launched with an UPLOAD-derived deterministic instance id
    // (an upload commits exactly once, so a duplicate create() collides at
    // the Workflows layer too) and the commit inputs.
    expect(cc.workflowCreate).toHaveBeenCalledTimes(1);
    const arg = cc.workflowCreate.mock.calls[0][0];
    expect(arg.id).toBe(`import-${uploadId}`);
    expect(arg.params).toMatchObject({ runId, uploadId, repositoryId: repo.id });
  });

  it("a second commit of the same upload mints nothing, launches nothing, and errors by name", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const repo = await createTestRepository({ tenantId });
    const { uploadId } = await stageWithReport(tenantId, user.id);

    const { action } = await import(REPORT_ROUTE);
    const first = commitCtx(user, tenantId);
    const res1 = (await action({
      request: commitForm({ message: "First submit", repositoryId: repo.id }),
      context: first.context,
      params: { uploadId },
    } as any)) as Response;
    await first.settle();
    expect(res1.status).toBe(302);
    expect(first.workflowCreate).toHaveBeenCalledTimes(1);

    const second = commitCtx(user, tenantId);
    const res2 = (await action({
      request: commitForm({ message: "Second submit", repositoryId: repo.id }),
      context: second.context,
      params: { uploadId },
    } as any)) as any;
    await second.settle();
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe("alreadyCommitted");
    expect(second.workflowCreate).not.toHaveBeenCalled();

    // Exactly one run row exists for the tenant.
    const runs = await db()
      .select({ id: stewardshipRuns.id })
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.tenantId, tenantId))
      .all();
    expect(runs).toHaveLength(1);
  });
});

describe("run surfaces — list + detail loaders", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  async function mintRunFor(tenantId: string): Promise<string> {
    const user = await createTestUser({ isAdmin: true, tenantId });
    const uploadId = crypto.randomUUID();
    const csv = makeSbmalCsv(SBMAL_REAL_ROWS);
    const bytes = withBom(csv);
    stagingMem.set(stagingKey.upload(tenantId, uploadId), bytes);
    const parsed = parseCsv(csv);
    await createUpload(db(), {
      id: uploadId,
      tenantId,
      userId: user.id,
      filename: "sbmal.csv",
      artifactKey: stagingKey.upload(tenantId, uploadId),
      byteSize: bytes.byteLength,
      rowCount: parsed.rowCount,
      headers: parsed.headers,
    });
    const minted = await mintImportRun(db(), {
      tenantId,
      userId: user.id,
      message: `run for ${tenantId}`,
      profileId: "p-x",
      profileVersion: 1,
      sourceArtifact: stagingKey.upload(tenantId, uploadId),
      reportArtifact: stagingKey.report(tenantId, uploadId),
      uploadId,
    });
    if (!minted) throw new Error("mint refused (upload not staged)");
    return minted.runId;
  }

  it("lists only the tenant's own runs", async () => {
    await mintRunFor(DEFAULT_TEST_TENANT_ID);
    await mintRunFor(SECOND_TEST_TENANT_ID);

    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(RUNS_ROUTE);
    const data = (await loader({
      request: new Request("http://x/admin/imports/runs"),
      context: ctx(user, DEFAULT_TEST_TENANT_ID),
      params: {},
    } as any)) as any;
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].message).toBe(`run for ${DEFAULT_TEST_TENANT_ID}`);
  });

  it("run detail 404s a cross-tenant run id", async () => {
    const otherRunId = await mintRunFor(SECOND_TEST_TENANT_ID);
    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(RUN_DETAIL_ROUTE);
    try {
      await loader({
        request: new Request(`http://x/admin/imports/runs/${otherRunId}`),
        context: ctx(user, DEFAULT_TEST_TENANT_ID),
        params: { runId: otherRunId },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("run detail returns the tenant's own run", async () => {
    const runId = await mintRunFor(DEFAULT_TEST_TENANT_ID);
    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(RUN_DETAIL_ROUTE);
    const data = (await loader({
      request: new Request(`http://x/admin/imports/runs/${runId}`),
      context: ctx(user, DEFAULT_TEST_TENANT_ID),
      params: { runId },
    } as any)) as any;
    expect(data.run.id).toBe(runId);
    expect(data.run.uploadId).toBeTruthy();
  });

  it("run detail surfaces pathCacheCapped from record_counts (the cap-and-warn's warn half)", async () => {
    const runId = await mintRunFor(DEFAULT_TEST_TENANT_ID);
    await db()
      .update(stewardshipRuns)
      .set({
        status: "complete",
        recordCounts: JSON.stringify({
          created: 5,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          rejected: 0,
          pathCacheCapped: 3,
        }),
      })
      .where(eq(stewardshipRuns.id, runId));

    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(RUN_DETAIL_ROUTE);
    const data = (await loader({
      request: new Request(`http://x/admin/imports/runs/${runId}`),
      context: ctx(user, DEFAULT_TEST_TENANT_ID),
      params: { runId },
    } as any)) as any;
    expect(data.counts.pathCacheCapped).toBe(3);
  });

  it("404s the run list loader when imports is off", async () => {
    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(RUNS_ROUTE);
    try {
      await loader({
        request: new Request("http://x/admin/imports/runs"),
        context: ctx(user, DEFAULT_TEST_TENANT_ID, false),
        params: {},
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});
