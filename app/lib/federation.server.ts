/**
 * Federation grants + steward authorization
 *
 * This module deals with the request-time authorization primitives that
 * sit one scoping level above `app/lib/tenant.ts`: federation grants and
 * federation stewardship. It is the single home for how a
 * `federation_memberships` row (migration 0049) becomes access into a
 * member tenant and an effective role there, and for who may mutate the
 * federation-shared authority space.
 *
 * Three responsibilities:
 *
 *   - `resolveGrant` decides whether a user whose HOME tenant is not the
 *     request tenant nonetheless reaches it through a federation
 *     membership (generalising the platform -> tenant impersonation
 *     mechanism one level down, federation spec §4). Default-deny: no
 *     live membership, no access; a suspended federation or a
 *     suspended/disabled tenant closes the path (invariant I2). The
 *     middleware calls it and threads the result into
 *     `requireTenantUser`'s grant branch and into `grantContext`.
 *
 *   - `grantEffectiveRoleFlags` / `applyGrantEffectiveRole` map the
 *     federation role to the role flags the grant-holder carries IN the
 *     member tenant, computed per request and never written to the
 *     member tenant's `users` table. `staff` maps to a
 *     cataloguer/editor-equivalent that NEVER confers member-tenant
 *     administration; `steward` maps to admin-equivalent (invariant I6).
 *     Unlike the operator impersonation envelope -- which logs in as the
 *     operator's own user row and leaves its flags untouched -- a grant
 *     genuinely overrides the acting flags, because a home-tenant admin
 *     who is only federation `staff` must NOT gain admin in a member
 *     tenant. The override is the mechanism that makes I6 true.
 *
 *   - `isFederationSteward` / `requireFederationSteward` gate every
 *     mutation of the federation-shared authorities (entities, places,
 *     canonical vocabulary). Ruled 2026-07-08: member-tenant admins keep
 *     READ access to the shared authority space, but every MUTATION is
 *     subject to federation steward review -- so the mutation surfaces
 *     require either a home admin on the federation's LEAD tenant or a
 *     `steward` grant. `assertStewardProvisioningEnabled` is the
 *     companion 404-gate for steward tenant-management surfaces, which
 *     exist only when the federation may have members at all
 *     (`multi_member_enabled`, spec §5).
 *
 * Audit: grant-access WRITES in a member tenant are captured at the
 * middleware envelope (a single chokepoint, mirroring where
 * `requireTenantUser` runs) via `logGrantWrite`, which records an
 * `edit_on_behalf` row with actor = the grant-holder's home tenant and
 * target = the member tenant (invariant I6). Reads are not audited,
 * consistent with the operator-surface precedent in `audit.server.ts`.
 *
 * @version v0.4.2
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { auditLog, federationMemberships, federations } from "../db/schema";
import type { Tenant, User } from "../context";

/** The two federation roles (federation spec §5). Bounded enum; the DB
 * CHECK in migration 0049 is the runtime guard, this constant is the
 * compile-time one. */
export const FEDERATION_ROLES = ["steward", "staff"] as const;
export type FederationRole = (typeof FEDERATION_ROLES)[number];

/** Drizzle row shape for a `federations` row. */
export type Federation = typeof federations.$inferSelect;

/**
 * The role-flag surface a grant-access user carries in the member
 * tenant. Mirrors the six role flags on `User`. Computed per request
 * from the federation role; never persisted to the member tenant.
 */
export interface GrantRoleFlags {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
}

/**
 * Map a federation role to the effective member-tenant role flags
 * (federation spec §5, invariant I6).
 *
 *   - `steward` -> admin-equivalent: full member-tenant setup and
 *     management. Deliberately NOT `isSuperAdmin` -- publish / promote /
 *     role-flipping stay federation-lead / platform concerns, and the
 *     tenant-admin lifecycle (create/assign/reset member-tenant admins)
 *     runs through the steward provisioning surfaces gated by
 *     `assertStewardProvisioningEnabled`, not through a member-tenant
 *     superadmin flag.
 *   - `staff` -> cataloguer/editor-equivalent. Every administrative flag
 *     is false: staff access NEVER confers member-tenant administration
 *     (I6).
 */
export function grantEffectiveRoleFlags(role: FederationRole): GrantRoleFlags {
  switch (role) {
    case "steward":
      return {
        isAdmin: true,
        isSuperAdmin: false,
        isCollabAdmin: true,
        isArchiveUser: false,
        isUserManager: true,
        isCataloguer: true,
      };
    case "staff":
      return {
        isAdmin: false,
        isSuperAdmin: false,
        isCollabAdmin: false,
        isArchiveUser: false,
        isUserManager: false,
        isCataloguer: true,
      };
  }
}

/**
 * A resolved grant: the effective access a user has into a member
 * tenant of a federation they hold a membership in.
 */
export interface GrantAccess {
  /** The membership's federation role. */
  role: FederationRole;
  /** The federation the membership covers -- equal to `tenant.federationId`
   * at the point the grant resolves; carried so `requireTenantUser`'s
   * branch can re-assert the match without another lookup. */
  federationId: string;
  /** The grant-holder's HOME tenant (audit actor tenant; also what the
   * grant does NOT change -- identity stays home-rooted). */
  homeTenantId: string;
}

/**
 * Resolve whether `user` reaches `tenant` through a federation grant.
 * Returns the grant, or `null` for default-deny.
 *
 * Returns `null` immediately (no DB query) on the hot path where the
 * user is home (`user.tenantId === tenant.id`) -- a grant is only ever a
 * cross-tenant construct. Otherwise a grant requires ALL of:
 *   - the target tenant is live (not suspended, not soft-disabled);
 *   - the tenant's federation exists and is active;
 *   - a `federation_memberships` row for `(user, tenant.federationId)`.
 * (federation spec §4, invariant I2.)
 */
export async function resolveGrant(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
): Promise<GrantAccess | null> {
  // Home access is not a grant. Short-circuit before any DB read so the
  // common same-tenant request adds zero query overhead.
  if (user.tenantId === tenant.id) return null;

  // A suspended or soft-disabled member tenant closes the path.
  if (tenant.status === "suspended" || tenant.disabledAt !== null) return null;

  // The federation itself must be active.
  const fed = await db
    .select({ status: federations.status })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  if (!fed || fed.status !== "active") return null;

  // Live membership covering the tenant's federation.
  const membership = await db
    .select({ role: federationMemberships.role })
    .from(federationMemberships)
    .where(
      and(
        eq(federationMemberships.userId, user.id),
        eq(federationMemberships.federationId, tenant.federationId),
      ),
    )
    .get();
  if (!membership) return null;

  return {
    role: membership.role as FederationRole,
    federationId: tenant.federationId,
    homeTenantId: user.tenantId,
  };
}

/**
 * Return a copy of `user` with the grant's effective member-tenant role
 * flags applied. Identity (id, email, name, githubId) and the HOME
 * `tenantId` are preserved -- a grant does not move the user's home; the
 * member tenant a request targets is read from `tenantContext`, not from
 * `user.tenantId`. Downstream role gates (`requireAdmin`, project-role
 * checks) then see the effective flags, which is what enforces I6.
 */
export function applyGrantEffectiveRole(user: User, grant: GrantAccess): User {
  return { ...user, ...grantEffectiveRoleFlags(grant.role) };
}

/**
 * Whether `user` is a federation steward for `tenant` -- the gate for
 * every authority-mutation surface (ruled 2026-07-08). True when EITHER:
 *
 *   (A) `user` has HOME access to the federation's LEAD tenant with the
 *       admin role -- the common case, since federation-lead staff
 *       (Neogranadina) run the shared authority space from the lead
 *       host; or
 *   (B) `user` holds a `steward` federation membership covering the
 *       tenant's federation (a steward whose home tenant is not the
 *       lead).
 *
 * A member-tenant admin is neither: on their own host, `tenant` is the
 * member (not the lead), so (A) fails, and they hold no steward
 * membership, so (B) fails -- their authority mutations are denied while
 * their READ access is untouched. A `staff` grant never qualifies
 * (invariant I6): (A) needs home access to the lead, (B) needs the
 * `steward` role specifically.
 *
 * Today this is behaviour-neutral: every federation has exactly one
 * tenant (its lead), so branch (A) admits exactly the current single
 * admin population. It is encoded now so the denial path is already
 * correct when step 6 provisions the first member tenant.
 */
export async function isFederationSteward(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
): Promise<boolean> {
  const fed = await db
    .select({
      leadTenantId: federations.leadTenantId,
      status: federations.status,
    })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  if (!fed || fed.status !== "active") return false;

  // (A) Home admin on the federation's lead tenant. `user.tenantId ===
  // tenant.id` guarantees home access, so no grant (which always has
  // `user.tenantId !== tenant.id`) can ride this branch and the
  // effective-role override never affects it.
  if (
    user.tenantId === tenant.id &&
    tenant.id === fed.leadTenantId &&
    user.isAdmin
  ) {
    return true;
  }

  // (B) Explicit steward membership covering this federation.
  const membership = await db
    .select({ id: federationMemberships.id })
    .from(federationMemberships)
    .where(
      and(
        eq(federationMemberships.userId, user.id),
        eq(federationMemberships.federationId, tenant.federationId),
        eq(federationMemberships.role, "steward"),
      ),
    )
    .get();
  return membership !== undefined;
}

/**
 * Throw a bare 403 unless `user` is a federation steward for `tenant`.
 * Drop into an authority-mutation action after the existing
 * `requireAdmin(user)` + `const tenant = context.get(tenantContext)`
 * pair. Member-tenant admins are rejected here with the same 403 shape
 * their other forbidden paths use; the clean denial leaves room for the
 * member-side propose-for-review flow (a later work item, not step 4).
 */
export async function requireFederationSteward(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
): Promise<void> {
  if (!(await isFederationSteward(db, user, tenant))) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * 404-gate for steward tenant-management / provisioning surfaces. Such
 * surfaces exist only when the federation may have members at all
 * (`multi_member_enabled`, spec §5, ruled 2026-07-07) -- otherwise a bare
 * 404, matching `requireCapability`'s disabled-surface shape so a
 * provisioning route is externally indistinguishable from a missing one
 * on a federation-of-one. Pair with `requireFederationSteward` for the
 * authorization half.
 */
export function assertStewardProvisioningEnabled(federation: Federation): void {
  if (!federation.multiMemberEnabled) {
    throw new Response(null, { status: 404 });
  }
}

/**
 * Audit a grant-access WRITE in a member tenant (invariant I6). Records
 * an `edit_on_behalf` row with actor = the grant-holder + their HOME
 * tenant and target = the member tenant. Called from the auth middleware
 * for mutating requests under a live grant -- a single chokepoint, so
 * every steward/staff write in a member tenant is captured with
 * actor/target tenants without wiring audit into each action. Reads are
 * not audited (consistent with the operator-surface precedent in
 * `audit.server.ts`).
 *
 * Inserted directly (not via `withAuditLog`): there is no co-batched
 * "work" statement here -- the audited action runs later in its own
 * loader/action. `audit_log`'s immutability triggers block UPDATE/DELETE
 * only, so a plain INSERT is legal.
 */
export async function logGrantWrite(
  db: DrizzleD1Database<any>,
  user: User,
  tenant: Tenant,
  grant: GrantAccess,
  request: Request,
): Promise<void> {
  const url = new URL(request.url);
  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    actorUserId: user.id,
    actorUserIdText: user.email,
    actorTenantId: grant.homeTenantId,
    action: "edit_on_behalf",
    targetTenantId: tenant.id,
    targetObjectKind: "grant_write",
    targetObjectId: null,
    impersonationSessionId: null,
    details: JSON.stringify({
      role: grant.role,
      method: request.method,
      path: url.pathname,
    }),
  });
}
