/**
 * Tests — the journey's returnTo hand-back (blocking notices with a path)
 *
 * The journey's blocking notices link to a creation surface carrying a
 * `returnTo` back into the journey; the create actions honour it on
 * success behind an open-redirect guard. This suite pins: the guard
 * itself (internal paths only — "https://…" and "//…" refused), the
 * notice-link construction (`withReturnTo`, exactly as the journey's
 * Check and Import panes call it — there is no component-render harness,
 * so the pure builder is the render seam), the repositories/new action
 * honouring a valid returnTo and falling back on a refused one, and the
 * profile-create action doing the same.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { repositories, importProfiles } from "../../app/db/schema";
import { safeReturnTo, withReturnTo } from "../../app/lib/return-to";
import { SBMAL_DACS_BINDINGS } from "./fixtures";

const REPO_ROUTE = "../../app/routes/_auth.admin.repositories.new";
const PROFILE_ROUTE = "../../app/routes/_auth.admin.imports.profiles.$profileId";

function db() {
  return drizzle(env.DB);
}

function ctx(user: User): any {
  const c = new RouterContextProvider();
  c.set(userContext, user);
  c.set(
    tenantContext,
    makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, importsEnabled: true }),
  );
  (c as any).cloudflare = { env };
  return c;
}

async function adminUser(): Promise<User> {
  const u = await createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
  return makeUserContext({ id: u.id, tenantId: DEFAULT_TEST_TENANT_ID, isAdmin: true });
}

describe("safeReturnTo — the open-redirect guard", () => {
  it("accepts an internal path (the journey step URL)", () => {
    expect(safeReturnTo("/admin/imports/uploads/u1?step=import")).toBe(
      "/admin/imports/uploads/u1?step=import",
    );
  });

  it("refuses an absolute external URL", () => {
    expect(safeReturnTo("https://evil.example")).toBeNull();
  });

  it("refuses a scheme-relative URL", () => {
    expect(safeReturnTo("//evil.example")).toBeNull();
  });

  it("refuses non-strings and non-paths", () => {
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo("admin/imports")).toBeNull();
    expect(safeReturnTo("")).toBeNull();
  });

  it("refuses browser-normalisation bypasses (backslash, stripped whitespace)", () => {
    // Browsers parse "\" as "/" in a Location URL and strip TAB/LF/CR,
    // so each of these resolves scheme-relative external despite
    // passing a bare starts-with-single-slash check.
    expect(safeReturnTo("/\\evil.example")).toBeNull();
    expect(safeReturnTo("/\\/evil.example")).toBeNull();
    expect(safeReturnTo("/\t/evil.example")).toBeNull();
    expect(safeReturnTo("/\n/evil.example")).toBeNull();
    expect(safeReturnTo("/\r/evil.example")).toBeNull();
  });
});

describe("withReturnTo — the notice-link hrefs the journey builds", () => {
  it("builds the Import pane's add-a-repository link", () => {
    expect(
      withReturnTo("/admin/repositories/new", "/admin/imports/uploads/u1?step=import"),
    ).toBe(
      "/admin/repositories/new?returnTo=%2Fadmin%2Fimports%2Fuploads%2Fu1%3Fstep%3Dimport",
    );
  });

  it("builds the Check pane's create-a-profile link", () => {
    expect(
      withReturnTo("/admin/imports/profiles/new", "/admin/imports/uploads/u1?step=check"),
    ).toBe(
      "/admin/imports/profiles/new?returnTo=%2Fadmin%2Fimports%2Fuploads%2Fu1%3Fstep%3Dcheck",
    );
  });
});

describe("repositories/new — returnTo honoured on create, guarded", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  function createRequest(returnTo?: string): Request {
    const form = new FormData();
    form.set("code", "TEST-REPO");
    form.set("name", "Test repository (synthetic)");
    form.set("countryCode", "COL");
    form.set("enabled", "on");
    if (returnTo !== undefined) form.set("returnTo", returnTo);
    return new Request("http://neogranadina.fisqua.test/admin/repositories/new", {
      method: "POST",
      body: form,
    });
  }

  it("redirects to a valid internal returnTo instead of the edit page", async () => {
    const user = await adminUser();
    const { action } = await import(REPO_ROUTE);
    const res = (await action({
      request: createRequest("/admin/imports/uploads/u1?step=import"),
      context: ctx(user),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/imports/uploads/u1?step=import");
    // The repository was still created.
    const row = await db()
      .select()
      .from(repositories)
      .where(eq(repositories.code, "TEST-REPO"))
      .get();
    expect(row).toBeDefined();
  });

  it("falls back to the edit page for an absolute external returnTo", async () => {
    const user = await adminUser();
    const { action } = await import(REPO_ROUTE);
    const res = (await action({
      request: createRequest("https://evil.example"),
      context: ctx(user),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/admin\/repositories\/[0-9a-f-]+$/);
  });

  it("falls back to the edit page for a scheme-relative returnTo", async () => {
    const user = await adminUser();
    const { action } = await import(REPO_ROUTE);
    const res = (await action({
      request: createRequest("//evil.example"),
      context: ctx(user),
      params: {},
    } as any)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/^\/admin\/repositories\/[0-9a-f-]+$/);
  });
});

describe("profile create — returnTo honoured on create, guarded", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  function saveRequest(returnTo?: string): Request {
    const form = new FormData();
    form.set("intent", "save");
    form.set("name", "SBMAL DACS");
    form.set("bindings", JSON.stringify(SBMAL_DACS_BINDINGS));
    if (returnTo !== undefined) form.set("returnTo", returnTo);
    return new Request("http://neogranadina.fisqua.test/admin/imports/profiles/new", {
      method: "POST",
      body: form,
    });
  }

  it("redirects to a valid internal returnTo after a successful create", async () => {
    const user = await adminUser();
    const { action } = await import(PROFILE_ROUTE);
    const res = (await action({
      request: saveRequest("/admin/imports/uploads/u1?step=check"),
      context: ctx(user),
      params: { profileId: "new" },
    } as any)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/imports/uploads/u1?step=check");
    const row = await db()
      .select()
      .from(importProfiles)
      .where(eq(importProfiles.name, "SBMAL DACS"))
      .get();
    expect(row).toBeDefined();
  });

  it("falls back to the imports landing for a refused returnTo", async () => {
    const user = await adminUser();
    const { action } = await import(PROFILE_ROUTE);
    const res = (await action({
      request: saveRequest("https://evil.example"),
      context: ctx(user),
      params: { profileId: "new" },
    } as any)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/imports");
  });
});
