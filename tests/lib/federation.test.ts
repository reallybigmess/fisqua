/**
 * Tests - federation grants + steward authorization (federation step 4)
 *
 * The authz matrix for the grant model (federation spec §4/§5, ruled
 * additions 2026-07-07/08). Fixtures put a MEMBER tenant inside the
 * Neogranadina federation (whose lead is the neogranadina tenant) so the
 * cross-tenant paths are real, then exercise:
 *
 *   - resolveGrant across home / grant / none × steward / staff ×
 *     active / suspended (federation and tenant) - invariant I2.
 *   - grantEffectiveRoleFlags / applyGrantEffectiveRole - staff never
 *     confers administration, steward is admin-equivalent (invariant I6).
 *   - requireTenantUser's grant branch (unit) - home / matching-grant /
 *     mismatched-federation-grant / none.
 *   - isFederationSteward / requireFederationSteward - the authority
 *     mutation gate: lead admin (home) allowed, member admin denied,
 *     steward grant allowed, staff grant denied (ruled 2026-07-08 + I6).
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { requireTenantUser } from "../../app/lib/tenant";
import {
  resolveGrant,
  grantEffectiveRoleFlags,
  applyGrantEffectiveRole,
  isFederationSteward,
  requireFederationSteward,
  assertStewardProvisioningEnabled,
  type Federation,
} from "../../app/lib/federation.server";
import type { Tenant, User } from "../../app/context";

// A member tenant inside the Neogranadina federation (its lead is the
// neogranadina tenant). This is the tenant grant-holders reach into.
const MEMBER_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// User ids for the matrix.
const LEAD_ADMIN_ID = "1a000000-0000-4000-8000-000000000001";
const MEMBER_ADMIN_ID = "1a000000-0000-4000-8000-000000000002";
const STEWARD_GRANT_ID = "1a000000-0000-4000-8000-000000000003";
const STAFF_GRANT_ID = "1a000000-0000-4000-8000-000000000004";
const OUTSIDER_ID = "1a000000-0000-4000-8000-000000000005";

function makeUser(overrides: Partial<User> & Pick<User, "id" | "tenantId">): User {
  return {
    email: `${overrides.id}@test.local`,
    name: null,
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    lastActiveAt: null,
    githubId: null,
    ...overrides,
  };
}

async function seedFixtures(): Promise<void> {
  const now = Date.now();
  // Member tenant in the Neogranadina federation.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      MEMBER_TENANT_ID, "member-tenant", "Member Tenant", "tenant", "isadg", "active",
      1, 1, 1, 0, null, NEOGRANADINA_FEDERATION_ID, now, now,
    )
    .run();

  // Users. Home tenants: lead/steward/staff live in the lead
  // (neogranadina) tenant; the member admin lives in the member tenant;
  // the outsider lives in a different federation (second-tenant).
  const users: Array<[string, string, boolean]> = [
    [LEAD_ADMIN_ID, NEOGRANADINA_TENANT_ID, true],
    [MEMBER_ADMIN_ID, MEMBER_TENANT_ID, true],
    [STEWARD_GRANT_ID, NEOGRANADINA_TENANT_ID, true],
    [STAFF_GRANT_ID, NEOGRANADINA_TENANT_ID, true],
    [OUTSIDER_ID, SECOND_TEST_TENANT_ID, true],
  ];
  for (const [id, tenantId, isAdmin] of users) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, tenant_id, email, is_admin, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(id, tenantId, `${id}@test.local`, isAdmin ? 1 : 0, now, now)
      .run();
  }

  // Memberships in the Neogranadina federation.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_memberships (id, user_id, federation_id, role, created_at) VALUES (?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), STEWARD_GRANT_ID, NEOGRANADINA_FEDERATION_ID, "steward", now)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federation_memberships (id, user_id, federation_id, role, created_at) VALUES (?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), STAFF_GRANT_ID, NEOGRANADINA_FEDERATION_ID, "staff", now)
    .run();
}

async function loadTenant(id: string): Promise<Tenant> {
  const db = drizzle(env.DB, { schema });
  const row = await db.select().from(schema.tenants).where(eq(schema.tenants.id, id)).get();
  if (!row) throw new Error(`tenant ${id} not seeded`);
  return row as Tenant;
}

async function setFederationStatus(status: "active" | "suspended"): Promise<void> {
  await env.DB.prepare("UPDATE federations SET status = ? WHERE id = ?")
    .bind(status, NEOGRANADINA_FEDERATION_ID)
    .run();
}

async function setMemberTenant(fields: {
  status?: "active" | "suspended";
  disabledAt?: number | null;
}): Promise<void> {
  if (fields.status !== undefined) {
    await env.DB.prepare("UPDATE tenants SET status = ? WHERE id = ?")
      .bind(fields.status, MEMBER_TENANT_ID)
      .run();
  }
  if (fields.disabledAt !== undefined) {
    await env.DB.prepare("UPDATE tenants SET disabled_at = ? WHERE id = ?")
      .bind(fields.disabledAt, MEMBER_TENANT_ID)
      .run();
  }
}

describe("federation grants + steward authorization", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedFixtures();
  });

  describe("resolveGrant - home / grant / none", () => {
    it("home access returns null (a grant is only ever cross-tenant)", async () => {
      const db = drizzle(env.DB);
      const memberAdmin = makeUser({ id: MEMBER_ADMIN_ID, tenantId: MEMBER_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await resolveGrant(db, memberAdmin, member)).toBeNull();
    });

    it("steward membership grants access with role 'steward'", async () => {
      const db = drizzle(env.DB);
      const steward = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      const grant = await resolveGrant(db, steward, member);
      expect(grant).not.toBeNull();
      expect(grant!.role).toBe("steward");
      expect(grant!.federationId).toBe(NEOGRANADINA_FEDERATION_ID);
      expect(grant!.homeTenantId).toBe(NEOGRANADINA_TENANT_ID);
    });

    it("staff membership grants access with role 'staff'", async () => {
      const db = drizzle(env.DB);
      const staff = makeUser({ id: STAFF_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      const grant = await resolveGrant(db, staff, member);
      expect(grant!.role).toBe("staff");
    });

    it("no membership -> null (a lead admin without a membership cannot reach a member tenant)", async () => {
      const db = drizzle(env.DB);
      const leadAdmin = makeUser({ id: LEAD_ADMIN_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await resolveGrant(db, leadAdmin, member)).toBeNull();
    });

    it("outsider in a different federation -> null", async () => {
      const db = drizzle(env.DB);
      const outsider = makeUser({ id: OUTSIDER_ID, tenantId: SECOND_TEST_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await resolveGrant(db, outsider, member)).toBeNull();
    });
  });

  describe("resolveGrant - active / suspended (invariant I2)", () => {
    it("a suspended federation denies an otherwise-valid steward grant", async () => {
      const db = drizzle(env.DB);
      await setFederationStatus("suspended");
      const steward = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await resolveGrant(db, steward, member)).toBeNull();
    });

    it("a suspended member tenant denies the grant", async () => {
      const db = drizzle(env.DB);
      await setMemberTenant({ status: "suspended" });
      const steward = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await resolveGrant(db, steward, member)).toBeNull();
    });

    it("a soft-disabled member tenant denies the grant", async () => {
      const db = drizzle(env.DB);
      await setMemberTenant({ disabledAt: Date.now() });
      const staff = makeUser({ id: STAFF_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await resolveGrant(db, staff, member)).toBeNull();
    });
  });

  describe("effective role mapping (invariant I6)", () => {
    it("staff maps to cataloguer-only; NEVER any administrative flag", () => {
      const flags = grantEffectiveRoleFlags("staff");
      expect(flags.isCataloguer).toBe(true);
      expect(flags.isAdmin).toBe(false);
      expect(flags.isSuperAdmin).toBe(false);
      expect(flags.isCollabAdmin).toBe(false);
      expect(flags.isUserManager).toBe(false);
    });

    it("steward maps to admin-equivalent but NOT superadmin", () => {
      const flags = grantEffectiveRoleFlags("steward");
      expect(flags.isAdmin).toBe(true);
      expect(flags.isCollabAdmin).toBe(true);
      expect(flags.isUserManager).toBe(true);
      expect(flags.isCataloguer).toBe(true);
      expect(flags.isSuperAdmin).toBe(false);
    });

    it("applyGrantEffectiveRole overrides flags but preserves identity + home tenant", () => {
      const homeAdmin = makeUser({
        id: STAFF_GRANT_ID,
        tenantId: NEOGRANADINA_TENANT_ID,
        isAdmin: true,
        isSuperAdmin: true,
      });
      const effective = applyGrantEffectiveRole(homeAdmin, {
        role: "staff",
        federationId: NEOGRANADINA_FEDERATION_ID,
        homeTenantId: NEOGRANADINA_TENANT_ID,
      });
      // Identity + home preserved.
      expect(effective.id).toBe(STAFF_GRANT_ID);
      expect(effective.tenantId).toBe(NEOGRANADINA_TENANT_ID);
      // Home admin/superadmin are stripped in the member tenant (I6).
      expect(effective.isAdmin).toBe(false);
      expect(effective.isSuperAdmin).toBe(false);
      expect(effective.isCataloguer).toBe(true);
    });
  });

  describe("requireTenantUser grant branch (unit)", () => {
    it("admits home access", async () => {
      const member = await loadTenant(MEMBER_TENANT_ID);
      const memberUser = makeUser({ id: MEMBER_ADMIN_ID, tenantId: MEMBER_TENANT_ID });
      expect(() => requireTenantUser(member, memberUser)).not.toThrow();
    });

    it("admits a grant whose federation matches the tenant's", async () => {
      const member = await loadTenant(MEMBER_TENANT_ID);
      const grantHolder = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID });
      expect(() =>
        requireTenantUser(member, grantHolder, {
          grant: { federationId: NEOGRANADINA_FEDERATION_ID },
        }),
      ).not.toThrow();
    });

    it("rejects a grant whose federation does NOT match the tenant's", async () => {
      const member = await loadTenant(MEMBER_TENANT_ID);
      const grantHolder = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID });
      expect(() =>
        requireTenantUser(member, grantHolder, {
          grant: { federationId: "some-other-federation" },
        }),
      ).toThrow();
    });

    it("rejects a cross-tenant user with no grant and no impersonation", async () => {
      const member = await loadTenant(MEMBER_TENANT_ID);
      const outsider = makeUser({ id: OUTSIDER_ID, tenantId: SECOND_TEST_TENANT_ID });
      expect(() => requireTenantUser(member, outsider)).toThrow();
    });
  });

  describe("isFederationSteward - authority mutation gate (ruled 2026-07-08)", () => {
    it("a home admin on the federation's LEAD tenant is a steward", async () => {
      const db = drizzle(env.DB);
      const leadAdmin = makeUser({ id: LEAD_ADMIN_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: true });
      const lead = await loadTenant(NEOGRANADINA_TENANT_ID);
      expect(await isFederationSteward(db, leadAdmin, lead)).toBe(true);
      await expect(requireFederationSteward(db, leadAdmin, lead)).resolves.toBeUndefined();
    });

    it("a member-tenant admin is NOT a steward (READ ok, mutation denied)", async () => {
      const db = drizzle(env.DB);
      const memberAdmin = makeUser({ id: MEMBER_ADMIN_ID, tenantId: MEMBER_TENANT_ID, isAdmin: true });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await isFederationSteward(db, memberAdmin, member)).toBe(false);
      await expect(requireFederationSteward(db, memberAdmin, member)).rejects.toMatchObject({
        status: 403,
      });
    });

    it("a steward grant confers stewardship in the member tenant", async () => {
      const db = drizzle(env.DB);
      // Under a grant the middleware overrides flags; model that by
      // clearing isAdmin - the steward membership (branch B) must still
      // qualify regardless of the effective flags.
      const stewardGrant = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: false });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await isFederationSteward(db, stewardGrant, member)).toBe(true);
    });

    it("a staff grant does NOT confer stewardship (invariant I6)", async () => {
      const db = drizzle(env.DB);
      const staffGrant = makeUser({ id: STAFF_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: false });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await isFederationSteward(db, staffGrant, member)).toBe(false);
    });

    it("a suspended federation makes even a steward not a steward", async () => {
      const db = drizzle(env.DB);
      await setFederationStatus("suspended");
      const stewardGrant = makeUser({ id: STEWARD_GRANT_ID, tenantId: NEOGRANADINA_TENANT_ID, isAdmin: false });
      const member = await loadTenant(MEMBER_TENANT_ID);
      expect(await isFederationSteward(db, stewardGrant, member)).toBe(false);
    });
  });

  describe("assertStewardProvisioningEnabled - the multiMemberEnabled 404 gate", () => {
    it("passes when the federation may have members", () => {
      const fed = { multiMemberEnabled: true } as Federation;
      expect(() => assertStewardProvisioningEnabled(fed)).not.toThrow();
    });

    it("404s on a federation-of-one (multiMemberEnabled off)", () => {
      const fed = { multiMemberEnabled: false } as Federation;
      expect(() => assertStewardProvisioningEnabled(fed)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    });
  });
});
