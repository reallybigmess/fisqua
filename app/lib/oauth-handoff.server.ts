/**
 * OAuth Handoff Helpers
 *
 * This module deals with the two helpers the apex GitHub OAuth
 * callback and the tenant subdomain handoff route share. Centralising
 * the atomic single-use consume here means the handoff route cannot
 * accidentally skip the `consumed = 0 AND expires_at > now` guard.
 *
 * `insertHandoff(db, row)` — writes a row with `consumed = 0` and
 * `expires_at = now + OAUTH_HANDOFF_TTL_MS`. The caller mints `id` from
 * `crypto.randomUUID()` (or arctic's state generator) before calling; the
 * helper does not generate ids, so the apex callback owns the entropy
 * source and the helper stays a pure DB primitive.
 *
 * `consumeHandoff(db, id, now)` — issues a single
 *
 *   UPDATE oauth_handoffs
 *      SET consumed = 1
 *    WHERE id = ?
 *      AND consumed = 0
 *      AND expires_at > ?
 *    RETURNING email, github_id, return_to_slug;
 *
 * Returning a row implies the consume succeeded; no row implies failure
 * (not found, expired, or already consumed) and the helper returns `null`.
 * D1 supports RETURNING in UPDATE, so the consume is one round-trip and
 * race-safe — two browsers racing on the same id will see the loser get
 * rowcount 0. (A SELECT-then-UPDATE pattern would be racy and is
 * deliberately avoided.)
 *
 * The helper deliberately does NOT cross-check the `return_to_slug` against
 * the request host. That defence-in-depth check is the handoff route's
 * responsibility, after consume, against the request's own resolved
 * tenant. Keeping the helper a pure DB primitive lets the route own the
 * host-check logic where the request context lives.
 *
 * @version v0.4.0
 */

import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * Time-to-live for an oauth_handoffs row, in milliseconds. The browser
 * hop from apex to tenant subdomain is sub-second on the happy path; 30s
 * is generous slack for slow mobile networks while keeping the replay
 * window narrow if the token leaks via referer or browser history.
 */
export const OAUTH_HANDOFF_TTL_MS = 30_000 as const;

export interface InsertHandoffRow {
  /**
   * Opaque 256-bit URL-safe random id. The caller mints this with
   * `crypto.randomUUID()` (Workers runtime guarantees a cryptographically
   * strong UUIDv4) or arctic's state generator. The helper does not
   * generate ids.
   */
  id: string;
  /** Primary verified GitHub email, lowercased. */
  email: string;
  /** GitHub user's numeric id as text. */
  githubId: string;
  /** GitHub login (handle). */
  githubLogin: string;
  /** Tenant slug captured from the apex init's state cookie. */
  returnToSlug: string;
  /** Epoch-ms wall clock; `expires_at = now + OAUTH_HANDOFF_TTL_MS`. */
  now: number;
}

/**
 * Inserts a fresh handoff row. The TTL is computed inside the helper so
 * the apex callback cannot drift it by accident.
 */
export async function insertHandoff(
  db: DrizzleD1Database<any>,
  row: InsertHandoffRow,
): Promise<void> {
  const expiresAt = row.now + OAUTH_HANDOFF_TTL_MS;
  await db.run(sql`
    INSERT INTO oauth_handoffs (
      id, email, github_id, github_login, return_to_slug,
      expires_at, consumed, created_at
    ) VALUES (
      ${row.id}, ${row.email}, ${row.githubId}, ${row.githubLogin}, ${row.returnToSlug},
      ${expiresAt}, 0, ${row.now}
    )
  `);
}

export interface ConsumedHandoff {
  email: string;
  githubId: string;
  returnToSlug: string;
}

/**
 * Atomically marks a handoff row consumed and returns its identity-bearing
 * fields. Returns `null` when the row does not exist, has already been
 * consumed, or has expired. The single-statement UPDATE … RETURNING is
 * race-safe across concurrent requests — D1 serialises writes per row.
 */
export async function consumeHandoff(
  db: DrizzleD1Database<any>,
  id: string,
  now: number,
): Promise<ConsumedHandoff | null> {
  const result = await db.run(sql`
    UPDATE oauth_handoffs
       SET consumed = 1
     WHERE id = ${id}
       AND consumed = 0
       AND expires_at > ${now}
     RETURNING email, github_id, return_to_slug
  `);

  // Drizzle's d1 driver surfaces RETURNING rows under `results`. The shape
  // is an array of plain objects with the column names as keys.
  const rows = (result as unknown as { results?: Array<Record<string, unknown>> })
    .results;
  if (!rows || rows.length === 0) {
    return null;
  }
  const r = rows[0];
  return {
    email: String(r.email),
    githubId: String(r.github_id),
    returnToSlug: String(r.return_to_slug),
  };
}

// @version v0.4.0
