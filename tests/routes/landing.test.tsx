/**
 * Tests — landing route
 *
 * This suite is the behavioural-coverage net for the apex marketing landing + workspace
 * picker at `app/routes/_index.tsx`. The cases below drive the
 * landing's loader + action contract:
 *
 *   1. Apex GET runs the loader without throwing (no authMiddleware
 *      indirection -- the route is anonymous, sibling to `_auth`).
 *   2. Tenant-subdomain GET makes the loader throw `redirect("/dashboard")`
 *      so authenticated users on a tenant host land in the staff app.
 *   3. POST with a real (seeded) tenant slug 302s to
 *      `https://<slug>.fisqua.org/login` -- the picker handoff.
 *   4. POST with an empty `slug` returns a 400 carrying
 *      `{ error: "empty" }` as JSON action data.
 *   5. POST with a shape-invalid `slug` (uppercase / charset / leading
 *      hyphen / reserved) returns a 400 carrying `{ error: "shape" }`.
 *   6. POST with a shape-valid but unseeded `slug` returns a 400
 *      carrying `{ error: "notFound", slug }` so the picker can echo
 *      the typo back to the user inline.
 *
 * Tests 5 + 6 plus the live D1 lookup retired an earlier source-grep
 * invariant — see the action's docstring for the threat-model
 * reframe.
 *
 * The harness mirrors `tests/auth/github-oauth.test.ts`: a thin
 * `makeLoaderArgs` builder that constructs `Route.LoaderArgs` /
 * `Route.ActionArgs` shapes by hand because `SELF.fetch` cannot
 * resolve `virtual:react-router/server-build` in worktree
 * environments. The landing tests do not write to D1, but
 * `applyMigrations()` + `cleanDatabase()` run anyway so this file
 * composes cleanly with sibling tests in this directory.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, seedTenants } from "../helpers/db";

/**
 * Build a minimal Route.LoaderArgs-compatible context object for direct
 * loader invocation. Mirrors the harness in
 * `tests/auth/github-oauth.test.ts:42-60`.
 */
function makeLoaderArgs(url: string, init: RequestInit = {}) {
  const request = new Request(url, init);
  return {
    request,
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
          GITHUB_CLIENT_ID: "test-github-id",
          GITHUB_CLIENT_SECRET: "test-github-secret",
        },
      },
    },
    params: {},
  };
}

/**
 * Build an action args shape with a form-encoded `slug` body.
 */
function makeActionArgs(url: string, slug: string) {
  const body = new URLSearchParams({ slug });
  return makeLoaderArgs(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

describe("landing route", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("loader runs on apex without throwing", async () => {
    const { loader } = await import("../../app/routes/_index");
    const result = await loader(makeLoaderArgs("https://fisqua.test/") as any);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("loader redirects to /dashboard on a tenant subdomain", async () => {
    const { loader } = await import("../../app/routes/_index");
    try {
      await loader(makeLoaderArgs("https://neogranadina.fisqua.test/") as any);
      expect.unreachable("Loader should have thrown a redirect on a tenant subdomain");
    } catch (e) {
      const response = e as Response;
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/dashboard");
    }
  });

  // staging.fisqua.org is the staging deploy's apex (smoke
  // environment), NOT a tenant subdomain — even though it
  // structurally ends with `.fisqua.org`. The loader must render
  // the landing rather than redirect into /dashboard.
  it("loader renders the landing on staging.fisqua.org (apex-equivalent)", async () => {
    const { loader } = await import("../../app/routes/_index");
    const result = await loader(
      makeLoaderArgs("https://staging.fisqua.org/") as any,
    );
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("loader renders the landing on staging.fisqua.test (apex-equivalent)", async () => {
    const { loader } = await import("../../app/routes/_index");
    const result = await loader(
      makeLoaderArgs("https://staging.fisqua.test/") as any,
    );
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("action 302s to <slug>.fisqua.org/login on a seeded tenant slug", async () => {
    await seedTenants();
    const { action } = await import("../../app/routes/_index");
    try {
      await action(makeActionArgs("https://fisqua.test/", "neogranadina") as any);
      expect.unreachable("Action should have thrown a redirect on a seeded slug");
    } catch (e) {
      const response = e as Response;
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "https://neogranadina.fisqua.org/login",
      );
    }
  });

  it("action returns { error: 'empty' } with status 400 on empty submit", async () => {
    const { action } = await import("../../app/routes/_index");
    const result = (await action(
      makeActionArgs("https://fisqua.test/", "") as any,
    )) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body).toEqual({ error: "empty" });
  });

  // Shape-invalid input is rejected without a D1 lookup. The
  // SlugSchema rule list (lowercase, leading letter, ASCII charset,
  // length 1–63, not in RESERVED_SLUGS) is intentionally public — it
  // mirrors the SQLite CHECK on tenants.slug, so surfacing a shape
  // error inline does not leak any tenant-existence signal that is
  // not already in the schema migration.
  // Casing is silently normalised (`raw.trim().toLowerCase()`) per
  // 32-LANDING-COPY.md §1.3, so `UPPERCASE` becomes `uppercase` and
  // routes to lookup, not shape — `UPPERCASE` would surface as
  // notFound (or 302 if a tenant `uppercase` happened to exist),
  // never as a shape error. Cases below are inputs that survive
  // trim+lowercase and still fail SlugSchema.
  it.each([
    ["foo bar"],      // contains a space
    ["-leading"],     // leading hyphen
    ["1numericstart"],// must start with a letter
    ["platform"],     // reserved
  ])("action returns { error: 'shape' } for slug %s", async (slug) => {
    const { action } = await import("../../app/routes/_index");
    const result = (await action(
      makeActionArgs("https://fisqua.test/", slug) as any,
    )) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body).toEqual({ error: "shape" });
  });

  // Shape-valid slug that does not match any seeded tenant returns a
  // structured notFound payload. The slug is echoed back so the
  // picker can render the typo inline ("We don't have a workspace
  // called 'neogradina'.").
  it("action returns { error: 'notFound', slug } for an unseeded slug", async () => {
    await seedTenants();
    const { action } = await import("../../app/routes/_index");
    const result = (await action(
      makeActionArgs("https://fisqua.test/", "neogradina") as any,
    )) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body).toEqual({ error: "notFound", slug: "neogradina" });
  });

  it("action lowercases + trims before lookup so 'Neogranadina ' resolves", async () => {
    await seedTenants();
    const { action } = await import("../../app/routes/_index");
    try {
      await action(
        makeActionArgs("https://fisqua.test/", "  Neogranadina  ") as any,
      );
      expect.unreachable("Should have redirected on the trim+lowercase result");
    } catch (e) {
      const response = e as Response;
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(
        "https://neogranadina.fisqua.org/login",
      );
    }
  });
});

/**
 * Render-assertion suite (locked copy + a11y).
 *
 * Renders the landing route's default-export tree to a static HTML
 * string in both languages and asserts the locked copy + structural
 * contract. Spins up an isolated `i18next` instance per test so the
 * language is fully under test control (no dependence on the per-
 * request detection chain), and feeds the route a synthetic
 * `loaderData` shape that matches what `loader()` returns on the
 * apex.
 */
describe("landing render — locked copy + a11y", () => {
  async function renderLanding(lang: "en" | "es"): Promise<string> {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { I18nextProvider } = await import("react-i18next");
    const i18nextModule = await import("i18next");
    const enResources = (await import("../../app/locales/en")).default;
    const esResources = (await import("../../app/locales/es")).default;
    const LandingRoute = (await import("../../app/routes/_index")).default;

    const inst = i18nextModule.default.createInstance();
    await (inst.init as (opts: unknown) => Promise<unknown>)({
      lng: lang,
      fallbackLng: "es",
      defaultNS: "common",
      resources: {
        en: enResources as Record<string, unknown>,
        es: esResources as Record<string, unknown>,
      },
      interpolation: { escapeValue: false },
    });

    const tree = React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(LandingRoute as never, {
        loaderData: { lang, surface: "landing" as const },
        actionData: undefined,
        params: {},
        matches: [],
      } as never),
    );
    return renderToStaticMarkup(tree);
  }

  it("renders the locked EN tagline on apex", async () => {
    const html = await renderLanding("en");
    expect(html).toContain(
      "An open-source, collaborative archival cataloguing and records management platform.",
    );
  });

  it("renders the locked ES tagline when lang=es", async () => {
    const html = await renderLanding("es");
    expect(html).toContain(
      "Una plataforma colaborativa y de código abierto para la catalogación y gestión de archivos.",
    );
  });

  it("language toggle renders both anchors with aria-current on the active locale", async () => {
    const html = await renderLanding("en");
    expect(html).toContain('href="/?lang=en"');
    expect(html).toContain('href="/?lang=es"');
    // The EN anchor wraps the literal `EN` text and carries aria-current="true"
    expect(html).toMatch(/aria-current="true"[^>]*>EN</);
  });

  it("picker form has the locked structural attributes", async () => {
    const html = await renderLanding("en");
    expect(html).toMatch(/<form\s[^>]*method="post"/);
    expect(html).toContain('name="slug"');
    // The .fisqua.org suffix is rendered as an adjacent <span>, NOT inside the input value
    expect(html).toMatch(/<span[^>]*id="workspace-suffix"[^>]*>\.fisqua\.org<\/span>/);
    expect(html).toContain("Continue");
    // aria-describedby wires the input to the suffix + error ids
    expect(html).toMatch(/aria-describedby="workspace-suffix workspace-error"/);
  });

  it("footer links target the locked external URLs", async () => {
    const html = await renderLanding("en");
    expect(html).toContain("https://github.com/UCSB-AMPLab/fisqua");
    expect(html).toContain("https://ampl.clair.ucsb.edu/project/fisqua");
  });

  it("renders the locked EN empty-input error string verbatim", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = await import("react");
    const { I18nextProvider } = await import("react-i18next");
    const i18nextModule = await import("i18next");
    const enResources = (await import("../../app/locales/en")).default;
    const esResources = (await import("../../app/locales/es")).default;
    const LandingRoute = (await import("../../app/routes/_index")).default;

    const inst = i18nextModule.default.createInstance();
    await (inst.init as (opts: unknown) => Promise<unknown>)({
      lng: "en",
      fallbackLng: "es",
      defaultNS: "common",
      resources: {
        en: enResources as Record<string, unknown>,
        es: esResources as Record<string, unknown>,
      },
      interpolation: { escapeValue: false },
    });

    const tree = React.createElement(
      I18nextProvider,
      { i18n: inst },
      React.createElement(LandingRoute as never, {
        loaderData: { lang: "en" as const, surface: "landing" as const },
        actionData: { error: "empty" as const },
        params: {},
        matches: [],
      } as never),
    );
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Enter your workspace name.");
  });
});

// @version v0.4.0
