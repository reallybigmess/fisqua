/**
 * GitHub OAuth — apex init route
 *
 * This route ONLY runs on the apex (`fisqua.org`, plus the dev/test
 * equivalents `fisqua.test` and `localhost`). It is the single entry
 * point for "Sign in with GitHub" across every tenant.
 *
 * The flow:
 *
 *   1. `?return_to=<slug>` carries the tenant slug the user wants to land
 *      on after the OAuth dance. The slug is required (400 if missing,
 *      empty, or shape-malformed) and must resolve to an existing,
 *      non-platform tenant (400 otherwise — the apex must NOT mint a
 *      state cookie for a tenant that can't exist).
 *   2. The route mints `state = arctic.generateState()` and writes a
 *      single host-only cookie `github_oauth_state=<state>.<slug>` on
 *      `fisqua.org`. The cookie carries BOTH the CSRF state and the
 *      slug. Reading the slug from the cookie on callback (rather than
 *      a query param) defends against attacker-crafted URLs of the form
 *      `https://fisqua.org/auth/github?return_to=victim`.
 *   3. The route 302s to GitHub's authorize URL with the constant
 *      `redirect_uri=https://fisqua.org/auth/github/callback` — the one
 *      URL the GitHub OAuth App is registered with. The redirect_uri is
 *      NOT derived from `request.origin`: GitHub OAuth Apps allow
 *      exactly one Authorization callback URL, so a per-tenant
 *      redirect_uri is structurally infeasible.
 *
 * Cookie shape: a single cookie `<state>.<slug>` rather than two cookies
 * because callback parsing stays trivial (split on the last `.`) and
 * because slug shape (`^[a-z0-9-]+$`) cannot collide with arctic's
 * base32-uppercase state. The init route enforces the slug shape
 * before composing the cookie value, so the dot is unambiguous.
 *
 * @version v0.4.0
 */

import type { Route } from "./+types/auth.github";

const SLUG_REGEX = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const RESERVED_PLATFORM_KIND = "platform" as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { tenants } = await import("../db/schema");
  const {
    createGitHubClient,
    generateState,
    APEX_OAUTH_CALLBACK_URL,
    isApexHost,
  } = await import("../lib/github-auth.server");

  // Apex-only host check. Tenant subdomains and the platform host both
  // 404 with a bare body — externally indistinguishable from the
  // resolver's unknown-host 404 (no information leak about route
  // existence on tenant hosts).
  if (!isApexHost(request)) {
    return new Response(null, { status: 404 });
  }

  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return_to") ?? "";

  // Slug shape. The 400s here are deliberate; an attacker who can
  // craft an arbitrary `?return_to=` should never reach the GitHub
  // authorize redirect, because the resulting state cookie would
  // otherwise carry their slug.
  if (returnTo === "" || !SLUG_REGEX.test(returnTo)) {
    return new Response(null, { status: 400 });
  }

  // Resolve the slug to a tenant. Reject non-existent tenants (so a
  // typo doesn't burn a state cookie + GitHub round-trip) and the
  // platform tenant (which has no users). Emit a 400 in both cases —
  // the apex landing's "wrong workspace" UX is "type a different slug",
  // not "we can't reveal whether `<slug>` exists", because the slug
  // came from the user's own `?return_to=` and the picker on the
  // landing page already exposes the bare-404 enumeration surface
  // for free-form slugs.
  const db = drizzle(env.DB);
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, returnTo))
    .limit(1)
    .all();
  if (!tenant || tenant.kind === RESERVED_PLATFORM_KIND) {
    return new Response(null, { status: 400 });
  }

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/login?error=oauth-failed" },
    });
  }

  const github = createGitHubClient(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    APEX_OAUTH_CALLBACK_URL,
  );

  const state = generateState();
  const authorizeUrl = github.createAuthorizationURL(state, ["user:email"]);

  // Compose the state cookie: `<state>.<slug>`. The dot is unambiguous
  // because arctic's state is base32-uppercase and the slug regex
  // forbids dots.
  const cookieValue = `${state}.${returnTo}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      // Host-only on `fisqua.org` (no Domain attribute). Path=/ so the
      // callback at `/auth/github/callback` can read it; HttpOnly +
      // SameSite=Lax + Secure for the standard OAuth-state hardening.
      "Set-Cookie": `github_oauth_state=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

// @version v0.4.0
