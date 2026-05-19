/**
 * Impersonation Handoff — tenant subdomain consumer
 *
 * This route is the tenant-side endpoint the operator's browser
 * lands on after the platform-host login-as action mints an
 * `impersonation_handoffs` row + 302s here. The loader is the only
 * legitimate caller of
 * `requireTenantUser`'s `allowImpersonation: true` carve-out outside
 * the auth middleware itself; everything else flows through the
 * middleware once the impersonating session cookie has been minted.
 *
 * ## Lifecycle
 *
 *   1. Apex check — reject if running on the bare apex (404). The
 *      route is structurally absent from the apex; a hostile direct
 *      hit would only fall through if DNS pointed `fisqua.test` at
 *      the same Worker. 404 keeps the response shape identical to
 *      the unknown-host fallback so the route's existence is not
 *      enumerable from outside.
 *   2. Resolve the request's tenant via `getTenantFromRequest`. The
 *      resolver 404s on unknown hosts and on multi-level subdomains.
 *      Reject (404) if the tenant is the platform tenant — operators
 *      do not impersonate INTO themselves.
 *   3. Read `?t=<id>`. Missing/empty → 410.
 *   4. Atomic single-use consume via `consumeImpersonationHandoff`.
 *      The single `UPDATE … RETURNING WHERE consumed=0 AND
 *      expires_at > now` is race-safe; rowcount-zero implies failure
 *      (replay, expiry, unknown id) → 410.
 *   5. Defence-in-depth tenant check: the consumed row's
 *      `targetTenantId` MUST equal the resolved request
 *      tenant's id. The atomic consume already burned the row at
 *      this point, but the slug recheck is the second wall — a
 *      hostile user with a captured token cannot replay it at the
 *      wrong tenant. Mismatch → 410.
 *   6. Operator user lookup. The row's `actorUserId` MUST point at a
 *      live user whose `tenantId === PLATFORM_TENANT_ID` (the
 *      structural definition of "operator"). `requireTenantUser(t,
 *      operator, { allowImpersonation: true })` enforces this —
 *      thrown 403 mapped to 410 for shape uniformity with the other
 *      failure modes (the operator-side errors are not user-visible
 *      distinctions; "the handoff is dead" is the only signal the
 *      operator gets).
 *   7. Mint the impersonating session via `createSessionStorage`.
 *      `userId = operator.id` — the session is operator-identity +
 *      role-override; tenant content writes during the envelope
 *      still carry the operator's user id. `impersonating = { role,
 *      sessionId: handoffId, lastActivityAt: now }`. The cookie
 *      config is host-only (no Domain attribute); the new session
 *      is scoped to this tenant subdomain.
 *   8. 302 to `/dashboard` with the Set-Cookie. From the next
 *      request onwards the auth middleware reads the impersonating
 *      envelope, attaches `impersonationContext`, and the staff
 *      `_auth` layout renders the persistent banner.
 *
 * ## No audit row written here
 *
 * The `login_as` audit row landed on the platform host inside the
 * action's batch. The handoff route does NOT write an audit row —
 * exactly ONE audit_log row per impersonation episode, landing on
 * the platform host before the redirect. The temporal envelope is
 * captured at the session level (login_as.created_at to
 * impersonating.lastActivityAt at end-impersonation), so per-action
 * audit traffic during the envelope is unnecessary.
 *
 * ## Why this route is not `_operator.handoff.impersonation.tsx`
 *
 * The `_operator` layout runs on the platform host. The handoff is
 * received on the tenant subdomain — it lives outside any layout, at
 * the top level of the routes manifest, like `/auth/github/handoff`.
 * The route deliberately does not pull in `operatorAuthMiddleware`
 * because the user has no session on the tenant subdomain at this
 * point (the handoff is the FIRST request that mints one). Pulling
 * in any middleware here would gate the route behind a session that
 * does not yet exist.
 *
 * @version v0.4.0
 */

import { redirect } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import {
  PLATFORM_TENANT_ID,
  getTenantFromRequest,
  requireTenantUser,
} from "../lib/tenant";
import { isApexHost } from "../lib/github-auth.server";
import { createSessionStorage } from "../sessions.server";
import { consumeImpersonationHandoff } from "../lib/impersonation-handoff.server";
import type { Route } from "./+types/handoff.impersonation";
import type { User } from "../context";

export async function loader({ request, context }: Route.LoaderArgs) {
  // Apex check — handoff lives only on tenant subdomains.
  if (isApexHost(request)) {
    return new Response(null, { status: 404 });
  }

  const env = (context as any).cloudflare.env;
  const db = drizzle(env.DB);

  // Resolve the request's tenant. getTenantFromRequest 404s on
  // unknown hosts and multi-level subdomains; we accept the thrown
  // Response and propagate it.
  let tenant;
  try {
    tenant = await getTenantFromRequest(db, request);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  // Platform host on the tenant-subdomain handoff route is structurally
  // wrong — operators do not impersonate INTO platform. 404 with the
  // same shape as the unknown-host branch keeps the route's surface
  // unenumerable across hosts.
  if (tenant.kind === "platform") {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const t = url.searchParams.get("t") ?? "";
  if (t === "") {
    return new Response(null, { status: 410 });
  }

  // Atomic single-use consume. Race-safe; rowcount-zero on replay,
  // expiry, or unknown id.
  const consumed = await consumeImpersonationHandoff(db, t, Date.now());
  if (!consumed) {
    return new Response(null, { status: 410 });
  }

  // Defence-in-depth: row was minted for tenant A, request hits
  // tenant B. The atomic UPDATE already burned the row by this point,
  // so the slug check costs nothing and prevents cross-tenant token
  // misuse.
  if (consumed.targetTenantId !== tenant.id) {
    return new Response(null, { status: 410 });
  }

  // Look up the operator user the row was minted for. requireUser-
  // shaped lookup, but inlined because the route only needs the
  // tenantId and id for the carve-out + session mint.
  const [operatorRow] = await db
    .select()
    .from(users)
    .where(eq(users.id, consumed.actorUserId))
    .limit(1)
    .all();
  if (!operatorRow) {
    return new Response(null, { status: 410 });
  }

  // Apply the operator-as-tenant carve-out. requireTenantUser with
  // allowImpersonation=true admits exactly the case
  // `user.tenantId === PLATFORM_TENANT_ID && tenant.kind === 'tenant'`;
  // any other shape (a tenant user mismatching tenants, an operator
  // somehow on a non-platform tenant) throws 403, which we map to 410
  // so the failure mode is shape-uniform with replay/expiry/unknown.
  try {
    requireTenantUser(
      tenant,
      // Cast: the carve-out only reads tenantId. Full User
      // hydration happens in the auth middleware after session mint.
      operatorRow as unknown as User,
      { allowImpersonation: true },
    );
  } catch (e) {
    return new Response(null, { status: 410 });
  }

  // Defence-in-depth backstop on top of requireTenantUser: the
  // operator MUST be on the platform tenant. requireTenantUser
  // already enforces this; the explicit check makes the intent
  // load-bearing-readable at the call site.
  if (operatorRow.tenantId !== PLATFORM_TENANT_ID) {
    return new Response(null, { status: 410 });
  }

  // Mint the impersonating session. userId = operator.id —
  // operator-identity + role-override; tenant content writes carry
  // the operator's id throughout. impersonating envelope carries
  // the role from the consumed row, the handoff id as sessionId
  // (threads forensic continuity through every audit row written
  // during the envelope), and lastActivityAt = now (refreshed by the
  // auth middleware on every subsequent request — sliding window).
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET,
  );
  const session = await getSession();
  session.set("userId", operatorRow.id);
  session.set("impersonating", {
    role: consumed.targetRole as
      | "isAdmin"
      | "isSuperAdmin"
      | "isCollabAdmin"
      | "isArchiveUser"
      | "isUserManager"
      | "isCataloguer",
    sessionId: t,
    lastActivityAt: Date.now(),
  });

  return redirect("/dashboard", {
    headers: { "Set-Cookie": await commitSession(session) },
  });
}

// @version v0.4.0
