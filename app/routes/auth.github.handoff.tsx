/**
 * GitHub OAuth — tenant subdomain handoff route
 *
 * This route ONLY runs on tenant subdomains (`<slug>.fisqua.org`,
 * `<slug>.fisqua.test`, `<slug>.localhost`, plus the legacy
 * `catalogacion.zasqua.org` host). It is the second half of the
 * apex-callback + handoff flow — the apex callback at
 * `https://fisqua.org/auth/github/callback` 302s here with
 * `?t=<handoff-id>` and this route consumes the row, finalises the
 * user session, and 302s to `/dashboard`.
 *
 * The flow:
 *
 *   1. Apex check — reject if running on the apex (404). The route is
 *      structurally absent from the apex; users mid-flow on the apex
 *      hit the apex callback, not this route.
 *   2. Resolve the request host's tenant via `getTenantFromRequest`. The
 *      resolver 404s on unknown hosts and on multi-level subdomains.
 *      Reject (404) if the tenant is the platform tenant — the platform
 *      host has no user session.
 *   3. Read `?t=<id>`. Missing/empty → 410.
 *   4. Atomically consume the row via `consumeHandoff(db, t, Date.now())`.
 *      Returns `null` if the row does not exist, has expired, or has
 *      already been consumed → 410. The single UPDATE … RETURNING is
 *      race-safe across concurrent requests.
 *   5. Defence in depth: the row's `return_to_slug` MUST equal the
 *      resolved tenant's slug for the request host. This catches a
 *      hostile user who tries to consume a token at a different tenant
 *      than the one the apex callback minted it for. Mismatch → 410.
 *   6. User lookup: `SELECT * FROM users WHERE email = ?`. If no user,
 *      302 to `/login?error=no-account` (preserves v0.4 option-c
 *      policy: no auto-create, reject unknown emails).
 *      If a user is found but `user.tenantId !== resolvedTenant.id`,
 *      redirect to `/wrong-workspace?home=<slug>` on the same host
 *      so the user can navigate to their home subdomain via the
 *      interstitial CTA. The misleading "no account found" message
 *      previously shown to wrong-tenant users is now reserved for
 *      the genuinely-unknown-email case.
 *   7. First-login GitHub bind: if `user.githubId` is null,
 *      `UPDATE users SET github_id = ?` from the row's stored
 *      `githubId`. Subsequent sign-ins do NOT overwrite — the column
 *      is unique across users and overwriting it would silently
 *      change a user's identity link.
 *   8. Create session via `createSessionStorage(env.SESSION_SECRET)`
 *      and 302 to `/dashboard`. The `Set-Cookie` carries no
 *      `Domain=` attribute (the host-only-cookie invariant is pinned
 *      by `tests/sessions/cookie-scoping.test.ts`).
 *
 * @version v0.4.1
 */

import { eq } from "drizzle-orm";
import type { Route } from "./+types/auth.github.handoff";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { isApexHost } = await import("../lib/github-auth.server");
  const { getTenantFromRequest } = await import("../lib/tenant");
  const { createSessionStorage } = await import("../sessions.server");
  const { consumeHandoff } = await import("../lib/oauth-handoff.server");
  const { users } = await import("../db/schema");

  // Apex check — this route is tenant-only. Apex 404s.
  if (isApexHost(request)) {
    return new Response(null, { status: 404 });
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Resolve the request host's tenant. Throws a bare 404 Response on
  // unknown host / multi-level subdomain — that propagates correctly
  // out of this loader (React Router accepts thrown Response).
  let tenant;
  try {
    tenant = await getTenantFromRequest(db, request);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  // Platform host: no users live here. 404 with a bare body — same shape
  // as the unknown-host 404, so platform-slug existence stays
  // unenumerable.
  if (tenant.kind === "platform") {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const t = url.searchParams.get("t") ?? "";
  if (t === "") {
    return new Response(null, { status: 410 });
  }

  const consumed = await consumeHandoff(db, t, Date.now());
  if (!consumed) {
    return new Response(null, { status: 410 });
  }

  // Defence in depth: the row's return_to_slug MUST equal the resolved
  // tenant's slug for the request host. The atomic consume already
  // succeeded, so the row is now spent regardless — but we refuse to
  // sign anyone in if the slug doesn't match.
  if (consumed.returnToSlug !== tenant.slug) {
    return new Response(null, { status: 410 });
  }

  // Email-match user lookup (no auto-create, reject unknown emails).
  // A genuine unknown email gets `/login?error=no-account`; a known
  // user on a different tenant is redirected to the /wrong-workspace
  // interstitial so they can self-correct to their home subdomain
  // instead of seeing the misleading "no account found" message.
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, consumed.email))
    .limit(1)
    .all();

  if (!user) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/login?error=no-account" },
    });
  }

  if (user.tenantId !== tenant.id) {
    // Three sub-cases fall through to /login?error=no-account:
    //   - user is the platform tenant (no user-facing subdomain)
    //   - user's home tenant row missing / soft-disabled
    //   - current host not a SUBDOMAIN_HOST_SUFFIXES host
    //     (handoff doesn't run on the legacy host in practice, but
    //     check defensively)
    const { PLATFORM_TENANT_ID, SUBDOMAIN_HOST_SUFFIXES, findTenantById } =
      await import("../lib/tenant");
    if (user.tenantId !== PLATFORM_TENANT_ID) {
      const currentHost = new URL(request.url).hostname.toLowerCase();
      const isSubdomainHost = SUBDOMAIN_HOST_SUFFIXES.some((s) =>
        currentHost.endsWith(s),
      );
      if (isSubdomainHost) {
        const homeTenant = await findTenantById(db, user.tenantId);
        if (homeTenant && homeTenant.disabledAt === null) {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `/wrong-workspace?home=${encodeURIComponent(homeTenant.slug)}`,
            },
          });
        }
      }
    }
    return new Response(null, {
      status: 302,
      headers: { Location: "/login?error=no-account" },
    });
  }

  // First-login GitHub bind: stamp github_id only when the column is
  // currently null. Subsequent sign-ins do NOT overwrite — the column
  // is unique across users and overwriting it would silently change a
  // user's identity link.
  if (!user.githubId) {
    await db
      .update(users)
      .set({ githubId: consumed.githubId })
      .where(eq(users.id, user.id));
  }

  // Mint the session cookie. The cookie config in
  // `app/sessions.server.ts` omits `Domain`, so the cookie is
  // host-only on `<slug>.fisqua.org` per RFC 6265 §5.3. The
  // regression test pins this property at the cookie-config layer;
  // this route's Set-Cookie inherits it transparently.
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET,
  );
  const session = await getSession();
  session.set("userId", user.id);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": await commitSession(session),
    },
  });
}

// @version v0.4.1
