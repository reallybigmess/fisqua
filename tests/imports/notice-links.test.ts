/**
 * Tests — dead-end notices carry their fix links (comprehensive pass)
 *
 * Every notice that tells the operator to go do something elsewhere must
 * link there. The routes render these links through react-i18next `Trans`
 * with named component tags, so the SEAM is the locale strings themselves:
 * a missing tag silently drops the link, and the tags must agree between
 * EN and ES (the components map is shared). There is no component-render
 * harness in this repo, so tag presence in BOTH locales is the render
 * assertion, alongside the action-level `duplicate_name` → `existingId`
 * behaviour that feeds the profile links.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import en from "../../app/locales/en/imports";
import es from "../../app/locales/es/imports";
import { createProfile, updateProfile } from "../../app/lib/import/profiles.server";
import { mintStarter } from "../../app/lib/import/starters.server";
import { SBMAL_DACS_BINDINGS } from "./fixtures";

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

/** Both locales must carry the SAME component tags for one key. */
function expectTag(
  pick: (l: typeof en) => string,
  tag: string,
  times = 1,
): void {
  for (const locale of [en, es]) {
    const value = pick(locale as typeof en);
    const open = (value.match(new RegExp(`<${tag}>`, "g")) ?? []).length;
    const close = (value.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    expect(open).toBe(times);
    expect(close).toBe(times);
  }
}

describe("notice strings — the fix links' component tags (EN and ES agree)", () => {
  it("blocking-card bodies link the re-upload path to the landing", () => {
    expectTag((l) => l.check.blocking.duplicateBody, "landing");
    expectTag((l) => l.check.blocking.missingBody, "landing");
    expectTag((l) => l.check.blocking.cycleBody, "landing");
    expectTag((l) => l.check.blocking.invalidBody, "landing");
    // unresolvable: "import the container first" AND "re-upload the items".
    expectTag((l) => l.check.blocking.unresolvableBody, "landing", 2);
  });

  it("fix-hint expanders link the staging path to the landing", () => {
    expectTag((l) => l.check.fixHint, "landing");
    expectTag((l) => l.check.fixHintNoColumns, "landing");
  });

  it("commit refusals link their journey steps", () => {
    expectTag((l) => l.report.commitErrors.decisionsPending, "check");
    expectTag((l) => l.report.commitErrors.decisionsPending, "dryRun");
    expectTag((l) => l.report.commitErrors.profileStale, "dryRun");
    expectTag((l) => l.report.commitErrors.decisionsChanged, "dryRun");
  });

  it("duplicate_name errors link the conflicting profile", () => {
    expectTag((l) => l.starters.errors.duplicate_name, "profile");
    expectTag((l) => l.profileEditor.errors.duplicate_name, "profile");
  });

  it("the dead report.noProfiles key is gone from both locales", () => {
    expect("noProfiles" in en.report).toBe(false);
    expect("noProfiles" in (es.report as Record<string, unknown>)).toBe(false);
  });
});

describe("duplicate_name — the conflicting profile's id travels with the error", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  const input = (userId: string, name = "SBMAL DACS") => ({
    tenantId: DEFAULT_TEST_TENANT_ID,
    standard: "isadg" as const,
    name,
    bindings: SBMAL_DACS_BINDINGS,
    sharedWithFederation: false,
    userId,
  });

  it("createProfile returns the existing profile's id on a name collision", async () => {
    const user = await adminUser();
    const first = await createProfile(db(), input(user.id));
    if (!first.ok) throw new Error("first create failed");
    const second = await createProfile(db(), input(user.id));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("duplicate_name");
    expect(second.existingId).toBe(first.id);
  });

  it("updateProfile returns the existing profile's id when a rename collides", async () => {
    const user = await adminUser();
    const first = await createProfile(db(), input(user.id, "Profile A"));
    const other = await createProfile(db(), input(user.id, "Profile B"));
    if (!first.ok || !other.ok) throw new Error("setup failed");
    const renamed = await updateProfile(db(), other.id, input(user.id, "Profile A"));
    expect(renamed.ok).toBe(false);
    if (renamed.ok) return;
    expect(renamed.error).toBe("duplicate_name");
    expect(renamed.existingId).toBe(first.id);
  });

  it("mintStarter surfaces the existing profile's id on a re-mint", async () => {
    const user = await adminUser();
    const first = await mintStarter(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      userId: user.id,
      starterKey: "atom-isadg-csv",
    });
    if (!first.ok) throw new Error("first mint failed: " + first.error);
    const second = await mintStarter(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      userId: user.id,
      starterKey: "atom-isadg-csv",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("duplicate_name");
    expect("existingId" in second && second.existingId).toBe(first.id);
  });

  it("the landing mintStarter action carries existingId to the UI", async () => {
    const user = await adminUser();
    const { action } = await import("../../app/routes/_auth.admin.imports");
    const mint = () => {
      const form = new FormData();
      form.set("intent", "mintStarter");
      form.set("starterKey", "atom-isadg-csv");
      return action({
        request: new Request("http://neogranadina.fisqua.test/admin/imports", {
          method: "POST",
          body: form,
        }),
        context: ctx(user),
        params: {},
      } as any);
    };
    const first = (await mint()) as Response;
    expect(first.status).toBe(302);
    const firstId = first.headers.get("location")!.match(/profiles\/(.+)$/)![1];
    const second = (await mint()) as any;
    expect(second.ok).toBe(false);
    expect(second.error).toBe("duplicate_name");
    expect(second.existingId).toBe(firstId);
  });

  it("the profile editor action carries existingId to the UI", async () => {
    const user = await adminUser();
    const first = await createProfile(db(), input(user.id));
    if (!first.ok) throw new Error("setup failed");
    const { action } = await import(
      "../../app/routes/_auth.admin.imports.profiles.$profileId"
    );
    const form = new FormData();
    form.set("intent", "save");
    form.set("name", "SBMAL DACS");
    form.set("bindings", JSON.stringify(SBMAL_DACS_BINDINGS));
    const result = (await action({
      request: new Request(
        "http://neogranadina.fisqua.test/admin/imports/profiles/new",
        { method: "POST", body: form },
      ),
      context: ctx(user),
      params: { profileId: "new" },
    } as any)) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicate_name");
    expect(result.existingId).toBe(first.id);
  });
});
