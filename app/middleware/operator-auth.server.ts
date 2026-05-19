/**
 * Operator-Auth Middleware
 *
 * This middleware deals with gating the `_operator` surface. It mirrors
 * `app/middleware/auth.server.ts`'s session-resolution + user-lookup
 * pattern, then layers the `assertOperator(tenant)` gate on top.
 * Operator routes are NOT nested under the `_auth` layout — they live
 * in their own top-level `_operator` layout so
 * the staff sidebar/chrome does not leak into the operator surface and
 * the operator UI runs against its own thin top-bar nav. This
 * middleware is the only auth gate operator routes inherit.
 *
 * Steps:
 *   1. Read the `__session` cookie; redirect to `/login` if missing.
 *   2. Look up the user via `requireUser`; redirect to `/login` if the
 *      session points at a deleted user.
 *   3. Attach the user to `userContext`.
 *   4. Resolve the tenant from the request `Host` header. On the
 *      platform host this always lands on the platform tenant — the
 *      operator-route prefix gate in `assertNonPlatformOrAllowlisted`
 *      already prevents `/operator/*` paths from being reachable on
 *      tenant subdomains, so by the time this middleware runs we can
 *      trust the host is the platform host. We still go through
 *      `getTenantFromRequest` because that is the canonical resolver
 *      (legacy host map, subdomain suffix list, disabled-tenant 404
 *      branch) and skipping it would create a parallel resolution
 *      path that future schema changes would have to remember to
 *      update.
 *   5. `assertOperator(tenant)` — 403 if `tenant.kind !== 'platform'`.
 *      Gates the TENANT side: a tenant subdomain (kind = 'tenant')
 *      cannot reach the operator surface even if the user is the
 *      operator.
 *   5a. `user.tenantId === PLATFORM_TENANT_ID` — 403 otherwise. Gates
 *      the USER side: on the platform host the resolved tenant is
 *      always 'platform', so assertOperator alone passes for any
 *      logged-in user (a Neogranadina user requesting
 *      `platform.fisqua.test/operator/tenants` would slip through).
 *      The operator user's row lives in the platform tenant, so only
 *      those users belong here. assertOperator was originally framed
 *      as the "single chokepoint"; in practice both gates are required
 *      and structurally complementary.
 *   6. Attach the tenant to `tenantContext`.
 *   7. Attach `null` to `impersonationContext`. Operators never
 *      impersonate INTO the platform tenant — impersonation lands on
 *      tenant subdomains, not on `platform.fisqua.org`. The slot is
 *      attached for symmetry with the `_auth` middleware so layouts
 *      that read `impersonationContext` see a deterministic value.
 *
 * Three deliberate omissions vs the `_auth` middleware:
 *
 *   - **No `lastActiveAt` throttle.** The platform host serves ~1–2
 *     named operators per the threat model; the
 *     write-amplification reduction the throttle buys is irrelevant
 *     at that volume. Skipping it keeps the operator surface as
 *     small as possible.
 *
 *   - **No idle timeout.** The 30-min idle timeout in `_auth` is for
 *     the impersonation envelope; the platform host has no
 *     impersonation. Operator sessions follow the standard 30-day
 *     cookie maxAge.
 *
 *   - **No `requireTenantUser` allowImpersonation carve-out.** The
 *     operator's user lives in the platform tenant; on the platform
 *     host the resolved tenant IS the platform tenant; the equality
 *     check `user.tenantId === tenant.id` passes naturally. The
 *     carve-out only matters on tenant subdomains.
 *
 * @version v0.4.0
 */

import { redirect } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import {
  impersonationContext,
  tenantContext,
  userContext,
} from "../context";
import { createSessionStorage } from "../sessions.server";
import { requireUser } from "../lib/auth.server";
import {
  PLATFORM_TENANT_ID,
  assertOperator,
  getTenantFromRequest,
} from "../lib/tenant";

import type { MiddlewareFunction } from "react-router";

export const operatorAuthMiddleware: MiddlewareFunction = async (
  { request, context },
  _next,
) => {
  const env = (context as any).cloudflare.env;
  const { getSession } = createSessionStorage(env.SESSION_SECRET);

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

  // Resolve tenant from Host header. On the platform host this lands
  // on the platform tenant; on a tenant subdomain it lands on that
  // tenant's row. The assertOperator gate below 403s the second case.
  const tenant = await getTenantFromRequest(db, request);
  assertOperator(tenant);

  // assertOperator alone gates the TENANT side; we also need to gate
  // the USER side. On the platform host the resolved tenant is always
  // `platform`, so assertOperator passes for any logged-in user — a
  // Neogranadina user requesting `platform.fisqua.test/operator/tenants`
  // would slip through without this second check. The operator user's
  // row lives in the platform tenant; only those users can reach the
  // operator surface. assertOperator alone is insufficient — the
  // user-identity check is the second required gate.
  if (user.tenantId !== PLATFORM_TENANT_ID) {
    throw new Response("Forbidden", { status: 403 });
  }

  context.set(tenantContext, tenant);

  // Operators do not impersonate INTO the platform tenant; the slot
  // exists for layout-shape symmetry with `_auth`. Always null here.
  context.set(impersonationContext, null);
};

// @version v0.4.0
