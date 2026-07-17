/**
 * Tests — /admin/imports route (loader + upload/discard/delete action)
 *
 * This suite pins the index route: capability gating on the action, the
 * upload intake contract (encoding validated FIRST — a non-UTF-8 file is
 * rejected by name, stages nothing, and writes NO row; a valid CSV stages,
 * writes a row, and redirects into the journey at Check — the landing is
 * step 1, design §8a), the discard status flip, the hard delete of
 * discarded uploads (row + objects, tenant-scoped, idempotent on a missing
 * object), and the in-progress state lines — derived from the CACHED check
 * columns only, never a recompute, never a write.
 *
 * The staging store is mocked to an in-memory backing: the real
 * miniflare R2 binding cannot be written under the Workers pool because
 * of an isolated-storage teardown bug (see the phase report), so the
 * store seam is replaced here rather than exercising R2 for real.
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
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { importProfiles, importUploads } from "../../app/db/schema";
import { createProfile } from "../../app/lib/import/profiles.server";
import { makeAtomCsv, SAMPLE_ATOM_ROWS, SBMAL_DACS_BINDINGS, withBom } from "./fixtures";
import "../../app/routes/_auth.admin.imports";

// In-memory staging store: keep the upload action off the real R2
// binding (isolated-storage teardown bug in the Workers pool). `mem` is
// hoisted so tests can inspect what the action staged (and that the
// orphan-cleanup path deleted it again).
const stagingMem = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("~/lib/import/staging.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/lib/import/staging.server")>();
  return {
    ...actual,
    getStagingStore: () => ({
      put: async (key: string, body: Uint8Array) => {
        stagingMem.set(key, body);
      },
      getBytes: async (key: string) => stagingMem.get(key) ?? null,
      head: async () => null,
      exists: async (key: string) => stagingMem.has(key),
      delete: async (key: string) => {
        stagingMem.delete(key);
      },
    }),
  };
});

// A togglable failure seam over the real createUpload, for the
// orphan-cleanup test (staged object must not outlive a failed row).
const uploadsSeam = vi.hoisted(() => ({ failNextCreate: false }));
vi.mock("~/lib/import/uploads.server", async (importActual) => {
  const actual = await importActual<typeof import("../../app/lib/import/uploads.server")>();
  return {
    ...actual,
    createUpload: async (
      ...args: Parameters<typeof actual.createUpload>
    ) => {
      if (uploadsSeam.failNextCreate) {
        uploadsSeam.failNextCreate = false;
        throw new Error("simulated row-insert failure");
      }
      return actual.createUpload(...args);
    },
  };
});

const ROUTE = "../../app/routes/_auth.admin.imports";

function buildContext(
  user: User,
  importsEnabled: boolean,
  tenantId: string = DEFAULT_TEST_TENANT_ID,
): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: tenantId, importsEnabled }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function db() {
  return drizzle(env.DB);
}

async function adminUser(): Promise<User> {
  const u = await createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
  return makeUserContext({ id: u.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
}

function uploadRequest(bytes: Uint8Array, filename = "test.csv"): Request {
  const form = new FormData();
  form.set("intent", "upload");
  form.set("file", new File([bytes as BlobPart], filename, { type: "text/csv" }));
  return new Request("http://neogranadina.fisqua.test/admin/imports", {
    method: "POST",
    body: form,
  });
}

describe("/admin/imports action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
    uploadsSeam.failNextCreate = false;
  });

  it("404s the action when imports is off", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const csv = makeAtomCsv(SAMPLE_ATOM_ROWS);
    try {
      await action({
        request: uploadRequest(withBom(csv)),
        context: buildContext(user, false),
        params: {},
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("stages a valid CSV, writes an upload row, and redirects into the journey at Check", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const csv = makeAtomCsv(SAMPLE_ATOM_ROWS);

    const result = (await action({
      request: uploadRequest(withBom(csv), "acc.csv"),
      context: buildContext(user, true),
      params: {},
    } as any)) as Response;

    const rows = await db().select().from(importUploads).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("staged");
    expect(rows[0].filename).toBe("acc.csv");
    expect(rows[0].rowCount).toBe(2);
    expect(JSON.parse(rows[0].headers!)[0]).toBe("legacyId");

    // The landing is step 1 (design §8a): staging redirects to Check.
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(
      `/admin/imports/uploads/${rows[0].id}?step=check`,
    );
  });

  it("rejects a non-UTF-8 file by name, staging nothing and writing no row", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    // Invalid UTF-8 payload.
    const bad = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);

    const result = (await action({
      request: uploadRequest(bad),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("encoding");

    const rows = await db().select().from(importUploads).all();
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty CSV with the empty error", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    // Bytes present (BOM only) but no records -> the empty path, not noFile.
    const result = (await action({
      request: uploadRequest(withBom("")),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("empty");
    expect(await db().select().from(importUploads).all()).toHaveLength(0);
  });

  it("rejects an unterminated quote by name, staging nothing", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const bad = new TextEncoder().encode('a,b\n"unclosed,1\n2,3\n');
    const result = (await action({
      request: uploadRequest(bad),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unterminatedQuote");
    expect(await db().select().from(importUploads).all()).toHaveLength(0);
    expect(stagingMem.size).toBe(0);
  });

  it("rejects duplicated headers by name, carrying the header names", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const bad = new TextEncoder().encode("title,title,id\n1,2,3\n");
    const result = (await action({
      request: uploadRequest(bad),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicateHeaders");
    expect(result.errorParams).toEqual({ headers: "title" });
    expect(await db().select().from(importUploads).all()).toHaveLength(0);
    expect(stagingMem.size).toBe(0);
  });

  it("rejects a header-only CSV (0 data rows) with the empty error", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const headerOnly = makeAtomCsv([]);
    const result = (await action({
      request: uploadRequest(withBom(headerOnly)),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("empty");
    expect(await db().select().from(importUploads).all()).toHaveLength(0);
    expect(stagingMem.size).toBe(0);
  });

  it("deletes the staged object when the metadata row insert fails", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    uploadsSeam.failNextCreate = true;
    const csv = makeAtomCsv(SAMPLE_ATOM_ROWS);
    const result = (await action({
      request: uploadRequest(withBom(csv)),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("uploadFailed");
    // No orphan: the staged object was cleaned up, and no row exists.
    expect(stagingMem.size).toBe(0);
    expect(await db().select().from(importUploads).all()).toHaveLength(0);
  });

  it("discards a staged upload", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const csv = makeAtomCsv(SAMPLE_ATOM_ROWS);
    await action({
      request: uploadRequest(withBom(csv)),
      context: buildContext(user, true),
      params: {},
    } as any);
    const staged = await db().select().from(importUploads).all();
    const uploadId = staged[0].id;

    const form = new FormData();
    form.set("intent", "discard");
    form.set("uploadId", uploadId);
    const discardReq = new Request("http://neogranadina.fisqua.test/admin/imports", {
      method: "POST",
      body: form,
    });
    const result = (await action({
      request: discardReq,
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(true);

    const row = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, uploadId))
      .get();
    expect(row!.status).toBe("discarded");
  });
});

describe("/admin/imports loader", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns pipeline rows, profiles, and target fields when imports is on", async () => {
    const user = await adminUser();
    const { loader } = await import(ROUTE);
    const data = (await loader({
      request: new Request("http://neogranadina.fisqua.test/admin/imports"),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(data.inProgress).toEqual([]);
    expect(data.finished).toEqual([]);
    expect(data.ownProfiles).toEqual([]);
    expect(data.sharedProfiles).toEqual([]);
    expect(data.targetFields).toContain("referenceCode");
  });

  /** Stage one upload through the action; returns the new upload id. */
  async function stageOne(user: User): Promise<string> {
    const { action } = await import(ROUTE);
    const res = (await action({
      request: uploadRequest(withBom(makeAtomCsv(SAMPLE_ATOM_ROWS))),
      context: buildContext(user, true),
      params: {},
    } as any)) as Response;
    return res.headers.get("location")!.match(/uploads\/([^?]+)/)![1];
  }

  /** A real profile row, so the landing's live-version map resolves it. */
  async function makeLiveProfile(userId: string): Promise<string> {
    const res = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "SBMAL DACS",
      bindings: SBMAL_DACS_BINDINGS,
      sharedWithFederation: false,
      userId,
    });
    if (!res.ok) throw new Error("profile create failed");
    return res.id;
  }

  /** A synthetic findings cache in the module's own shape — no archival data. */
  function cacheJson(profileId: string, profileVersion: number): string {
    return JSON.stringify({
      profileId,
      profileVersion,
      computedAt: 1,
      findings: [
        {
          kind: "decision",
          key: "item::extent",
          classKeys: ["missing_required_field:item:extent"],
          level: "item",
          fields: ["extent"],
          count: 2,
          sampleRows: [1, 2],
          cascadeCount: 0,
        },
      ],
    });
  }

  function acceptedJson(userId: string): string {
    return JSON.stringify([
      {
        key: "item::extent",
        classKeys: ["missing_required_field:item:extent"],
        level: "item",
        fields: ["extent"],
        count: 2,
        cascadeCount: 0,
        acceptedBy: userId,
        acceptedAt: 1,
      },
    ]);
  }

  async function landingData(user: User): Promise<any> {
    const { loader } = await import(ROUTE);
    return loader({
      request: new Request("http://neogranadina.fisqua.test/admin/imports"),
      context: buildContext(user, true),
      params: {},
    } as any);
  }

  it("derives in-progress state lines from the CACHED columns without recomputing", async () => {
    const user = await adminUser();
    const profileId = await makeLiveProfile(user.id);

    const noProfileId = await stageOne(user);
    const pendingId = await stageOne(user);
    const checkedId = await stageOne(user);
    const readyId = await stageOne(user);

    // Profile chosen but never checked (no cache).
    await db()
      .update(importUploads)
      .set({ profileId, profileVersion: 1 })
      .where(eq(importUploads.id, pendingId));
    // Checked, one decision pending.
    await db()
      .update(importUploads)
      .set({ profileId, profileVersion: 1, checkFindings: cacheJson(profileId, 1) })
      .where(eq(importUploads.id, checkedId));
    // Checked, accepted, dry run already run (report pointer set).
    await db()
      .update(importUploads)
      .set({
        profileId,
        profileVersion: 1,
        checkFindings: cacheJson(profileId, 1),
        checkDecisions: acceptedJson(user.id),
        reportArtifact: "staging/report",
      })
      .where(eq(importUploads.id, readyId));

    const data = await landingData(user);
    const byId = new Map(data.inProgress.map((r: any) => [r.id, r]));
    expect((byId.get(noProfileId) as any).stage).toBe("needsProfile");
    expect((byId.get(pendingId) as any).stage).toBe("checkPending");
    const checked = byId.get(checkedId) as any;
    expect(checked.stage).toBe("check");
    expect(checked.decisionsMade).toBe(0);
    expect(checked.decisionsTotal).toBe(1);
    expect((byId.get(readyId) as any).stage).toBe("importReady");

    // NO recompute, NO write: the never-checked row's cache column is
    // still empty after the loader ran.
    const pendingRow = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, pendingId))
      .get();
    expect(pendingRow!.checkFindings).toBeNull();
  });

  it("relegates a live-profile-drifted row to checkPending, never importReady", async () => {
    const user = await adminUser();
    const profileId = await makeLiveProfile(user.id);
    const uploadId = await stageOne(user);

    // Row pinned to v1 with a report — a fully-ready chain under v1.
    await db()
      .update(importUploads)
      .set({
        profileId,
        profileVersion: 1,
        checkFindings: cacheJson(profileId, 1),
        checkDecisions: acceptedJson(user.id),
        reportArtifact: "staging/report",
      })
      .where(eq(importUploads.id, uploadId));

    // The LIVE profile moves to v2: the journey relocks the chain on visit,
    // so the landing must not say "Import ready".
    await db()
      .update(importProfiles)
      .set({ version: 2 })
      .where(eq(importProfiles.id, profileId));

    const data = await landingData(user);
    const row = data.inProgress.find((r: any) => r.id === uploadId);
    expect(row.stage).toBe("checkPending");
  });

  it("degrades corrupt cached JSON to checkPending without writing", async () => {
    const user = await adminUser();
    const profileId = await makeLiveProfile(user.id);
    const uploadId = await stageOne(user);

    await db()
      .update(importUploads)
      .set({
        profileId,
        profileVersion: 1,
        checkFindings: "{corrupt",
        checkDecisions: "[not json",
      })
      .where(eq(importUploads.id, uploadId));

    const data = await landingData(user);
    const row = data.inProgress.find((r: any) => r.id === uploadId);
    expect(row.stage).toBe("checkPending");

    // The corrupt columns pass through untouched — no repair write.
    const after = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, uploadId))
      .get();
    expect(after!.checkFindings).toBe("{corrupt");
    expect(after!.checkDecisions).toBe("[not json");
  });
});

describe("/admin/imports delete action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    stagingMem.clear();
    uploadsSeam.failNextCreate = false;
  });

  async function stagedUploadId(user: User): Promise<string> {
    const { action } = await import(ROUTE);
    const res = (await action({
      request: uploadRequest(withBom(makeAtomCsv(SAMPLE_ATOM_ROWS))),
      context: buildContext(user, true),
      params: {},
    } as any)) as Response;
    return res.headers.get("location")!.match(/uploads\/([^?]+)/)![1];
  }

  function deleteRequest(uploadId: string): Request {
    const form = new FormData();
    form.set("intent", "delete");
    form.set("uploadId", uploadId);
    return new Request("http://neogranadina.fisqua.test/admin/imports", {
      method: "POST",
      body: form,
    });
  }

  it("refuses to delete a staged upload by name", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const uploadId = await stagedUploadId(user);
    const result = (await action({
      request: deleteRequest(uploadId),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("notDiscarded");
    expect(
      await db().select().from(importUploads).where(eq(importUploads.id, uploadId)).get(),
    ).toBeDefined();
  });

  it("refuses to delete a committed upload by name", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const uploadId = await stagedUploadId(user);
    await db()
      .update(importUploads)
      .set({ status: "committed" })
      .where(eq(importUploads.id, uploadId));
    const result = (await action({
      request: deleteRequest(uploadId),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("notDiscarded");
    expect(
      await db().select().from(importUploads).where(eq(importUploads.id, uploadId)).get(),
    ).toBeDefined();
  });

  it("deletes a discarded upload: row, staged object, and report artefact", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const uploadId = await stagedUploadId(user);
    const row = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, uploadId))
      .get();
    expect(stagingMem.has(row!.artifactKey)).toBe(true);
    stagingMem.set("staging/report-key", new Uint8Array([1]));
    await db()
      .update(importUploads)
      .set({ status: "discarded", reportArtifact: "staging/report-key" })
      .where(eq(importUploads.id, uploadId));

    const result = (await action({
      request: deleteRequest(uploadId),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(true);
    expect(
      await db().select().from(importUploads).where(eq(importUploads.id, uploadId)).get(),
    ).toBeUndefined();
    expect(stagingMem.has(row!.artifactKey)).toBe(false);
    expect(stagingMem.has("staging/report-key")).toBe(false);
  });

  it("succeeds when the staged object is already missing (idempotent retry)", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const uploadId = await stagedUploadId(user);
    const row = await db()
      .select()
      .from(importUploads)
      .where(eq(importUploads.id, uploadId))
      .get();
    await db()
      .update(importUploads)
      .set({ status: "discarded" })
      .where(eq(importUploads.id, uploadId));
    // The object is gone (a prior partial delete); the retry must succeed.
    stagingMem.delete(row!.artifactKey);

    const result = (await action({
      request: deleteRequest(uploadId),
      context: buildContext(user, true),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(true);
    expect(
      await db().select().from(importUploads).where(eq(importUploads.id, uploadId)).get(),
    ).toBeUndefined();
  });

  it("404s a delete of another tenant's upload (tenant scoping)", async () => {
    const owner = await adminUser();
    const { action } = await import(ROUTE);
    const uploadId = await stagedUploadId(owner);
    await db()
      .update(importUploads)
      .set({ status: "discarded" })
      .where(eq(importUploads.id, uploadId));

    const intruderUser = await createTestUser({
      isAdmin: true,
      tenantId: SECOND_TEST_TENANT_ID,
    });
    const intruder = makeUserContext({
      id: intruderUser.id,
      tenantId: SECOND_TEST_TENANT_ID,
      isAdmin: true,
    });
    try {
      await action({
        request: deleteRequest(uploadId),
        context: buildContext(intruder, true, SECOND_TEST_TENANT_ID),
        params: {},
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
    // The owner's row survives.
    expect(
      await db().select().from(importUploads).where(eq(importUploads.id, uploadId)).get(),
    ).toBeDefined();
  });
});
