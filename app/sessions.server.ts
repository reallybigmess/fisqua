/**
 * Session Storage
 *
 * This module deals with the cookie-backed session for the
 * authenticated tree. Host-only cookie (no `Domain` attribute) — a
 * structural guarantee that a session
 * minted on one tenant subdomain cannot leak to another. Cross-
 * subdomain operator access goes through the explicit single-use D1
 * handoff (`impersonation_handoffs`), not by widening cookie scope.
 *
 * Session payload shape:
 *   - `userId` — required; the signed-in user.
 *   - `impersonating` — optional; populated by the tenant subdomain's
 *     `/handoff/impersonation` route after a successful handoff
 *     consume, cleared by `/end-impersonation` or by the auth
 *     middleware's 30-min idle timeout. While set, the
 *     auth middleware passes `{ allowImpersonation: true }` to
 *     `requireTenantUser` so the operator's user (which lives in the
 *     `platform` tenant) can read tenant-subdomain routes; while
 *     unset, default-deny applies.
 *   - `role` — one of the six role-flag literal names. Acts as the
 *     authorisation gate during impersonation: tenant routes read
 *     this (instead of the user's tenant-side role flags, which do
 *     not exist for the operator) to decide whether the impersonating
 *     session can perform a given action.
 *   - `sessionId` — the `impersonation_handoffs.id` that minted this
 *     session. Threads through every audit_log row written during
 *     the impersonation envelope so the trail is reconstructible.
 *   - `lastActivityAt` — epoch-ms; refreshed on each request by the
 *     auth middleware, used to enforce the 30-min idle timeout.
 *
 * @version v0.4.0
 */

// --- TEMPLATE INFRASTRUCTURE --- do not modify when extending

import { createCookieSessionStorage } from "react-router";

type SessionData = {
  userId: string;
  impersonating?: {
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
};

type SessionFlashData = {
  error: string;
  success: string;
};

/**
 * Factory for creating cookie session storage.
 * Must be called per-request because the secret comes from env.
 */
export function createSessionStorage(sessionSecret: string) {
  return createCookieSessionStorage<SessionData, SessionFlashData>({
    cookie: {
      name: "__session",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
      sameSite: "lax",
      secrets: [sessionSecret],
      // `Secure` everywhere except the vite dev server, which serves
      // plain http on *.localhost — browsers that don't treat
      // *.localhost as a trustworthy origin (Safari, curl) drop a
      // Secure cookie there, silently breaking local login.
      secure: !import.meta.env.DEV,
    },
  });
}

// @version v0.6.0
