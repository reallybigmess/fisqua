/**
 * Tests — /admin/imports/profiles/:profileId route (loader + action)
 *
 * This suite pins the mapping-profile surface: capability gating, create
 * (redirect + persisted row), edit (version bump), delete, the
 * validation error paths (name required, invalid bindings), and the
 * spec §7.3 read-only posture — a member tenant can VIEW a lead's shared
 * profile but a save against it is refused by ownership.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { importProfiles } from "../../app/db/schema";
import {
  NEOGRANADINA_FEDERATION_ID,
  NEOGRANADINA_TENANT_ID,
} from "../../app/lib/tenant";
import { createProfile } from "../../app/lib/import/profiles.server";
import "../../app/routes/_auth.admin.imports.profiles.$profileId";

const ROUTE = "../../app/routes/_auth.admin.imports.profiles.$profileId";
const MEMBER_TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const validBindings = [
  { source: "identifier", target: "referenceCode" },
  { source: "title", target: "title" },
];

function db() {
  return drizzle(env.DB);
}

function buildContext(user: User, tenant = makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, importsEnabled: true })): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant);
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function adminUser(tenantId = DEFAULT_TEST_TENANT_ID): Promise<User> {
  const u = await createTestUser({ isAdmin: true, tenantId });
  return makeUserContext({ id: u.id, tenantId, isAdmin: true });
}

function saveRequest(fields: Record<string, string>): Request {
  const form = new FormData();
  form.set("intent", "save");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://neogranadina.fisqua.test/admin/imports/profiles/new", {
    method: "POST",
    body: form,
  });
}

describe("profile route gating + create", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("404s the loader when imports is off", async () => {
    const user = await adminUser();
    const { loader } = await import(ROUTE);
    const ctx = buildContext(user, makeTenantContext({ id: DEFAULT_TEST_TENANT_ID, importsEnabled: false }));
    try {
      await loader({
        request: new Request("http://neogranadina.fisqua.test/admin/imports/profiles/new"),
        context: ctx,
        params: { profileId: "new" },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("loader returns create mode with target fields", async () => {
    const user = await adminUser();
    const { loader } = await import(ROUTE);
    const data = (await loader({
      request: new Request("http://neogranadina.fisqua.test/admin/imports/profiles/new"),
      context: buildContext(user),
      params: { profileId: "new" },
    } as any)) as any;
    expect(data.mode).toBe("create");
    expect(data.targetFields).toContain("referenceCode");
  });

  it("creates a profile and redirects", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const res = await action({
      request: saveRequest({ name: "AtoM", bindings: JSON.stringify(validBindings) }),
      context: buildContext(user),
      params: { profileId: "new" },
    } as any);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);

    const rows = await db().select().from(importProfiles).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("AtoM");
    expect(rows[0].version).toBe(1);
  });

  it("rejects a save with no name", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const res = (await action({
      request: saveRequest({ name: "  ", bindings: JSON.stringify(validBindings) }),
      context: buildContext(user),
      params: { profileId: "new" },
    } as any)) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("name_required");
  });

  it("surfaces invalid-binding issues", async () => {
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const res = (await action({
      request: saveRequest({
        name: "Bad",
        bindings: JSON.stringify([{ source: "x", target: "notAColumn" }]),
      }),
      context: buildContext(user),
      params: { profileId: "new" },
    } as any)) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("invalid_bindings");
    expect(res.issues.length).toBeGreaterThan(0);
  });
});

describe("profile route edit + delete + sharing", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedProfile(shared = false, tenantId = DEFAULT_TEST_TENANT_ID) {
    const user = await createTestUser({ isAdmin: true, tenantId });
    const created = await createProfile(db(), {
      tenantId,
      standard: "isadg",
      name: "Seed",
      bindings: validBindings,
      sharedWithFederation: shared,
      userId: user.id,
    });
    if (!created.ok) throw new Error("seed failed");
    return created.id;
  }

  it("bumps the version when a save changes the bindings", async () => {
    const id = await seedProfile();
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const res = await action({
      request: saveRequest({
        name: "Seed edited",
        bindings: JSON.stringify([
          ...validBindings,
          { source: "extentAndMedium", target: "extent" },
        ]),
      }),
      context: buildContext(user),
      params: { profileId: id },
    } as any);
    expect((res as Response).status).toBe(302);

    const rows = await db().select().from(importProfiles).all();
    expect(rows[0].version).toBe(2);
    expect(rows[0].name).toBe("Seed edited");
  });

  it("a name-only save keeps the version AND the transform parameters", async () => {
    // Full-fat bindings: every optional transform parameter populated.
    // The lossy-editor bug would have flattened these on any save.
    const fullFat = [
      { source: "identifier", target: "referenceCode" },
      {
        source: "levelOfDescription",
        target: "descriptionLevel",
        transform: {
          kind: "vocabulary",
          mapping: { expediente: "file" },
          default: "file",
          caseInsensitive: false,
        },
      },
      {
        source: "archivalHistory",
        target: "provenance",
        transform: {
          kind: "concatenate",
          parts: [{ column: "archivalHistory", label: "Historia" }],
          separator: " — ",
        },
      },
      {
        source: "language",
        target: "language",
        transform: { kind: "splitRejoin", inputSeparator: "|", outputSeparator: "; " },
      },
      {
        source: "eventStartDates",
        target: "dateStart",
        transform: { kind: "date", yearMin: 1500, yearMax: 1900 },
      },
    ];
    const owner = await createTestUser({ isAdmin: true });
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "Full fat",
      bindings: fullFat,
      sharedWithFederation: false,
      userId: owner.id,
    });
    if (!created.ok) throw new Error("seed failed");
    const before = await db().select().from(importProfiles).all();

    // Simulate the editor's load-then-save with only the name edited:
    // rows are hydrated from the stored JSON and serialized straight back.
    const { rowsFromBindings, bindingsFromRows } = await import(
      "../../app/lib/import/profile-editor"
    );
    const resubmitted = JSON.stringify(
      bindingsFromRows(rowsFromBindings(before[0].bindings)),
    );

    const user = await adminUser();
    const { action } = await import(ROUTE);
    const res = await action({
      request: saveRequest({ name: "Full fat renamed", bindings: resubmitted }),
      context: buildContext(user),
      params: { profileId: created.id },
    } as any);
    expect((res as Response).status).toBe(302);

    const after = await db().select().from(importProfiles).all();
    expect(after[0].name).toBe("Full fat renamed");
    // No version bump: the bindings did not change.
    expect(after[0].version).toBe(1);
    // No parameter loss: the stored JSON is byte-identical.
    expect(after[0].bindings).toBe(before[0].bindings);
  });

  it("surfaces duplicate_name when creating a second profile with the same name", async () => {
    await seedProfile(); // name "Seed"
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const res = (await action({
      request: saveRequest({ name: "Seed", bindings: JSON.stringify(validBindings) }),
      context: buildContext(user),
      params: { profileId: "new" },
    } as any)) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("duplicate_name");
  });

  it("deletes a profile", async () => {
    const id = await seedProfile();
    const user = await adminUser();
    const { action } = await import(ROUTE);
    const form = new FormData();
    form.set("intent", "delete");
    const req = new Request(`http://neogranadina.fisqua.test/admin/imports/profiles/${id}`, {
      method: "POST",
      body: form,
    });
    const res = await action({
      request: req,
      context: buildContext(user),
      params: { profileId: id },
    } as any);
    expect((res as Response).status).toBe(302);
    expect(await db().select().from(importProfiles).all()).toHaveLength(0);
  });

  it("shows a lead's shared profile read-only to a member, and refuses a member save", async () => {
    const id = await seedProfile(true, NEOGRANADINA_TENANT_ID);
    const memberTenant = makeTenantContext({
      id: MEMBER_TENANT_ID,
      slug: "member-x",
      federationId: NEOGRANADINA_FEDERATION_ID,
      importsEnabled: true,
    });
    const user = await adminUser();
    const { loader, action } = await import(ROUTE);

    const data = (await loader({
      request: new Request(`http://member-x.fisqua.test/admin/imports/profiles/${id}`),
      context: buildContext(user, memberTenant),
      params: { profileId: id },
    } as any)) as any;
    expect(data.readOnly).toBe(true);

    const res = (await action({
      request: saveRequest({ name: "hijack", bindings: JSON.stringify(validBindings) }),
      context: buildContext(user, memberTenant),
      params: { profileId: id },
    } as any)) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("not_found");
  });

  it("404s the loader for a profile the tenant cannot see", async () => {
    const id = await seedProfile(false, NEOGRANADINA_TENANT_ID);
    const memberTenant = makeTenantContext({
      id: MEMBER_TENANT_ID,
      federationId: NEOGRANADINA_FEDERATION_ID,
      importsEnabled: true,
    });
    const user = await adminUser();
    const { loader } = await import(ROUTE);
    try {
      await loader({
        request: new Request(`http://member-x.fisqua.test/admin/imports/profiles/${id}`),
        context: buildContext(user, memberTenant),
        params: { profileId: id },
      } as any);
      expect.fail("should have 404ed");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  // A real member tenant ROW in the Neogranadina federation, for tests
  // whose writes must satisfy the tenants FK (unlike the context-only
  // MEMBER_TENANT_ID fixtures above, which never insert).
  async function seedMemberTenantRow(): Promise<void> {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
        "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
        "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        MEMBER_TENANT_ID, "member-x", "Member X", "tenant", "isadg", "active",
        0, 1, 0, 0,
        null, NEOGRANADINA_FEDERATION_ID, now, now,
      )
      .run();
  }

  it("loader reports federation-lead status (lead true, member false)", async () => {
    await seedMemberTenantRow();
    const user = await adminUser();
    const { loader } = await import(ROUTE);

    const leadData = (await loader({
      request: new Request("http://neogranadina.fisqua.test/admin/imports/profiles/new"),
      context: buildContext(user),
      params: { profileId: "new" },
    } as any)) as any;
    expect(leadData.isFederationLead).toBe(true);

    const memberTenant = makeTenantContext({
      id: MEMBER_TENANT_ID,
      slug: "member-x",
      federationId: NEOGRANADINA_FEDERATION_ID,
      importsEnabled: true,
    });
    const memberData = (await loader({
      request: new Request("http://member-x.fisqua.test/admin/imports/profiles/new"),
      context: buildContext(user, memberTenant),
      params: { profileId: "new" },
    } as any)) as any;
    expect(memberData.isFederationLead).toBe(false);
  });

  it("ignores a posted share flag from a non-lead tenant", async () => {
    await seedMemberTenantRow();
    const memberUser = await createTestUser({
      isAdmin: true,
      tenantId: MEMBER_TENANT_ID,
    });
    const memberTenant = makeTenantContext({
      id: MEMBER_TENANT_ID,
      slug: "member-x",
      federationId: NEOGRANADINA_FEDERATION_ID,
      importsEnabled: true,
    });
    const ctxUser = makeUserContext({
      id: memberUser.id,
      tenantId: MEMBER_TENANT_ID,
      isAdmin: true,
    });
    const { action } = await import(ROUTE);
    const res = await action({
      request: saveRequest({
        name: "Member profile",
        bindings: JSON.stringify(validBindings),
        sharedWithFederation: "on",
      }),
      context: buildContext(ctxUser, memberTenant),
      params: { profileId: "new" },
    } as any);
    expect((res as Response).status).toBe(302);

    const rows = await db().select().from(importProfiles).all();
    expect(rows).toHaveLength(1);
    // Sharing is a lead-only act; the member's posted flag is ignored.
    expect(rows[0].sharedWithFederation as unknown as boolean).toBe(false);
  });
});
