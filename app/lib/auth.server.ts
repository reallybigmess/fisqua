/**
 * Authentication Server Helpers
 *
 * This module deals with the two server-side primitives that underlie
 * sign-in: minting and verifying magic-link tokens, and fetching the
 * authenticated user from D1 for the middleware to hand into the
 * request context.
 *
 * `generateMagicLink` looks up a user by email, mints a one-time token,
 * stores it in the `magic_links` table with a fifteen-minute expiry,
 * builds the verification URL, and sends it through Resend. It returns
 * a `{ success }` shape on the happy path and `{ error }` when the
 * email is not associated with any user -- callers surface the error
 * verbatim on the login form.
 *
 * `verifyMagicLink` takes the token from the callback query string and
 * returns the user id if the token is valid (exists, unused, and not
 * past its expiry), or `null` otherwise. On success it marks the token
 * as used so it cannot be replayed; the 15-minute window plus
 * single-use semantics are the core of the magic-link security model.
 *
 * `requireUser` fetches the user row keyed by id and returns the full
 * role-flag snapshot that `_auth.tsx` needs to populate
 * `userContext`. It mirrors the shape of the `User` type defined in
 * `app/context.ts` so loaders further down the tree can rely on every
 * role flag being present. The returned shape includes `tenantId`:
 * the source of truth that `authMiddleware`
 * asserts against the resolved tenant (`user.tenantId === tenant.id`)
 * before letting any loader run, and downstream loaders read it from
 * `userContext` to scope domain-table queries.
 *
 * @version v0.4.0
 */

import { eq, and, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { users, magicLinks } from "../db/schema";
import { sendMagicLinkEmail } from "./email.server";
import { getAppConfig } from "./config.server";

/**
 * Generates a magic link for the given email address.
 * Returns { success: true } if the email was sent, or { error: string } if
 * the email is not associated with any user.
 */
export async function generateMagicLink(
  db: DrizzleD1Database<any>,
  email: string,
  origin: string,
  resendApiKey: string,
  env: { APP_NAME?: string; SENDER_EMAIL?: string; SKIP_MAGIC_LINK_EMAIL?: boolean } = {}
): Promise<{ success?: boolean; error?: string }> {
  // Look up user by email
  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .get();

  if (!user) {
    return { error: "No account found for this email." };
  }

  // Generate token
  const token = crypto.randomUUID();
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;

  await db.insert(magicLinks).values({
    id: crypto.randomUUID(),
    token,
    userId: user.id,
    expiresAt: now + fifteenMinutes,
    createdAt: now,
  });

  // Build verification URL
  const verifyUrl = new URL("/auth/verify", origin);
  verifyUrl.searchParams.set("token", token);

  if (env.SKIP_MAGIC_LINK_EMAIL == true){
    console.log("SKIP_MAGIC_LINK_EMAIL is true. Printing the magic link directly to the console:\n"+verifyUrl.toString())
    return { success: true };
  }
  else if (env.SKIP_MAGIC_LINK_EMAIL == false){
    // Send email
    const appConfig = getAppConfig(env);
    await sendMagicLinkEmail(resendApiKey, email, verifyUrl.toString(), appConfig);
    return { success: true };
  }
}

/**
 * Verifies a magic link token. Returns the userId if the token is valid
 * (exists, not expired, not already used), or null otherwise.
 * Marks the token as used on success.
 */
export async function verifyMagicLink(
  db: DrizzleD1Database<any>,
  token: string
): Promise<string | null> {
  const link = await db
    .select()
    .from(magicLinks)
    .where(
      and(eq(magicLinks.token, token), isNull(magicLinks.usedAt))
    )
    .get();

  if (!link) {
    return null;
  }

  // Check expiry
  if (link.expiresAt < Date.now()) {
    return null;
  }

  // Mark as used
  await db
    .update(magicLinks)
    .set({ usedAt: Date.now() })
    .where(eq(magicLinks.id, link.id));

  return link.userId;
}

/**
 * Fetches a user by ID and returns the full role-flag snapshot that
 * `userContext` is populated with, or null if the user is missing.
 */
export async function requireUser(
  db: DrizzleD1Database<any>,
  userId: string
): Promise<{
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
  lastActiveAt: number | null;
  githubId: string | null;
} | null> {
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin as unknown as boolean,
    isSuperAdmin: user.isSuperAdmin as unknown as boolean,
    isCollabAdmin: user.isCollabAdmin as unknown as boolean,
    isArchiveUser: user.isArchiveUser as unknown as boolean,
    isUserManager: user.isUserManager as unknown as boolean,
    isCataloguer: user.isCataloguer as unknown as boolean,
    lastActiveAt: user.lastActiveAt ?? null,
    githubId: user.githubId ?? null,
  };
}
