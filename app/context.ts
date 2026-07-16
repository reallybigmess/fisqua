/**
 * User Context
 *
 * This module deals with the typed slots that `authMiddleware` uses to
 * hand the signed-in user, the resolved tenant, and the impersonation
 * envelope to every loader and action in the authenticated tree.
 * Reading them in a
 * loader or action looks like `const user = context.get(userContext)` --
 * the middleware guarantees it is populated, so route code can assume
 * the user exists without re-querying the database.
 *
 * The `User` shape also defines the role-flag surface that gates access
 * across the app. A plain `isAdmin` is no longer enough at v0.3 -- the
 * admin back-office splits responsibilities across five role flags:
 *
 *   - `isSuperAdmin` unlocks the publish pipeline and promote, and is
 *     the only role that can flip other users' role flags.
 *   - `isCollabAdmin` unlocks project management, team invites, and
 *     the cross-project dashboard without reaching into records or
 *     publishing.
 *   - `isUserManager` unlocks day-to-day user administration --
 *     invites, profile edits, project assignment -- without publish
 *     rights.
 *   - `isCataloguer` marks a user as cataloguing staff so they appear
 *     in project team pickers and see the cataloguing sidebar.
 *   - `isArchiveUser` is a reserved placeholder for a future
 *     read-only research role.
 *
 * Plus `githubId` for users who signed in with GitHub OAuth, so the
 * profile UI can show the link and prevent accidental duplicate accounts.
 *
 * Multi-tenancy adds the `tenantId` field to `User`. Every authenticated
 * request now resolves both the user and the tenant the request
 * targets, and `authMiddleware` asserts `user.tenantId === tenant.id`
 * at the request boundary -- the per-request invariant that downstream
 * loaders rely on. The matching `tenantContext` slot below carries
 * the resolved tenant row (capability flags, descriptive standard,
 * status -- the full Drizzle inference of the `tenants` table)
 * alongside the user; loaders in the `_auth` tree read both via
 * `context.get(userContext)` and `context.get(tenantContext)`. The
 * attachment point is `app/middleware/auth.server.ts`, which
 * resolves the tenant from the request `Host` header right after
 * the user lookup.
 *
 * `impersonationContext` is a third typed slot that carries the
 * operator's impersonation state (role being impersonated, the handoff
 * session id, and `lastActivityAt`) when the request is inside an
 * impersonation envelope, or `null` otherwise. Layouts read it to
 * render the persistent banner and routes that gate on role read it
 * to honour the role-override semantics. The middleware populates it
 * from the session payload's optional `impersonating` field.
 *
 * `grantContext` is a fourth typed slot carrying the federation grant
 * under which the request is being served (federation role, the covered
 * federation, and the grant-holder's home tenant), or `null` for the
 * common home-access request. When it is populated the middleware has
 * ALSO replaced `userContext`'s role flags with the grant's effective
 * member-tenant flags (see `app/lib/federation.server.ts`), so ordinary
 * role gates need no grant awareness; `grantContext` is for surfaces
 * that must know a request is cross-tenant (a grant banner, the
 * steward-gate helpers, grant-write audit).
 *
 * @version v0.4.2
 */

// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { createContext } from "react-router";
import type { tenants } from "./db/schema";

export type User = {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
  lastActiveAt: number | null;
  githubId: string | null;
};

/**
 * The Drizzle-inferred row shape for a single `tenants` table row,
 * including the boolean capability flags
 * (`crowdsourcingEnabled`, `vocabularyHubEnabled`,
 * `publishPipelineEnabled`, `multiRepositoryEnabled`,
 * `authoritiesEnabled`), the
 * `kind` discriminator (`"tenant"` | `"platform"`), and
 * descriptive-standard / status fields.
 */
export type Tenant = typeof tenants.$inferSelect;

export const userContext = createContext<User>();
export const tenantContext = createContext<Tenant>();

/**
 * Operator impersonation envelope state.
 * Populated by `authMiddleware` from the session payload's optional
 * `impersonating` field. `null` when the current request is NOT an
 * impersonation envelope (the common case); a populated object when
 * it is. Layouts read it to render the persistent banner; routes
 * that gate on role read it to honour the role-override semantics.
 */
export type ImpersonatingState = {
  role:
    | "isAdmin"
    | "isSuperAdmin"
    | "isCollabAdmin"
    | "isArchiveUser"
    | "isUserManager"
    | "isCataloguer";
  sessionId: string;
  lastActivityAt: number;
};

export const impersonationContext = createContext<ImpersonatingState | null>();

/**
 * Federation grant envelope state. Populated by `authMiddleware` when a
 * user reaches a member tenant of a federation they hold a
 * `federation_memberships` row in (their home tenant is elsewhere);
 * `null` for the common home-access request. `role` is the federation
 * role (`steward` | `staff`), `federationId` the covered federation, and
 * `homeTenantId` the grant-holder's home tenant (the audit actor tenant).
 * When populated, `userContext`'s role flags are the grant's effective
 * member-tenant flags, not the user's home-tenant flags.
 */
export type GrantState = {
  role: "steward" | "staff";
  federationId: string;
  homeTenantId: string;
};

export const grantContext = createContext<GrantState | null>();
