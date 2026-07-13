/**
 * Cross-Tenant Export Isolation
 *
 * This suite is the keystone test for the export-pipeline tenant-scoping contract.
 * Asserts that Tenant A's publish pipeline run never emits Tenant
 * B's rows and never writes R2 objects under Tenant B's slug prefix.
 *
 * An earlier version of the export pipeline had ZERO `tenant`
 * references in its workflow steps and used flat R2 keys
 * (`descriptions-<ref>.json`, `entities.json`, etc.) — a Tenant A
 * superadmin could trigger an export that read Tenant B rows and
 * overwrote Tenant B's R2 objects. The per-tenant R2 prefix
 * promise — and EAD/DC publishing on top of it — depended on
 * closing that gap.
 *
 * The four `it()` blocks below cover:
 *
 *   1. Description body isolation -- Neogranadina's emitted
 *      `descriptions-<ref>.json` body MUST contain only Neogranadina
 *      rows; the second tenant's description ID MUST NOT appear.
 *
 *   2. Slug-prefix scoping -- every R2 key recorded during the
 *      export MUST start with `${neogranadina.slug}/`; no key may be
 *      written under the second tenant's slug prefix.
 *
 *   3. `getFondsList` tenant filter -- a tenant with no published
 *      descriptions returns `[]`, not the second tenant's fonds.
 *
 *   4. Silent-pass guard -- every recorded R2 key starts with
 *      `${tenant.slug}/`. A bare `descriptions-<ref>.json` write
 *      (the pre-plan flat-key shape) fails the assertion. This guard
 *      ensures a future regression that drops the slug prefix is
 *      caught even if the data-leak assertions pass for a different
 *      reason.
 *
 * @version v0.4.2
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import {
  exportFondsDescriptions,
  exportEntities,
  exportPlaces,
  exportRepositories,
} from "../../app/lib/export/pipeline.server";
import { getFondsList } from "../../app/lib/export/fonds-list.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { loader as apiPublishLoader } from "../../app/routes/api.publish";
import { loader as adminPublishLoader } from "../../app/routes/_auth.admin.publish";

/**
 * In-memory ExportStorage stub that records every key + body the
 * pipeline tries to write. Mirrors the surface ExportStorage exposes
 * so the pipeline functions can be called against it without touching
 * a real R2 binding. JSON and XML puts are recorded into the same
 * `puts` array tagged with their content-type so the silent-pass guard
 * can reason about both surfaces uniformly.
 */
class RecordingStorage {
  puts: Array<{ key: string; body: string; contentType: string }> = [];
  async putObject(key: string, body: string): Promise<void> {
    this.puts.push({ key, body, contentType: "application/json" });
  }
  async putObjectXml(key: string, body: string): Promise<void> {
    this.puts.push({ key, body, contentType: "application/xml" });
  }
  async deleteObject(_key: string): Promise<void> {
    /* no-op for this test */
  }
  async putObjectStream(_key: string, _body: ReadableStream): Promise<void> {
    /* no-op for this test */
  }
  async getObjectStream(_key: string): Promise<ReadableStream | null> {
    return null;
  }
  async getObjectHead(_key: string): Promise<{ size: number } | null> {
    return null;
  }
}

const NEOGRANADINA_SLUG = "neogranadina";
const SECOND_TENANT_SLUG = "second-tenant";

const NEOGRANADINA_TENANT = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: NEOGRANADINA_SLUG,
  descriptiveStandard: "isadg" as const,
};
const SECOND_TENANT = {
  id: SECOND_TEST_TENANT_ID,
  federationId: SECOND_TEST_FEDERATION_ID,
  slug: SECOND_TENANT_SLUG,
  descriptiveStandard: "isadg" as const,
};

type Db = ReturnType<typeof drizzle>;

/**
 * Seed one repository + one published fonds-level description per tenant.
 * Reference codes are deliberately distinct so cross-tenant leakage is
 * unambiguously detectable in emitted bodies.
 */
async function seedTwoTenantFixture(db: Db) {
  const now = Date.now();

  const neoRepoId = crypto.randomUUID();
  const secondRepoId = crypto.randomUUID();

  await db.insert(schema.repositories).values([
    {
      id: neoRepoId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      code: "neo-repo",
      name: "Neogranadina Repo",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: secondRepoId,
      tenantId: SECOND_TEST_TENANT_ID,
      code: "second-repo",
      name: "Second Tenant Repo",
      country: "Mexico",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  const neoDescId = "11111111-1111-4111-8111-111111111111";
  const secondDescId = "99999999-9999-4999-8999-999999999999";

  // Neogranadina fonds-level description.
  await db.insert(schema.descriptions).values({
    id: neoDescId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    repositoryId: neoRepoId,
    parentId: null,
    rootDescriptionId: neoDescId,
    descriptionLevel: "fonds",
    referenceCode: "co-neo-fonds",
    localIdentifier: "NEO-001",
    title: "Neogranadina Fonds",
    isPublished: true,
    createdAt: now,
    updatedAt: now,
  });

  // Second-tenant fonds-level description with a DISTINCT reference code.
  await db.insert(schema.descriptions).values({
    id: secondDescId,
    tenantId: SECOND_TEST_TENANT_ID,
    repositoryId: secondRepoId,
    parentId: null,
    rootDescriptionId: secondDescId,
    descriptionLevel: "fonds",
    referenceCode: "mx-second-fonds",
    localIdentifier: "SEC-001",
    title: "Second Tenant Fonds",
    isPublished: true,
    createdAt: now,
    updatedAt: now,
  });

  return { neoDescId, secondDescId, neoRepoId, secondRepoId };
}

describe("Cross-tenant export isolation", () => {
  let db: Db;
  let storage: RecordingStorage;
  let ids: Awaited<ReturnType<typeof seedTwoTenantFixture>>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    storage = new RecordingStorage();
    ids = await seedTwoTenantFixture(db);
  });

  it("emits only Neogranadina rows in Neogranadina's descriptions JSON", async () => {
    await exportFondsDescriptions(
      db,
      storage as unknown as ExportStorage,
      "co-neo-fonds",
      NEOGRANADINA_TENANT,
    );

    // The descriptions body for the Neogranadina fonds must contain
    // the Neogranadina description id and MUST NOT contain the
    // second tenant's description id.
    const descBody = storage.puts.find((p) =>
      p.key.endsWith("descriptions-co-neo-fonds.json"),
    );
    expect(descBody, "expected descriptions body to be written").toBeDefined();
    expect(descBody!.body).toContain(ids.neoDescId);
    expect(descBody!.body).not.toContain(ids.secondDescId);
    expect(descBody!.body).not.toContain("mx-second-fonds");
  });

  it("prefixes every R2 key with the active tenant's slug", async () => {
    await exportFondsDescriptions(
      db,
      storage as unknown as ExportStorage,
      "co-neo-fonds",
      NEOGRANADINA_TENANT,
    );
    await exportRepositories(
      db,
      storage as unknown as ExportStorage,
      NEOGRANADINA_TENANT,
    );
    await exportEntities(
      db,
      storage as unknown as ExportStorage,
      NEOGRANADINA_TENANT,
    );
    await exportPlaces(
      db,
      storage as unknown as ExportStorage,
      NEOGRANADINA_TENANT,
    );

    expect(storage.puts.length).toBeGreaterThan(0);

    // Every recorded key MUST start with the Neogranadina prefix; no
    // key may be written under the second tenant's prefix.
    for (const put of storage.puts) {
      expect(
        put.key.startsWith(`${NEOGRANADINA_SLUG}/`),
        `expected key to start with "${NEOGRANADINA_SLUG}/", got: ${put.key}`,
      ).toBe(true);
      expect(
        put.key.startsWith(`${SECOND_TENANT_SLUG}/`),
        `key must not be written under second tenant prefix: ${put.key}`,
      ).toBe(false);
    }
  });

  it("getFondsList scoped to a tenant with no fonds returns []", async () => {
    // Wipe + re-seed only the second tenant's data; Neogranadina has
    // no rows. getFondsList(neogranadina) MUST return [], not the
    // second tenant's reference code.
    await cleanDatabase();
    const now = Date.now();
    const secondRepoId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: secondRepoId,
      tenantId: SECOND_TEST_TENANT_ID,
      code: "second-repo",
      name: "Second Tenant Repo",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.descriptions).values({
      id: crypto.randomUUID(),
      tenantId: SECOND_TEST_TENANT_ID,
      repositoryId: secondRepoId,
      parentId: null,
      descriptionLevel: "fonds",
      referenceCode: "mx-second-only",
      title: "Second only",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    });

    const neoFonds = await getFondsList(db, NEOGRANADINA_TENANT);
    expect(neoFonds).toEqual([]);

    // Sanity: the second tenant's list still resolves the row.
    const secondFonds = await getFondsList(db, SECOND_TENANT);
    expect(secondFonds).toEqual(["mx-second-only"]);
  });

  it("silent-pass guard: at least three R2 puts each carry tenant.slug", async () => {
    // Run a representative slice of the pipeline so multiple PUT
    // surfaces are exercised. This test fails LOUDLY if any surface
    // (descriptions, repositories, entities, places) regresses to a
    // flat key.
    await exportFondsDescriptions(
      db,
      storage as unknown as ExportStorage,
      "co-neo-fonds",
      NEOGRANADINA_TENANT,
    );
    await exportRepositories(
      db,
      storage as unknown as ExportStorage,
      NEOGRANADINA_TENANT,
    );
    await exportEntities(
      db,
      storage as unknown as ExportStorage,
      NEOGRANADINA_TENANT,
    );
    await exportPlaces(
      db,
      storage as unknown as ExportStorage,
      NEOGRANADINA_TENANT,
    );

    // Three independent surfaces (descriptions + repositories +
    // entities|places) at minimum must have written under the
    // tenant slug prefix. If the test sees fewer than three, a PUT
    // surface silently dropped its slug prefix.
    const slugPrefixed = storage.puts.filter((p) =>
      p.key.startsWith(`${NEOGRANADINA_SLUG}/`),
    );
    expect(
      slugPrefixed.length,
      `expected at least 3 slug-prefixed puts; got ${slugPrefixed.length}: ` +
        storage.puts.map((p) => p.key).join(", "),
    ).toBeGreaterThanOrEqual(3);

    // And no put may be a flat (un-prefixed) key matching the
    // pre-Plan-37-01 shape.
    const flatKeys = storage.puts.filter((p) =>
      /^(descriptions-|children\/|entities|places|repositories|descriptions-index)/.test(
        p.key,
      ),
    );
    expect(
      flatKeys,
      `flat (un-prefixed) keys are a tenant-scoping regression: ${flatKeys
        .map((p) => p.key)
        .join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * Cross-tenant route-loader regression tests.
 *
 * The pipeline-side tenant scoping closed the cross-tenant gap on
 * the publish pipeline's WRITE path (workflow body, R2 keys, D1
 * reads) but the route loaders on `api.publish.tsx` (GET) and
 * `_auth.admin.publish.tsx` were left unscoped in an earlier pass.
 * A Tenant A superadmin could:
 *   - poll GET /api/publish?exportId=<tenant-B-run> and read selected
 *     fonds, recordCounts, errorMessage, timing, and triggering user;
 *   - poll GET /api/publish (no id) and read the 20 most-recent runs
 *     across the platform;
 *   - load /admin/publish and see Tenant B's `activeExport.id` plus
 *     20 rows of cross-tenant history (including triggering emails).
 *
 * These tests seed two tenants with a completed export run each,
 * call each loader under Tenant A's context, and assert no Tenant B
 * row leaks through. They are the read-path mirror of the four
 * write-path tests above.
 */
describe("Cross-tenant export ROUTE-LOADER isolation (review CR-01 + CR-02)", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  /**
   * Seed one user per tenant and one completed exportRun per user.
   * Run ids are static so the assertion messages are easy to read.
   */
  async function seedTwoTenantExportRuns() {
    const now = Date.now();
    const neoUserId = "u-neo-0000-0000-0000-000000000001";
    const secondUserId = "u-sec-0000-0000-0000-000000000002";
    const neoRunId = "11111111-1111-4111-8111-aaaaaaaaaaaa";
    const secondRunId = "22222222-2222-4222-8222-bbbbbbbbbbbb";

    await db.insert(schema.users).values([
      {
        id: neoUserId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        email: "neo-superadmin@example.com",
        name: "Neo Superadmin",
        isAdmin: true,
        isSuperAdmin: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: secondUserId,
        tenantId: SECOND_TEST_TENANT_ID,
        email: "second-superadmin@example.com",
        name: "Second Superadmin",
        isAdmin: true,
        isSuperAdmin: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await db.insert(schema.exportRuns).values([
      {
        id: neoRunId,
        triggeredBy: neoUserId,
        status: "complete",
        selectedFonds: JSON.stringify(["co-neo-fonds"]),
        selectedTypes: JSON.stringify(["descriptions"]),
        stepsCompleted: 6,
        totalSteps: 6,
        startedAt: now - 60_000,
        completedAt: now - 30_000,
        createdAt: now - 60_000,
      },
      {
        id: secondRunId,
        triggeredBy: secondUserId,
        status: "complete",
        selectedFonds: JSON.stringify(["mx-second-fonds"]),
        selectedTypes: JSON.stringify(["descriptions"]),
        stepsCompleted: 6,
        totalSteps: 6,
        startedAt: now - 50_000,
        completedAt: now - 20_000,
        createdAt: now - 50_000,
      },
    ]);

    return { neoUserId, secondUserId, neoRunId, secondRunId };
  }

  function buildLoaderContext(user: User, tenantId: string): any {
    const ctx = new RouterContextProvider();
    ctx.set(userContext, user);
    ctx.set(
      tenantContext,
      makeTenantContext({ id: tenantId, slug: tenantId === DEFAULT_TEST_TENANT_ID ? "neogranadina" : "second-tenant" })
    );
    (ctx as any).cloudflare = { env };
    return ctx;
  }

  it("GET /api/publish?exportId=<other-tenant-run> 404s instead of leaking the run", async () => {
    const { neoUserId, secondRunId } = await seedTwoTenantExportRuns();

    const neoUser = makeUserContext({
      id: neoUserId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      isSuperAdmin: true,
      isAdmin: true,
    });
    const ctx = buildLoaderContext(neoUser, DEFAULT_TEST_TENANT_ID);

    // Simulate the request that today (pre-fix) would dump Tenant B's
    // run body to a Tenant A superadmin.
    const request = new Request(
      `https://example.com/api/publish?exportId=${secondRunId}`
    );
    const response = await apiPublishLoader({
      request,
      context: ctx,
      params: {},
    } as any);

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "Export run not found" });
  });

  it("GET /api/publish?exportId=<own-run> returns the run for the calling tenant", async () => {
    const { neoUserId, neoRunId } = await seedTwoTenantExportRuns();

    const neoUser = makeUserContext({
      id: neoUserId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      isSuperAdmin: true,
      isAdmin: true,
    });
    const ctx = buildLoaderContext(neoUser, DEFAULT_TEST_TENANT_ID);

    const request = new Request(
      `https://example.com/api/publish?exportId=${neoRunId}`
    );
    const response = await apiPublishLoader({
      request,
      context: ctx,
      params: {},
    } as any);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe(neoRunId);
  });

  it("GET /api/publish (no id) returns only this tenant's runs", async () => {
    const { neoUserId, neoRunId, secondRunId } =
      await seedTwoTenantExportRuns();

    const neoUser = makeUserContext({
      id: neoUserId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      isSuperAdmin: true,
      isAdmin: true,
    });
    const ctx = buildLoaderContext(neoUser, DEFAULT_TEST_TENANT_ID);

    const request = new Request("https://example.com/api/publish");
    const response = await apiPublishLoader({
      request,
      context: ctx,
      params: {},
    } as any);

    expect(response.status).toBe(200);
    const runs = (await response.json()) as Array<{ id: string }>;
    const ids = runs.map((r) => r.id);
    expect(ids).toContain(neoRunId);
    expect(
      ids,
      `Tenant B run id MUST NOT appear in Tenant A list: ${ids.join(", ")}`
    ).not.toContain(secondRunId);
  });

  it("/admin/publish loader: history + activeExport are scoped to this tenant", async () => {
    const { neoUserId, secondUserId, neoRunId, secondRunId } =
      await seedTwoTenantExportRuns();

    // Add a running export for Tenant B — Tenant A's loader must NOT
    // surface it as `activeExport`.
    const now = Date.now();
    await db.insert(schema.exportRuns).values({
      id: "33333333-3333-4333-8333-cccccccccccc",
      triggeredBy: secondUserId,
      status: "running",
      selectedFonds: JSON.stringify(["mx-second-fonds"]),
      selectedTypes: JSON.stringify(["descriptions"]),
      stepsCompleted: 1,
      totalSteps: 6,
      startedAt: now - 1000,
      createdAt: now - 1000,
    });

    const neoUser = makeUserContext({
      id: neoUserId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      isSuperAdmin: true,
      isAdmin: true,
    });
    const ctx = buildLoaderContext(neoUser, DEFAULT_TEST_TENANT_ID);

    const result = (await adminPublishLoader({
      request: new Request("https://example.com/admin/publish"),
      context: ctx,
      params: {},
    } as any)) as {
      authorized: boolean;
      activeExport: { id: string } | null;
      history: Array<{ id: string }>;
    };

    expect(result.authorized).toBe(true);

    // activeExport: Tenant B's running run must not leak.
    expect(
      result.activeExport,
      `activeExport must be null for Tenant A (Tenant B has a running run): ${JSON.stringify(result.activeExport)}`
    ).toBeNull();

    // history: must include Tenant A's completed run, must not include
    // Tenant B's completed run.
    const historyIds = result.history.map((r) => r.id);
    expect(historyIds).toContain(neoRunId);
    expect(
      historyIds,
      `Tenant B run id MUST NOT appear in Tenant A history: ${historyIds.join(", ")}`
    ).not.toContain(secondRunId);
  });
});
