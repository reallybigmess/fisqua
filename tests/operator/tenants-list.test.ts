/**
 * Tests — operator tenants list page
 *
 * This suite pins the cross-tenant read contract of
 * `app/routes/_operator.tenants._index.tsx`. The list page is the
 * legitimate cross-tenant reader for operators — the cross-tenant
 * keystone grep test (`tests/db/cross-tenant-coverage.test.ts`)
 * deliberately excludes the `_operator.*` glob.
 *
 * Coverage:
 *   1. The loader returns ALL tenants (5 from seedTenants() — platform,
 *      neogranadina, second-tenant, dacs-test, rad-test — plus 1 from
 *      seedDisabledTenant() = 6 rows). No `where(tenantId, ...)`
 *      filter.
 *   2. The loader's data is ordered by (kind ASC, slug ASC). Platform
 *      kind sorts before tenant kind (alphabetical: 'platform' < 'tenant')
 *      — wait, kind enum is 'platform' | 'tenant'. ASC string order
 *      puts 'platform' before 'tenant', so the platform tenant lands
 *      first. Within each kind, slug ASC.
 *   3. The platform tenant row carries the kind='platform' marker
 *      (the rendered HTML's [platform] / [plataforma] badge derives
 *      from this in the JSX; we test the data shape, not the JSX
 *      directly because the React Router route module is hard to
 *      render in the workers test pool without going through the
 *      full HTTP round-trip).
 *   4. The disabled tenant row's `disabledAt` field is non-null.
 *   5. Rows carry `authoritiesEnabled` (the A in the CVPMA mask).
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedDisabledTenant,
  DISABLED_TEST_TENANT_ID,
} from "../helpers/db";
import { tenantContext, userContext } from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

function buildContext(): any {
  const ctx = new RouterContextProvider();
  ctx.set(
    userContext,
    makeUserContext({
      tenantId: PLATFORM_TENANT_ID,
      isSuperAdmin: true,
      email: "operator@example.test",
    }),
  );
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: PLATFORM_TENANT_ID,
      slug: "platform",
      name: "Platform",
      kind: "platform",
      descriptiveStandard: null,
      crowdsourcingEnabled: false,
      vocabularyHubEnabled: false,
      publishPipelineEnabled: false,
      multiRepositoryEnabled: false,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

describe("operator tenants list", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedDisabledTenant();
  });

  it("returns all six tenants (cross-tenant read; no where(tenantId) filter)", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants._index"
    );
    const ctx = buildContext();
    const result = (await loader({
      request: new Request("https://platform.fisqua.test/operator/tenants"),
      context: ctx,
      params: {},
    } as any)) as { tenants: Array<{ id: string; slug: string; kind: string; disabledAt: number | null }> };

    // 5 from seedTenants() (platform, neogranadina, second-tenant,
    // dacs-test, rad-test) + 1 from seedDisabledTenant() = 6.
    expect(result.tenants).toHaveLength(6);
    const slugs = result.tenants.map((t) => t.slug).sort();
    expect(slugs).toEqual([
      "dacs-test",
      "disabled-tenant",
      "neogranadina",
      "platform",
      "rad-test",
      "second-tenant",
    ]);
  });

  it("orders rows by (kind ASC, slug ASC) — platform first, tenants alphabetical after", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants._index"
    );
    const ctx = buildContext();
    const result = (await loader({
      request: new Request("https://platform.fisqua.test/operator/tenants"),
      context: ctx,
      params: {},
    } as any)) as { tenants: Array<{ id: string; slug: string; kind: string }> };

    // 'platform' kind sorts before 'tenant' kind (alpha order).
    // Within tenant kind, slug ASC: dacs-test, disabled-tenant,
    // neogranadina, rad-test, second-tenant.
    expect(result.tenants[0].kind).toBe("platform");
    expect(result.tenants[0].slug).toBe("platform");
    expect(result.tenants[1].slug).toBe("dacs-test");
    expect(result.tenants[2].slug).toBe("disabled-tenant");
    expect(result.tenants[3].slug).toBe("neogranadina");
    expect(result.tenants[4].slug).toBe("rad-test");
    expect(result.tenants[5].slug).toBe("second-tenant");
  });

  it("platform tenant row carries kind='platform' (the [platform] badge derives from this)", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants._index"
    );
    const ctx = buildContext();
    const result = (await loader({
      request: new Request("https://platform.fisqua.test/operator/tenants"),
      context: ctx,
      params: {},
    } as any)) as { tenants: Array<{ id: string; kind: string }> };

    const platformRow = result.tenants.find((t) => t.id === PLATFORM_TENANT_ID);
    expect(platformRow).toBeDefined();
    expect(platformRow!.kind).toBe("platform");
  });

  it("rows carry authoritiesEnabled reflecting the flag (the A in the CVPMA mask derives from this)", async () => {
    const { drizzle } = await import("drizzle-orm/d1");
    const { eq } = await import("drizzle-orm");
    const schema = await import("../../app/db/schema");
    const db = drizzle(env.DB);
    await db
      .update(schema.tenants)
      .set({ authoritiesEnabled: false })
      .where(eq(schema.tenants.slug, "second-tenant"));

    const { loader } = await import(
      "../../app/routes/_operator.tenants._index"
    );
    const ctx = buildContext();
    const result = (await loader({
      request: new Request("https://platform.fisqua.test/operator/tenants"),
      context: ctx,
      params: {},
    } as any)) as {
      tenants: Array<{ slug: string; authoritiesEnabled: boolean }>;
    };

    const off = result.tenants.find((t) => t.slug === "second-tenant");
    expect(off).toBeDefined();
    expect(off!.authoritiesEnabled as unknown as boolean).toBe(false);
    // seedTenants leaves the flag at its DEFAULT 1 for everyone else.
    const on = result.tenants.find((t) => t.slug === "neogranadina");
    expect(on!.authoritiesEnabled as unknown as boolean).toBe(true);
  });

  it("disabled tenant row carries non-null disabledAt", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants._index"
    );
    const ctx = buildContext();
    const result = (await loader({
      request: new Request("https://platform.fisqua.test/operator/tenants"),
      context: ctx,
      params: {},
    } as any)) as {
      tenants: Array<{ id: string; slug: string; disabledAt: number | null }>;
    };

    const disabledRow = result.tenants.find(
      (t) => t.id === DISABLED_TEST_TENANT_ID,
    );
    expect(disabledRow).toBeDefined();
    expect(disabledRow!.disabledAt).not.toBeNull();
    // Other tenants' disabledAt MUST be null (not soft-disabled).
    const otherRows = result.tenants.filter(
      (t) => t.id !== DISABLED_TEST_TENANT_ID,
    );
    for (const row of otherRows) {
      expect(row.disabledAt).toBeNull();
    }
  });
});

// @version v0.4.2
