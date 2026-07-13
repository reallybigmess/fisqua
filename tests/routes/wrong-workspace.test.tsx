/**
 * Tests — wrong-workspace interstitial route
 *
 * This suite is the loader-level coverage net for `app/routes/wrong-workspace.tsx`, the
 * public interstitial that the three wrong-tenant callers (magic-
 * link verify, OAuth handoff, authMiddleware) 302 to with
 * `?home=<home-slug>`. The route is identity-blind: it never reads
 * the session cookie and never mints one. Its only inputs are the
 * request host (resolved to the wrong tenant) and the `?home` query
 * param (validated against `SlugSchema`, looked up in `tenants`).
 *
 * Coverage:
 *   1. happy path — request on `second-tenant.fisqua.test` with
 *      `?home=neogranadina` returns both tenants + a CTA URL pointing
 *      at `https://neogranadina.fisqua.test/login`.
 *   2. missing `?home` — `homeTenant: null`, `ctaUrl: null`.
 *   3. shape-invalid `?home` — returns `homeTenant: null` WITHOUT a
 *      DB query (validation gate runs first).
 *   4. shape-valid but unseeded `?home` — `homeTenant: null` (no leak
 *      about deleted-tenant existence).
 *   5. `?home` equals current tenant slug — `homeTenant: null` (user
 *      already on the right subdomain, render fallback copy).
 *   6. unknown host — the underlying `getTenantFromRequest` 404
 *      bubbles up (route does not catch).
 *
 * Component-level rendering (icon, mark, layout) is exercised manually
 * in `wrangler dev`; the component is mostly markup over loader
 * data, with no branching the loader doesn't test.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase } from "../helpers/db";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/wrong-workspace";

function makeLoaderArgs(url: string, init: RequestInit = {}) {
  const request = new Request(url, init);
  return {
    request,
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
        },
      },
    },
    params: {},
  };
}

describe("wrong-workspace route", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns both tenants and a CTA URL on the happy path", async () => {
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "https://second-tenant.fisqua.test/wrong-workspace?home=neogranadina",
      ) as any,
    );

    expect(result.wrongTenant).toEqual({
      slug: "second-tenant",
      name: "Second Test Tenant",
    });
    expect(result.homeTenant).toEqual({
      slug: "neogranadina",
      name: "Neogranadina",
    });
    expect(result.ctaUrl).toBe("https://neogranadina.fisqua.test/login");
  });

  it("returns null homeTenant when ?home is missing", async () => {
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs("https://second-tenant.fisqua.test/wrong-workspace") as any,
    );
    expect(result.wrongTenant.slug).toBe("second-tenant");
    expect(result.homeTenant).toBeNull();
    expect(result.ctaUrl).toBeNull();
  });

  it("returns null homeTenant when ?home fails SlugSchema (shape)", async () => {
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "https://second-tenant.fisqua.test/wrong-workspace?home=INVALID_SHAPE",
      ) as any,
    );
    expect(result.homeTenant).toBeNull();
    expect(result.ctaUrl).toBeNull();
  });

  it("returns null homeTenant when ?home is a reserved slug", async () => {
    // SlugSchema rejects reserved slugs (platform, www, api, admin, app).
    // The route must render the fallback rather than leak via lookup.
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "https://second-tenant.fisqua.test/wrong-workspace?home=platform",
      ) as any,
    );
    expect(result.homeTenant).toBeNull();
    expect(result.ctaUrl).toBeNull();
  });

  it("returns null homeTenant when ?home is a shape-valid but unseeded slug", async () => {
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "https://second-tenant.fisqua.test/wrong-workspace?home=does-not-exist",
      ) as any,
    );
    expect(result.homeTenant).toBeNull();
    expect(result.ctaUrl).toBeNull();
  });

  it("returns null homeTenant when ?home equals the current tenant slug", async () => {
    // User hit /wrong-workspace?home=neogranadina ON neogranadina.fisqua.test.
    // Render fallback rather than a self-referencing CTA.
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "https://neogranadina.fisqua.test/wrong-workspace?home=neogranadina",
      ) as any,
    );
    expect(result.wrongTenant.slug).toBe("neogranadina");
    expect(result.homeTenant).toBeNull();
    expect(result.ctaUrl).toBeNull();
  });

  it("bubbles the 404 from getTenantFromRequest on an unknown host", async () => {
    const { loader } = await import("../../app/routes/wrong-workspace");
    try {
      await loader(
        makeLoaderArgs(
          "https://unknown.example.com/wrong-workspace?home=neogranadina",
        ) as any,
      );
      expect.unreachable("loader should have thrown a 404 Response");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("preserves port in ctaUrl for .localhost dev hosts", async () => {
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "http://second-tenant.localhost:5173/wrong-workspace?home=neogranadina",
      ) as any,
    );
    expect(result.ctaUrl).toBe("http://neogranadina.localhost:5173/login");
  });

  it("returns null ctaUrl on legacy host (catalogacion.zasqua.org)", async () => {
    // The legacy host maps to neogranadina via LEGACY_HOST_MAP, so the
    // request resolves to a real tenant — but `buildTenantOriginUrl`
    // returns null because the host doesn't end with any
    // SUBDOMAIN_HOST_SUFFIXES entry. Loader should therefore return a
    // null ctaUrl while still resolving wrongTenant.
    const { loader } = await import("../../app/routes/wrong-workspace");
    const result = await loader(
      makeLoaderArgs(
        "https://catalogacion.zasqua.org/wrong-workspace?home=second-tenant",
      ) as any,
    );
    expect(result.wrongTenant.slug).toBe("neogranadina");
    // ?home=second-tenant is a real tenant, so homeTenant resolves,
    // but ctaUrl is null because the current host isn't a subdomain host.
    expect(result.homeTenant?.slug).toBe("second-tenant");
    expect(result.ctaUrl).toBeNull();
  });
});
