/**
 * Magic link verification endpoint
 *
 * This route is loader-only — no component rendered. It consumes a
 * single-use magic-link token, looks up the user, verifies their
 * `tenantId`
 * matches the request host's tenant, and mints the `__session` cookie
 * before redirecting to `/dashboard`.
 *
 * Wrong-subdomain handling: a user who clicks a magic link minted on
 * a subdomain that doesn't match their `tenantId` would otherwise have
 * a session minted here and then be 403'd at `authMiddleware`'s
 * `requireTenantUser` gate. We check `user.tenantId === tenant.id`
 * BEFORE minting the session and 302 to `/wrong-workspace?home=<slug>`
 * on the same host so the user lands at the interstitial
 * unauthenticated (no wrong-tenant session ever exists).
 *
 * @version v0.4.1
 */

import { redirect } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/auth.verify";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { verifyMagicLink } = await import("../lib/auth.server");
  const {
    SUBDOMAIN_HOST_SUFFIXES,
    PLATFORM_TENANT_ID,
    findTenantById,
    getTenantFromRequest,
  } = await import("../lib/tenant");
  const { users } = await import("../db/schema");

  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    throw redirect("/login?error=invalid-link");
  }

  const db = drizzle(env.DB);
  const userId = await verifyMagicLink(db, token);

  if (!userId) {
    throw redirect("/login?error=expired-link");
  }

  // Load the user row so we can check tenant alignment before minting
  // a session. A magic-link token is signed and single-use, so the
  // userId is trustworthy — but the user may have been deleted between
  // when the link was generated and when it was clicked.
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .all();

  if (!user) {
    throw redirect("/login?error=expired-link");
  }

  // Resolve the request host's tenant. Bubbles a bare 404 Response on
  // unknown host / multi-level subdomain — propagates out of this
  // loader correctly (React Router accepts thrown Response).
  let tenant;
  try {
    tenant = await getTenantFromRequest(db, request);
  } catch (e) {
    if (e instanceof Response) throw e;
    throw e;
  }

  // Tenant-alignment gate. The wrong-workspace interstitial handles
  // three sub-cases:
  //   - User on platform tenant: no user-facing subdomain to redirect
  //     to; fall through to /login?error=no-account.
  //   - Home tenant missing/disabled: same — don't direct the user at
  //     a subdomain that would 404 them.
  //   - Current host is not a SUBDOMAIN_HOST_SUFFIXES host (legacy host
  //     `catalogacion.zasqua.org`): the interstitial CTA can't be built
  //     for it; fall through to /login?error=no-account.
  if (user.tenantId !== tenant.id) {
    if (user.tenantId === PLATFORM_TENANT_ID) {
      throw redirect("/login?error=no-account");
    }
    const currentHost = url.hostname.toLowerCase();
    const isSubdomainHost = SUBDOMAIN_HOST_SUFFIXES.some((s) =>
      currentHost.endsWith(s),
    );
    if (isSubdomainHost) {
      const homeTenant = await findTenantById(db, user.tenantId);
      if (homeTenant && homeTenant.disabledAt === null) {
        throw redirect(
          `/wrong-workspace?home=${encodeURIComponent(homeTenant.slug)}`,
        );
      }
    }
    throw redirect("/login?error=no-account");
  }

  // Tenant aligned — mint the session and proceed to /dashboard.
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET,
  );
  const session = await getSession();
  session.set("userId", userId);

  throw redirect("/dashboard", {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}

// @version v0.4.1
