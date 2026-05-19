/**
 * GitHub OAuth Helpers
 *
 * This module deals with the thin wrappers around `arctic`'s GitHub
 * client plus the GitHub user/email fetches the apex callback uses.
 * Two things live here:
 *
 *   - `APEX_OAUTH_CALLBACK_URL` — the single Authorization callback URL
 *     registered with the GitHub OAuth App. The apex init route passes it
 *     to `createGitHubClient`, the apex callback passes it to
 *     `validateAuthorizationCode`, and tests assert against it. Constant
 *     to defend against a future refactor that derives the callback from
 *     `request.origin` — an earlier design that was structurally
 *     infeasible because GitHub OAuth Apps allow exactly one callback URL.
 *
 *   - `APEX_HOSTS` — the set of hostnames that count as the apex. Production
 *     is `fisqua.org`; dev/test recognise `fisqua.test` (synthetic test
 *     hostname) and `localhost`/`localhost:8788` (the wrangler-dev
 *     default). This list is the canonical apex check the init and
 *     callback routes consult; tenant subdomains are everything else
 *     (resolved via `getTenantFromRequest`).
 *
 * @version v0.4.0
 */
import * as arctic from "arctic";

export { generateState } from "arctic";

/**
 * The one Authorization callback URL registered with the GitHub OAuth App.
 *
 * GitHub OAuth Apps allow exactly one Authorization callback URL (GitHub
 * Apps — a different product — allow multiple). This constant exists so
 * any future refactor that derives the callback from `request.origin`
 * (an earlier design) breaks at compile or test time, not in production.
 *
 * The init route hands this to `createGitHubClient`; the callback route
 * hands it to `createGitHubClient` again (arctic re-validates redirect_uri
 * server-side at exchange time). Tests assert that both sides see the
 * same constant regardless of `?return_to=<slug>`.
 */
export const APEX_OAUTH_CALLBACK_URL =
  "https://fisqua.org/auth/github/callback" as const;

/**
 * Hostnames that count as the apex for OAuth init + callback host checks.
 * Production is `fisqua.org`; dev/test recognise `fisqua.test` (the
 * project's synthetic test apex) and `localhost`. Tenant subdomains
 * (`<slug>.fisqua.org`, `<slug>.fisqua.test`, `<slug>.localhost`) and
 * the legacy `catalogacion.zasqua.org` host are NOT apex hosts.
 */
export const APEX_HOSTS: ReadonlyArray<string> = [
  "fisqua.org",
  "fisqua.test",
  "localhost",
];

/**
 * Returns true when the request's host is the apex (production or
 * dev/test equivalent). Strips the port before comparing so
 * `localhost:8788` and `fisqua.test:5173` both pass.
 */
export function isApexHost(request: Request): boolean {
  const host = new URL(request.url).hostname.toLowerCase();
  return APEX_HOSTS.includes(host);
}

/**
 * Creates an Arctic GitHub OAuth client.
 */
export function createGitHubClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string
) {
  return new arctic.GitHub(clientId, clientSecret, redirectUri);
}

/**
 * Fetches the primary verified email address from the GitHub API.
 * Returns the email lowercased, or null if no primary+verified email exists.
 */
export async function fetchGitHubUserEmail(
  accessToken: string
): Promise<string | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Fisqua",
    },
  });

  if (!response.ok) {
    return null;
  }

  const emails = (await response.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

  const primary = emails.find((e) => e.primary && e.verified);
  return primary ? primary.email.toLowerCase() : null;
}

/**
 * Parses a single cookie value from a Cookie header string.
 * Returns the decoded value, or null if the cookie is not found.
 */
export function parseCookieValue(
  cookieHeader: string,
  name: string
): string | null {
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

// @version v0.4.0
