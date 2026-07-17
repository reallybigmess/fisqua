/**
 * Tests — import profiles CRUD + federation-shared visibility
 *
 * This suite pins profile lifecycle against D1: create (version 1),
 * update (version bumped, `updatedBy` / `updatedAt` stamped), delete,
 * cross-tenant isolation, and the spec §7.3 sharing rule — a lead-owned
 * `sharedWithFederation` profile is visible READ-ONLY to a member
 * tenant, an unshared one is not, and a member cannot update it.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { makeTenantContext } from "../helpers/context";
import {
  NEOGRANADINA_FEDERATION_ID,
  NEOGRANADINA_TENANT_ID,
} from "../../app/lib/tenant";
import {
  createProfile,
  updateProfile,
  deleteProfile,
  listOwnProfiles,
  listSharedProfiles,
  getVisibleProfile,
  federationLeadTenantId,
} from "../../app/lib/import/profiles.server";

const MEMBER_TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function db() {
  return drizzle(env.DB);
}

const validBindings = [
  { source: "identifier", target: "referenceCode" },
  { source: "title", target: "title", transform: { kind: "direct" } as const },
];

async function seedUser() {
  return createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
}

describe("import profiles CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates a profile at version 1 with valid bindings", async () => {
    const user = await seedUser();
    const res = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "AtoM ISAD(G)",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(1);

    const own = await listOwnProfiles(db(), DEFAULT_TEST_TENANT_ID);
    expect(own).toHaveLength(1);
    expect(own[0].name).toBe("AtoM ISAD(G)");
  });

  it("rejects bindings with a target invalid for the standard", async () => {
    const user = await seedUser();
    const res = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "Bad",
      bindings: [
        { source: "identifier", target: "referenceCode" },
        { source: "x", target: "notAColumn" },
      ],
      sharedWithFederation: false,
      userId: user.id,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("invalid_bindings");
    expect(res.issues).toContain("invalid_target:notAColumn");
  });

  it("rejects bindings with no referenceCode target", async () => {
    const user = await seedUser();
    const res = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "NoRef",
      bindings: [{ source: "title", target: "title" }],
      sharedWithFederation: false,
      userId: user.id,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues).toContain("reference_code_binding_required");
  });

  it("bumps version and stamps updatedBy on edit", async () => {
    const author = await seedUser();
    const editor = await createTestUser({ isAdmin: true });
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "P",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: author.id,
    });
    if (!created.ok) throw new Error("create failed");

    const updated = await updateProfile(db(), created.id, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "P renamed",
      bindings: [
        ...validBindings,
        { source: "eventStartDates", target: "dateStart", transform: { kind: "date" } as const },
      ],
      sharedWithFederation: true,
      userId: editor.id,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.version).toBe(2);

    const row = await getVisibleProfile(
      db(),
      makeTenantContext({ id: DEFAULT_TEST_TENANT_ID }),
      created.id,
    );
    expect(row!.version).toBe(2);
    expect(row!.name).toBe("P renamed");
    expect(row!.updatedBy).toBe(editor.id);
    expect(row!.sharedWithFederation).toBe(true);
  });

  it("refuses to update a profile owned by another tenant", async () => {
    const user = await seedUser();
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "P",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!created.ok) throw new Error("create failed");

    const res = await updateProfile(db(), created.id, {
      tenantId: MEMBER_TENANT_ID,
      standard: "isadg",
      name: "hijacked",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("not_found");
  });

  it("returns duplicate_name when creating a second profile with the same name", async () => {
    const user = await seedUser();
    const make = () =>
      createProfile(db(), {
        tenantId: DEFAULT_TEST_TENANT_ID,
        standard: "isadg",
        name: "Same name",
        bindings: validBindings,
        sharedWithFederation: false,
        userId: user.id,
      });
    expect((await make()).ok).toBe(true);
    const second = await make();
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toBe("duplicate_name");
  });

  it("returns duplicate_name when renaming onto an existing name", async () => {
    const user = await seedUser();
    const a = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "A",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    const b = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "B",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!a.ok || !b.ok) throw new Error("seed failed");

    const renamed = await updateProfile(db(), b.id, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "A",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    expect(renamed.ok).toBe(false);
    if (renamed.ok) return;
    expect(renamed.error).toBe("duplicate_name");
  });

  it("does NOT bump version on a name-only or share-only edit", async () => {
    const user = await seedUser();
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "Stable",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!created.ok) throw new Error("create failed");

    const renamed = await updateProfile(db(), created.id, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "Stable renamed",
      bindings: validBindings,
      sharedWithFederation: true,
      userId: user.id,
    });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.version).toBe(1);

    const row = await getVisibleProfile(
      db(),
      makeTenantContext({ id: DEFAULT_TEST_TENANT_ID }),
      created.id,
    );
    expect(row!.version).toBe(1);
    expect(row!.name).toBe("Stable renamed");
    expect(row!.sharedWithFederation).toBe(true);
  });

  it("DOES bump version when the bindings change", async () => {
    const user = await seedUser();
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "Versioned",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!created.ok) throw new Error("create failed");

    const edited = await updateProfile(db(), created.id, {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "Versioned",
      bindings: [
        ...validBindings,
        { source: "extentAndMedium", target: "extent" },
      ],
      sharedWithFederation: false,
      userId: user.id,
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.version).toBe(2);
  });

  it("deletes only the tenant's own profile", async () => {
    const user = await seedUser();
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: "P",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!created.ok) throw new Error("create failed");

    expect(await deleteProfile(db(), MEMBER_TENANT_ID, created.id)).toBe(false);
    expect(await deleteProfile(db(), DEFAULT_TEST_TENANT_ID, created.id)).toBe(true);
    expect(await listOwnProfiles(db(), DEFAULT_TEST_TENANT_ID)).toHaveLength(0);
  });
});

describe("federation-shared visibility (spec §7.3)", () => {
  // The member tenant is a context object in the Neogranadina federation
  // (lead = neogranadina). It owns no profiles; it only reads the lead's.
  const memberTenant = makeTenantContext({
    id: MEMBER_TENANT_ID,
    slug: "member-x",
    federationId: NEOGRANADINA_FEDERATION_ID,
  });

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("resolves the federation lead tenant id", async () => {
    const leadId = await federationLeadTenantId(db(), memberTenant);
    expect(leadId).toBe(NEOGRANADINA_TENANT_ID);
  });

  it("shows a lead's shared profile read-only to a member", async () => {
    const user = await seedUser();
    const created = await createProfile(db(), {
      tenantId: NEOGRANADINA_TENANT_ID,
      standard: "isadg",
      name: "Shared starter",
      bindings: validBindings,
      sharedWithFederation: true,
      userId: user.id,
    });
    if (!created.ok) throw new Error("create failed");

    const shared = await listSharedProfiles(db(), memberTenant);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe("Shared starter");

    const visible = await getVisibleProfile(db(), memberTenant, created.id);
    expect(visible).not.toBeNull();
    expect(visible!.readOnly).toBe(true);
  });

  it("hides an unshared lead profile from a member", async () => {
    const user = await seedUser();
    const created = await createProfile(db(), {
      tenantId: NEOGRANADINA_TENANT_ID,
      standard: "isadg",
      name: "Private",
      bindings: validBindings,
      sharedWithFederation: false,
      userId: user.id,
    });
    if (!created.ok) throw new Error("create failed");

    expect(await listSharedProfiles(db(), memberTenant)).toHaveLength(0);
    expect(await getVisibleProfile(db(), memberTenant, created.id)).toBeNull();
  });

  it("does not list a tenant's own profiles as shared-in", async () => {
    const user = await seedUser();
    await createProfile(db(), {
      tenantId: NEOGRANADINA_TENANT_ID,
      standard: "isadg",
      name: "Own shared",
      bindings: validBindings,
      sharedWithFederation: true,
      userId: user.id,
    });
    // The lead itself sees no "shared-in" profiles (its own are in own list).
    const leadTenant = makeTenantContext({ id: NEOGRANADINA_TENANT_ID });
    expect(await listSharedProfiles(db(), leadTenant)).toHaveLength(0);
  });
});
