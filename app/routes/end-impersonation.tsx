/**
 * End Impersonation
 *
 * This action handles POST `/end-impersonation` — the structural
 * counterpart to `/handoff/impersonation`: the handoff route MINTED
 * the impersonating session; this route CLEARS it. Posted by the
 * persistent banner's
 * "End impersonation" button (`app/components/layout/impersonation-banner.tsx`)
 * which renders on every tenant subdomain page during an impersonation
 * envelope.
 *
 * ## What this route does
 *
 *   1. Reads the session cookie. If the session has no `userId`
 *      (i.e. the operator's cookie was cleared between actions, or
 *      the form was submitted without a session), 302 to `/login`.
 *      The form should never reach this state in practice — the
 *      banner only renders when the auth middleware has populated
 *      `impersonationContext`, which requires a session — but the
 *      defensive branch keeps the action well-defined.
 *   2. `session.unset("impersonating")`. The userId is preserved —
 *      the operator stays signed in on this tenant subdomain, just
 *      without the impersonation envelope. (In v0.4 they cannot
 *      actually do anything as a non-impersonating operator on a
 *      tenant subdomain because `requireTenantUser`'s default-deny
 *      will 403 them; this is fine — the next request 302s to login
 *      via the auth middleware. The userId-preserving shape is the
 *      correct semantic so future routes that legitimately admit a
 *      bare operator session on tenant subdomains do not need a
 *      special re-auth dance.)
 *   3. 302 redirects to `https://platform.<tld>/operator/tenants` —
 *      the operator's home on the platform host. The TLD (`.test`
 *      or `.org`) is derived from the request hostname's last two
 *      segments so dev and prod produce structurally identical
 *      redirects.
 *
 * ## Route registration
 *
 * Lives at the TOP LEVEL of `app/routes.ts`, NOT inside `_auth`. The
 * action must be reachable both with AND without an impersonating
 * envelope (test 2: a stale banner-driven POST against a non-
 * impersonating session is a no-op redirect, not a 403). Nesting
 * inside `_auth` would route the request through `authMiddleware`
 * with its `requireTenantUser` default-deny — which would 403 a
 * post-impersonation cleanup attempt on the basis that the session's
 * impersonating envelope had ALREADY been cleared. Top-level routing
 * keeps the cleanup primitive idempotent.
 *
 * ## Audit-coverage exemption
 *
 * This file has an `action` export but does NOT call `withAuditLog`.
 * By design, no audit row is written by end-impersonation — the
 * original `login_as` row's `impersonation_session_id` plus the
 * wall-clock difference between `audit_log.created_at` and the
 * session's `lastActivityAt` at clear-time captures the timeframe.
 * The audit-coverage CI keystone scanner
 * (`tests/operator/audit-coverage.test.ts`) therefore needs to know
 * about this exemption: this file is at the TOP-LEVEL of routes (not
 * under `_operator.*`), so the keystone's glob pattern
 * `app/routes/_operator.*.{ts,tsx}` does NOT match it. No scanner
 * change is required — the file is naturally exempt by not being
 * matched.
 *
 * @version v0.4.0
 */

import { redirect } from "react-router";
import { createSessionStorage } from "../sessions.server";
import type { Route } from "./+types/end-impersonation";

export async function action({ request, context }: Route.ActionArgs) {
  const env = (context as any).cloudflare.env;
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET,
  );
  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");

  if (!userId) {
    // Defensive: no session at all → send to login. The banner that
    // posts to this action only renders for users with a session, so
    // this branch should not be reachable from the UI.
    return redirect("/login");
  }

  // Clear the impersonating envelope. userId preserved.
  session.unset("impersonating");

  // Construct the platform-host redirect target. The current request
  // is on a tenant subdomain (e.g. `neogranadina.fisqua.test`); the
  // last two segments form the TLD (`fisqua.test` or `fisqua.org`).
  // We deliberately don't hard-code `.test` or `.org` so the same
  // route works in dev, test, and prod identically.
  const hostname = new URL(request.url).hostname;
  const tld = hostname.split(".").slice(-2).join(".");
  const proto = new URL(request.url).protocol;
  return redirect(`${proto}//platform.${tld}/operator/tenants`, {
    headers: { "Set-Cookie": await commitSession(session) },
  });
}

// @version v0.4.0
