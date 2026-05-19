/**
 * GitHub OAuth — apex callback route
 *
 * This route ONLY runs on the apex (`fisqua.org`, plus the dev/test
 * equivalents `fisqua.test` and `localhost`). It is the one URL the
 * GitHub OAuth App is registered with as its Authorization callback
 * URL.
 *
 * The flow:
 *
 *   1. Apex-only host check (404 on tenant subdomains and the platform
 *      host — the route is structurally absent from those origins).
 *   2. Validate the `?state` query param against the host-only state
 *      cookie set by the init route. Mismatch → 302 to
 *      `/login?error=oauth-failed`.
 *   3. Read the `return_to_slug` from the state cookie (NOT from a
 *      query param). The slug travels in the cookie body alongside the
 *      arctic state as `<state>.<slug>`; this is the defence against
 *      attacker-crafted `/auth/github?return_to=victim` links.
 *   4. Re-resolve the slug to a tenant (defence in depth — even though
 *      the init route already checked, the cookie has been on the
 *      browser for up to 10 minutes and a tenant could have been
 *      deleted). Reject if non-existent or platform with a 302 to
 *      `/login?error=oauth-failed`.
 *   5. Exchange the OAuth code for an access token. Fetch the GitHub
 *      primary verified email (preserves the v0.4 email-match user
 *      policy — the handoff route looks up users by email).
 *   6. Mint an opaque handoff id (`crypto.randomUUID()`), insert a row
 *      into `oauth_handoffs` via `insertHandoff`, and 302 to
 *      `https://<slug>.fisqua.org/auth/github/handoff?t=<id>`.
 *
 * Critical: this route does NOT call `commitSession` and does NOT issue
 * a `Set-Cookie: __session`. The apex has no user-session concept; the
 * session cookie is set on the tenant subdomain by the handoff route,
 * after that route atomically consumes the handoff row.
 *
 * @version v0.4.0
 */

import { eq } from "drizzle-orm";
import type { Route } from "./+types/auth.github.callback";

const RESERVED_PLATFORM_KIND = "platform" as const;

/**
 * Parses the state cookie body `<state>.<slug>` into its two parts.
 * Returns null if the cookie is missing or malformed.
 */
function parseStateCookie(value: string | null): {
  state: string;
  slug: string;
} | null {
  if (!value) return null;
  const dotIdx = value.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === value.length - 1) return null;
  return {
    state: value.slice(0, dotIdx),
    slug: value.slice(dotIdx + 1),
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const {
    createGitHubClient,
    fetchGitHubUserEmail,
    parseCookieValue,
    APEX_OAUTH_CALLBACK_URL,
    isApexHost,
  } = await import("../lib/github-auth.server");
  const { tenants } = await import("../db/schema");
  const { insertHandoff } = await import("../lib/oauth-handoff.server");

  // Apex-only.
  if (!isApexHost(request)) {
    return new Response(null, { status: 404 });
  }

  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");

  // Read the state cookie and parse it into <state>.<slug>.
  const cookies = request.headers.get("Cookie") || "";
  const cookieValue = parseCookieValue(cookies, "github_oauth_state");
  const parsed = parseStateCookie(cookieValue);

  // Clear the state cookie on every exit branch so a stale cookie
  // doesn't linger after a failed flow.
  const clearCookieHeader =
    "github_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

  if (!code || !stateParam || !parsed || stateParam !== parsed.state) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login?error=oauth-failed",
        "Set-Cookie": clearCookieHeader,
      },
    });
  }

  const returnToSlug = parsed.slug;

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login?error=oauth-failed",
        "Set-Cookie": clearCookieHeader,
      },
    });
  }

  // Re-resolve the slug to a tenant. Reject non-existent / platform.
  const db = drizzle(env.DB);
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, returnToSlug))
    .limit(1)
    .all();
  if (!tenant || tenant.kind === RESERVED_PLATFORM_KIND) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login?error=oauth-failed",
        "Set-Cookie": clearCookieHeader,
      },
    });
  }

  const github = createGitHubClient(
    env.GITHUB_CLIENT_ID,
    env.GITHUB_CLIENT_SECRET,
    APEX_OAUTH_CALLBACK_URL,
  );

  let primaryEmail: string | null;
  let ghUserId: string;
  let ghUserLogin: string;
  try {
    const tokens = await github.validateAuthorizationCode(code);
    const accessToken = tokens.accessToken();

    primaryEmail = await fetchGitHubUserEmail(accessToken);

    if (!primaryEmail) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/login?error=no-email",
          "Set-Cookie": clearCookieHeader,
        },
      });
    }

    // Fetch GitHub user id + login. Required so the handoff row
    // carries the bind target for the first-login github_id binding
    // (preserves the existing v0.4 policy in the handoff route).
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Fisqua",
      },
    });
    if (!userResponse.ok) {
      throw new Error("github /user fetch failed");
    }
    const ghUser = (await userResponse.json()) as {
      id: number;
      login: string;
    };
    ghUserId = String(ghUser.id);
    ghUserLogin = ghUser.login;
  } catch {
    // arctic OAuth2RequestError, network errors, GitHub API failures.
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/login?error=oauth-failed",
        "Set-Cookie": clearCookieHeader,
      },
    });
  }

  // Mint handoff id and insert the row. crypto.randomUUID() is a
  // cryptographically strong UUIDv4 in the Workers runtime.
  const handoffId = crypto.randomUUID();
  await insertHandoff(db, {
    id: handoffId,
    email: primaryEmail,
    githubId: ghUserId,
    githubLogin: ghUserLogin,
    returnToSlug,
    now: Date.now(),
  });

  // 302 to the tenant subdomain's handoff route. The fisqua.org base
  // is the production tenant URL; in dev/test the browser may be on
  // a different apex (`fisqua.test`, `localhost:8788`), but the
  // handoff URL still uses fisqua.org because production cutover is
  // the only place where the apex callback is registered with GitHub.
  // Tests stub fetch, so they never actually hit this URL — they
  // assert the 302 Location and the inserted row.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://${returnToSlug}.fisqua.org/auth/github/handoff?t=${handoffId}`,
      "Set-Cookie": clearCookieHeader,
    },
  });
}

// @version v0.4.0
