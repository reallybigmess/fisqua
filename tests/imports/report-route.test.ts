/**
 * Tests - /admin/imports/uploads/:uploadId report route + download loader
 *
 * Pins the report surface: capability gating (imports off -> 404), the
 * run-a-dry-run action (writes artefacts, stamps the pointer, redirects),
 * the loader reading the report back, and the download loader streaming the
 * rejects CSV and report JSON. Tenant scoping is the load-bearing negative:
 * a second tenant cannot fetch the first tenant's artefacts even with the
 * exact upload id, because the upload is resolved tenant-scoped and the
 * staging key is derived from the tenant id.
 *
 * The staging store is mocked to a shared in-memory backing (the real R2
 * binding cannot be written under the Workers pool), so the runner, the
 * loader, and the download loader all see the same artefacts.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DACS_TEST_TENANT_ID,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { createUpload } from "../../app/lib/import/uploads.server";
import { createProfile } from "../../app/lib/import/profiles.server";
import { stagingKey } from "../../app/lib/import/staging.server";
import { parseCsv } from "../../app/lib/import/csv";
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
const DOWNLOAD_ROUTE =
  "../../app/routes/_auth.admin.imports.uploads.$uploadId.download.$kind";

function db() {
  return drizzle(env.DB);
}

function ctx(user: User, tenantId: string, importsEnabled: boolean): any {
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

async function stageUpload(tenantId: string, userId: string): Promise<string> {
  const uploadId = crypto.randomUUID();
  const csv = makeSbmalCsv([
    ...SBMAL_REAL_ROWS,
    { ...SBMAL_REAL_ROWS[0], Reference_Code: "" }, // one reject to fill the CSV
  ]);
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
  return uploadId;
}

async function makeProfile(tenantId: string, userId: string): Promise<string> {
  const res = await createProfile(db(), {
    tenantId,
    standard: "isadg",
    name: "SBMAL DACS",
    bindings: SBMAL_DACS_BINDINGS,
    sharedWithFederation: false,
    userId,
  });
  if (!res.ok) throw new Error("profile create failed: " + JSON.stringify(res));
  return res.id;
}

function req(uploadId: string, form: FormData): Request {
  return new Request(
    `http://neogranadina.fisqua.test/admin/imports/uploads/${uploadId}`,
    { method: "POST", body: form },
  );
}

/** The Check step's profile-selection intent (design §3.1). */
function selectProfile(uploadId: string, profileId: string): Request {
  const form = new FormData();
  form.set("intent", "selectProfile");
  form.set("profileId", profileId);
  return req(uploadId, form);
}

/** The dry-run intent — the profile is already pinned by `selectProfile`. */
function post(uploadId: string, _profileId: string, updateExisting = false): Request {
  const form = new FormData();
  form.set("intent", "run");
  if (updateExisting) form.set("updateExisting", "on");
  return req(uploadId, form);
}

/** Pick the profile at the Check step, then run the dry run (the journey). */
async function selectThenRun(
  uploadId: string,
  profileId: string,
  user: User,
  tenantId: string,
  updateExisting = false,
): Promise<Response> {
  const { action } = await import(REPORT_ROUTE);
  await action({
    request: selectProfile(uploadId, profileId),
    context: ctx(user, tenantId, true),
    params: { uploadId },
  } as any);
  return (await action({
    request: post(uploadId, profileId, updateExisting),
    context: ctx(user, tenantId, true),
    params: { uploadId },
  } as any)) as Response;
}

describe("report route - gating", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  it("404s the loader when imports is off", async () => {
    const user = await adminFor(DEFAULT_TEST_TENANT_ID);
    const { loader } = await import(REPORT_ROUTE);
    try {
      await loader({
        request: new Request("http://x/admin/imports/uploads/none"),
        context: ctx(user, DEFAULT_TEST_TENANT_ID, false),
        params: { uploadId: "none" },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });
});

describe("report route - run + read", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  it("runs a dry-run, stamps the pointer, and the loader reads the report", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const profileId = await makeProfile(tenantId, user.id);

    const { loader } = await import(REPORT_ROUTE);
    const res = await selectThenRun(uploadId, profileId, user, tenantId);
    // Redirect to the dry-run step of the journey.
    expect(res.status).toBe(302);

    const data = (await loader({
      request: new Request(`http://x/admin/imports/uploads/${uploadId}`),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any)) as any;
    expect(data.report).not.toBeNull();
    expect(data.report.counts.creates).toBe(8);
    expect(data.report.counts.rejects).toBe(1);
    expect(data.report.rejects[0].reason).toBe("missing_reference_code");
  });

  it("still loads the journey read-only for a discarded upload (the Finished View)", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const { discardUpload } = await import("../../app/lib/import/uploads.server");
    expect(await discardUpload(db(), tenantId, uploadId)).toBe(true);

    const { loader } = await import(REPORT_ROUTE);
    const data = (await loader({
      request: new Request(`http://x/admin/imports/uploads/${uploadId}`),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any)) as any;
    expect(data.upload.status).toBe("discarded");
    // No profile was ever chosen, so the check pane has nothing to compute
    // and the journey renders as a record, not a form.
    expect(data.currentProfile).toBeNull();
    expect(data.check).toBeNull();
  });

  it("renders the read-only journey when the staged object is gone and no cache exists", async () => {
    // The delete flow's partial-failure window: a discarded upload whose
    // staged object is already gone. The journey must render (no 500) and
    // must not compute-and-cache on a read-only surface.
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const profileId = await makeProfile(tenantId, user.id);

    const { action, loader } = await import(REPORT_ROUTE);
    await action({
      request: selectProfile(uploadId, profileId),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any);
    const { discardUpload, getUpload } = await import(
      "../../app/lib/import/uploads.server"
    );
    expect(await discardUpload(db(), tenantId, uploadId)).toBe(true);
    stagingMem.delete(stagingKey.upload(tenantId, uploadId));

    const data = (await loader({
      request: new Request(`http://x/admin/imports/uploads/${uploadId}`),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any)) as any;
    expect(data.upload.status).toBe("discarded");
    expect(data.check).toBeNull();

    // No write on the read-only surface: the cache column stays empty.
    const row = await getUpload(db(), tenantId, uploadId);
    expect(row!.checkFindings).toBeNull();
  });

  it("renders a discarded upload's check from the pinned cache, never the staged object", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const profileId = await makeProfile(tenantId, user.id);

    const { action, loader } = await import(REPORT_ROUTE);
    await action({
      request: selectProfile(uploadId, profileId),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any);
    // A staged-upload loader visit computes and caches the findings.
    await loader({
      request: new Request(`http://x/admin/imports/uploads/${uploadId}`),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any);

    const { discardUpload } = await import("../../app/lib/import/uploads.server");
    expect(await discardUpload(db(), tenantId, uploadId)).toBe(true);
    // Remove the staged object: the cache is the only possible source now.
    stagingMem.delete(stagingKey.upload(tenantId, uploadId));

    const data = (await loader({
      request: new Request(`http://x/admin/imports/uploads/${uploadId}`),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any)) as any;
    expect(data.upload.status).toBe("discarded");
    expect(data.check).not.toBeNull();
    // The fixture's blank-reference row surfaces as a blocking finding.
    expect(data.check.findings.length).toBeGreaterThan(0);
  });

  it("refuses a dry-run on a discarded upload with a named error", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const profileId = await makeProfile(tenantId, user.id);

    const { discardUpload } = await import("../../app/lib/import/uploads.server");
    expect(await discardUpload(db(), tenantId, uploadId)).toBe(true);

    const { action } = await import(REPORT_ROUTE);
    const result = (await action({
      request: post(uploadId, profileId),
      context: ctx(user, tenantId, true),
      params: { uploadId },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("notStaged");

    // Nothing ran: no report artefact was written, no pointer stamped.
    const { getUpload } = await import("../../app/lib/import/uploads.server");
    const row = await getUpload(db(), tenantId, uploadId);
    expect(row!.reportArtifact).toBeNull();
  });
});

describe("download loader - streaming + tenant scoping", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  async function runFor(tenantId: string) {
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const profileId = await makeProfile(tenantId, user.id);
    await selectThenRun(uploadId, profileId, user, tenantId);
    return { user, uploadId };
  }

  it("streams the rejects CSV and the report JSON", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const { user, uploadId } = await runFor(tenantId);
    const { loader } = await import(DOWNLOAD_ROUTE);

    const rejects = (await loader({
      request: new Request("http://x"),
      context: ctx(user, tenantId, true),
      params: { uploadId, kind: "rejects" },
    } as any)) as Response;
    expect(rejects.headers.get("content-type")).toContain("text/csv");
    expect(rejects.headers.get("content-disposition")).toContain("needs_review.csv");
    expect(await rejects.text()).toContain("_reason");

    const report = (await loader({
      request: new Request("http://x"),
      context: ctx(user, tenantId, true),
      params: { uploadId, kind: "report" },
    } as any)) as Response;
    expect(report.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(await report.text()).reportVersion).toBe(1);
  });

  it("404s an unknown artefact kind", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const { user, uploadId } = await runFor(tenantId);
    const { loader } = await import(DOWNLOAD_ROUTE);
    try {
      await loader({
        request: new Request("http://x"),
        context: ctx(user, tenantId, true),
        params: { uploadId, kind: "secrets" },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect((e as Response).status).toBe(404);
    }
  });

  it("refuses one tenant's artefacts to another tenant (scoping)", async () => {
    const ownerTenant = DEFAULT_TEST_TENANT_ID;
    const { uploadId } = await runFor(ownerTenant);

    // A second tenant's admin asks for the SAME upload id -> the upload is
    // resolved tenant-scoped, so it is not found and 404s.
    const intruder = await adminFor(SECOND_TEST_TENANT_ID);
    const { loader } = await import(DOWNLOAD_ROUTE);
    try {
      await loader({
        request: new Request("http://x"),
        context: ctx(intruder, SECOND_TEST_TENANT_ID, true),
        params: { uploadId, kind: "rejects" },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect((e as Response).status).toBe(404);
    }
  });
});

describe("commit gate - the gate must hold at commit time (belt-and-braces)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
  });

  function dacsCtx(user: User): any {
    const c = new RouterContextProvider();
    c.set(userContext, user);
    c.set(
      tenantContext,
      makeTenantContext({
        id: DACS_TEST_TENANT_ID,
        importsEnabled: true,
        descriptiveStandard: "dacs",
      }),
    );
    (c as any).cloudflare = { env };
    return c;
  }

  it("refuses a commit posted after accept -> dry-run -> undo (decisions pending)", async () => {
    // Under DACS every SBMAL item is missing extent — one decision class.
    const tenantId = DACS_TEST_TENANT_ID;
    const user = await adminFor(tenantId);
    const uploadId = await stageUpload(tenantId, user.id);
    const repo = await createTestRepository({ tenantId });
    const profileRes = await createProfile(db(), {
      tenantId,
      standard: "dacs",
      name: "SBMAL DACS",
      bindings: SBMAL_DACS_BINDINGS,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!profileRes.ok) throw new Error("profile create failed");

    const { action, loader } = await import(REPORT_ROUTE);
    const post = async (form: FormData) =>
      action({
        request: req(uploadId, form),
        context: dacsCtx(user),
        params: { uploadId },
      } as any);

    // Pick the profile at the Check step, then read the decision key.
    const selectForm = new FormData();
    selectForm.set("intent", "selectProfile");
    selectForm.set("profileId", profileRes.id);
    await post(selectForm);
    const data = (await loader({
      request: new Request(`http://x/admin/imports/uploads/${uploadId}`),
      context: dacsCtx(user),
      params: { uploadId },
    } as any)) as any;
    const decision = data.check.findings.find((f: any) => f.kind === "decision");
    expect(decision).toBeDefined();

    // Accept, run the dry-run (gate open), then UNDO the acceptance.
    const acceptForm = new FormData();
    acceptForm.set("intent", "accept");
    acceptForm.set("findingKey", decision.key);
    await post(acceptForm);
    const runForm = new FormData();
    runForm.set("intent", "run");
    const runRes = (await post(runForm)) as Response;
    expect(runRes.status).toBe(302);
    const undoForm = new FormData();
    undoForm.set("intent", "undo");
    undoForm.set("findingKey", decision.key);
    await post(undoForm);

    // A raw commit POST must be refused: the report exists and the profile
    // matches, but a decision the report ran under is pending again.
    const commitForm = new FormData();
    commitForm.set("intent", "commit");
    commitForm.set("repositoryId", repo.id);
    commitForm.set("message", "SBMAL import (gate test)");
    const result = (await post(commitForm)) as any;
    expect(result.ok).toBe(false);
    expect(result.intent).toBe("commit");
    expect(result.error).toBe("decisionsPending");

    // Nothing was minted; the upload is still staged.
    const { getUpload } = await import("../../app/lib/import/uploads.server");
    const row = await getUpload(db(), tenantId, uploadId);
    expect(row!.status).toBe("staged");
  });
});
