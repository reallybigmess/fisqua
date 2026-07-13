/**
 * Auth Middleware — Tenant-Aware Session Gate
 *
 * This middleware deals with the request-time gate every protected
 * route inherits — the single place that decides whether a request
 * may proceed into the authenticated tree, which user it belongs to,
 * which tenant it targets, and whether an operator's impersonation
 * envelope is still valid. Reading the session cookie, looking up the
 * user, resolving the tenant from the `Host` header, asserting
 * user/tenant alignment, and refreshing the sliding impersonation
 * timeout all happen here so loaders downstream can read
 * `userContext`, `tenantContext`, and `impersonationContext` with
 * those invariants already established.
 *
 * The middleware also carries two structural carve-outs that the rest
 * of the stack relies on: the platform-host 404 for non-operator
 * paths (so `platform.fisqua.test/anything-other-than-/operator/*`
 * does not leak into staff routes) and the impersonation
 * `allowImpersonation` opt-in into `requireTenantUser` (so an
 * operator's platform-tenant user can read tenant-subdomain routes
 * while their handoff envelope is live, and only then). The defensive
 * wrong-workspace redirect handles the case where a stale session
 * cookie from one tenant lands on another tenant's subdomain — the
 * cookie is cleared and the user is bounced to a "go home" page
 * before any loader runs.
 *
 * The full step-by-step contract lives in the JSDoc on the exported
 * `authMiddleware` const below; treat that as the authoritative
 * description and this header as the narrative orientation.
 *
 * @version v0.4.2
 */

// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  grantContext,
  impersonationContext,
  tenantContext,
  userContext,
} from "../context";
import { createSessionStorage } from "../sessions.server";
import { requireUser } from "../lib/auth.server";
import {
  assertNonPlatformOrAllowlisted,
  findTenantById,
  getTenantFromRequest,
  PLATFORM_TENANT_ID,
  requireTenantUser,
  SUBDOMAIN_HOST_SUFFIXES,
} from "../lib/tenant";
import {
  applyGrantEffectiveRole,
  logGrantWrite,
  resolveGrant,
  type GrantAccess,
} from "../lib/federation.server";
import { users } from "../db/schema";

import type { MiddlewareFunction } from "react-router";

/** Throttle lastActiveAt writes to once every 5 minutes. */
const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

/** 30-minute idle timeout for the impersonation envelope. */
const IMPERSONATION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Authentication middleware for protected routes. Resolves both the
 * signed-in user and the tenant the request targets, attaches both
 * to typed React Router contexts, and asserts user/tenant alignment
 * before any loader runs.
 *
 * Steps:
 *   1. Read the `__session` cookie; redirect to `/login` if missing.
 *   2. Look up the user via `requireUser`; redirect to `/login` if the
 *      session points at a deleted user.
 *   3. Attach the user to `userContext`.
 *   4. Read the optional `impersonating` field from the session
 *      payload. If present and `lastActivityAt` is older than 30
 *      minutes, clear the field, commit the session, and redirect
 *      to `/login` with the cleared cookie.
 *   5. Resolve the tenant from the request `Host` header via
 *      `getTenantFromRequest` (legacy host map, subdomain suffix
 *      list, or 404 on unknown host). The resolver also handles
 *      the disabled-tenant 404 branch — a tenant whose
 *      `disabledAt` is set 404s here unless the pathname starts
 *      with `/operator/`.
 *   5a. Hard-404 the request if the tenant is the platform tenant
 *       and the path is not in `OPERATOR_ROUTE_PREFIXES`.
 *   5b. Resolve a federation grant. If the user's home tenant is not the
 *       request tenant (and they are neither operator nor impersonating),
 *       `resolveGrant` checks `federation_memberships` for a live grant
 *       into this tenant's federation. On a grant, replace `userContext`
 *       with the grant's effective member-tenant role flags (staff never
 *       admin; steward admin-equivalent — invariant I6).
 *   5c. Defence-in-depth wrong-workspace redirect. If there is no grant
 *       AND `user.tenantId !== tenant.id` AND the user is not the platform
 *       operator AND the impersonation envelope is unset AND the
 *       current host is in `SUBDOMAIN_HOST_SUFFIXES` AND the user's
 *       home tenant is reachable, clear the stale `__session` cookie
 *       and 302 to `/wrong-workspace?home=<slug>`. Any miss falls
 *       through to step 6's 403.
 *   6. Assert user/tenant alignment via `requireTenantUser`. Two
 *      carve-outs threaded in from above: the resolved `grant` (admits a
 *      federation-lead-staff-into-member-tenant request), and the
 *      impersonation opt-in (`allowImpersonation: true` when
 *      `impersonating` is set, admitting the operator's platform-tenant
 *      user on tenant subdomains). Both are per-request; the helper stays
 *      default-deny.
 *   7. Attach the tenant to `tenantContext`.
 *   8. Attach the impersonation state (or null) to
 *      `impersonationContext` and the grant state (or null) to
 *      `grantContext` so layouts can render the banners and surfaces can
 *      read the role-override / cross-tenant provenance.
 *   8b. Audit grant-access writes: a mutating request (non GET/HEAD)
 *      under a live grant records an `edit_on_behalf` row with actor =
 *      the grant-holder's home tenant, target = the member tenant (I6).
 *   9. Throttle-update `lastActiveAt` on the user row.
 *  10. If the session is impersonating, refresh
 *      `impersonating.lastActivityAt = Date.now()` and commit the
 *      session back to the cookie. This is what makes the 30-min
 *      idle timeout sliding instead of fixed-from-handoff. The
 *      Set-Cookie is added to the response by intercepting `next()`.
 *
 * Two trust-boundary notes:
 *   - The `Host` header is set by Cloudflare's edge based on the
 *     SNI/HTTP host the client sent. It is NOT user-controllable
 *     beyond DNS, so trusting it for tenant resolution is safe.
 *   - The `lastActiveAt` query reads a single user row keyed by
 *     primary-key id, not a tenant-scoped read; this is intentional
 *     and the cross-tenant grep test allowlists it.
 *
 * Single chokepoint reminder: this middleware is the only place that
 * decides whether to opt into `requireTenantUser`'s
 * `allowImpersonation` carve-out for the lifetime of an impersonating
 * session. The handoff route opts in for its own one-shot call when
 * minting the session; everything else flows through here.
 *
 * @version v0.4.2
 */
export const authMiddleware: MiddlewareFunction = async (
  { request, context },
  next,
) => {
  const env = context.cloudflare.env;
  const { getSession, commitSession, destroySession } = createSessionStorage(env.SESSION_SECRET);

  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");

  if (!userId) {
    throw redirect("/login");
  }

  const db = drizzle(env.DB);
  const user = await requireUser(db, userId);

  if (!user) {
    throw redirect("/login");
  }

  context.set(userContext, user);

  // --- Read impersonation envelope + enforce 30-min idle timeout ---
  // Read the optional `impersonating` field BEFORE tenant resolution so an
  // expired envelope is dropped cleanly even if the resolved tenant subdomain
  // would otherwise 404 the request.
  const impersonatingFromSession = session.get("impersonating");
  const now = Date.now();
  if (
    impersonatingFromSession &&
    now - impersonatingFromSession.lastActivityAt > IMPERSONATION_IDLE_TIMEOUT_MS
  ) {
    session.unset("impersonating");
    const cookie = await commitSession(session);
    throw redirect("/login", {
      headers: { "Set-Cookie": cookie },
    });
  }

  // --- Tenant resolution + alignment assertion ---
  // Resolve the tenant from the Host header. Throws Response(null,
  // {status: 404}) on unknown host -- bare 404 so no information
  // leaks about which slugs exist. The disabled-tenant carve-out
  // inside the resolver: a soft-disabled tenant 404s unless the path
  // starts with /operator/.
  const tenant = await getTenantFromRequest(db, request);

  // Hard-404 every path on the platform tenant host whose pathname is
  // neither in the legacy literal allowlist (still []) nor a prefix
  // match against OPERATOR_ROUTE_PREFIXES. Bare 404 keeps the response
  // indistinguishable from the resolver's unknown-host 404.
  assertNonPlatformOrAllowlisted(tenant, new URL(request.url).pathname);

  // --- Federation grant resolution ---
  // A user whose home tenant is not the request tenant may still reach it
  // through a federation membership (grant access, spec §4). Resolve it
  // BEFORE the wrong-workspace branch (so a legitimate grant-holder is not
  // bounced home) and BEFORE requireTenantUser (so its grant branch admits
  // them). resolveGrant short-circuits to null with no DB read on home
  // access, and denies a suspended federation or a suspended/disabled
  // tenant. Operator sessions and active impersonation envelopes take
  // their own paths and never resolve a grant.
  let grant: GrantAccess | null = null;
  if (
    !impersonatingFromSession &&
    user.tenantId !== tenant.id &&
    user.tenantId !== PLATFORM_TENANT_ID
  ) {
    grant = await resolveGrant(db, user, tenant);
  }

  // Under a grant, the acting role flags become the grant's effective
  // member-tenant flags (staff never admin; steward admin-equivalent --
  // invariant I6). Re-attach the effective user so every downstream role
  // gate honours the override without grant awareness. Identity and the
  // HOME tenantId are preserved.
  let effectiveUser = user;
  if (grant) {
    effectiveUser = applyGrantEffectiveRole(user, grant);
    context.set(userContext, effectiveUser);
  }

  // Wrong-workspace interstitial (defence-in-depth UX).
  // The magic-link verify and OAuth handoff paths refuse to mint a
  // wrong-tenant session, so the routine wrong-tenant trigger never
  // reaches this middleware. This branch handles the rare residual
  // case: an admin moved a user's tenantId AFTER they had already
  // minted a session, OR a future code path mints one without going
  // through verify/handoff. We clear the stale session cookie on the
  // way out and 302 to /wrong-workspace?home=<slug> on the same host
  // so the user reaches the interstitial without auth, and never sees
  // the bare "Forbidden" 403.
  //
  // Operator users (user.tenantId === PLATFORM_TENANT_ID) without an
  // impersonation envelope continue to fall through to
  // requireTenantUser's 403 — the platform tenant has no user-facing
  // subdomain to redirect into (security boundary).
  if (
    !impersonatingFromSession &&
    !grant &&
    user.tenantId !== tenant.id &&
    user.tenantId !== PLATFORM_TENANT_ID
  ) {
    const currentHost = new URL(request.url).hostname.toLowerCase();
    const isSubdomainHost = SUBDOMAIN_HOST_SUFFIXES.some((s) =>
      currentHost.endsWith(s),
    );
    if (isSubdomainHost) {
      const homeTenant = await findTenantById(db, user.tenantId);
      if (homeTenant && homeTenant.disabledAt === null) {
        // destroySession emits Set-Cookie with Max-Age=0 so the browser
        // drops the cookie immediately. Avoids a 302 loop if the user
        // navigates back to this host.
        const cookie = await destroySession(session);
        throw redirect(
          `/wrong-workspace?home=${encodeURIComponent(homeTenant.slug)}`,
          { headers: { "Set-Cookie": cookie } },
        );
      }
    }
    // Fall through to requireTenantUser's 403: home tenant missing /
    // disabled, OR current host not in SUBDOMAIN_HOST_SUFFIXES (legacy
    // host). 403 is the right answer in both cases — the interstitial
    // CTA can't be built for them.
  }

  // The operator's user lives in the platform tenant; on
  // tenant subdomains, requireTenantUser would 403 every operator request
  // without the carve-out. Pass allowImpersonation:true ONLY when the
  // session actually carries an impersonating envelope — every other
  // request sees default-deny.
  requireTenantUser(tenant, effectiveUser, {
    allowImpersonation: impersonatingFromSession !== undefined,
    grant: grant ? { federationId: grant.federationId } : null,
  });

  context.set(tenantContext, tenant);
  context.set(
    impersonationContext,
    impersonatingFromSession
      ? {
          role: impersonatingFromSession.role,
          sessionId: impersonatingFromSession.sessionId,
          // Surface the about-to-be-refreshed timestamp so layouts
          // see "now", not the stale value from the cookie.
          lastActivityAt: now,
        }
      : null,
  );
  context.set(
    grantContext,
    grant
      ? {
          role: grant.role,
          federationId: grant.federationId,
          homeTenantId: grant.homeTenantId,
        }
      : null,
  );

  // Audit every grant-access WRITE in a member tenant (invariant I6).
  // Single chokepoint: a mutating request (non GET/HEAD) served under a
  // live grant records an `edit_on_behalf` row with actor = the
  // grant-holder's home tenant and target = the member tenant. Reads are
  // not audited (operator-surface precedent, audit.server.ts).
  if (
    grant &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    await logGrantWrite(db, effectiveUser, tenant, grant, request);
  }

  // Throttle-update lastActiveAt on the user row (5-minute throttle to
  // avoid write amplification).
  const [userRow] = await db
    .select({ lastActiveAt: users.lastActiveAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();

  if (
    userRow &&
    (!userRow.lastActiveAt ||
      now - userRow.lastActiveAt > LAST_ACTIVE_THROTTLE_MS)
  ) {
    await db
      .update(users)
      .set({ lastActiveAt: now })
      .where(eq(users.id, userId));
  }

  // Refresh the impersonation envelope's lastActivityAt
  // and persist it back to the cookie. Without the persistence step
  // the idle timeout would fire 30 minutes after handoff regardless of
  // ongoing activity, which is wrong. Wrap next() to attach the
  // Set-Cookie to the outgoing response.
  if (impersonatingFromSession) {
    session.set("impersonating", {
      ...impersonatingFromSession,
      lastActivityAt: now,
    });
    const cookie = await commitSession(session);
    const response = (await next()) as Response;
    response.headers.append("Set-Cookie", cookie);
    return response;
  }
};
