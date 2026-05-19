/**
 * Impersonation Handoff Helpers
 *
 * This module deals with the two helpers the operator login-as flow
 * shares between the platform-host action route (mints + inserts the
 * row) and the tenant subdomain's `/handoff/impersonation` route
 * (consumes it).
 * Centralising the atomic single-use consume here means the handoff
 * route cannot accidentally skip the
 * `consumed = 0 AND expires_at > now` guard.
 *
 * Mirrors `app/lib/oauth-handoff.server.ts` exactly in shape — same
 * narrative-header convention, same `sql\`...\`` template literal
 * usage, same `result.results` UPDATE … RETURNING read pattern. The
 * tables are deliberately separate: keeping the
 * OAuth narrative pure, giving `audit_log.impersonation_session_id`
 * a clean FK-conceptual target, and letting the role-based
 * impersonation columns (`target_tenant_id`, `target_role`) shed the
 * OAuth-shape pollution. The single-use lifecycle is identical; the
 * payload is not.
 *
 * `insertImpersonationHandoff(db, row)` — writes a row with
 * `consumed = 0` and `expires_at = now + IMPERSONATION_HANDOFF_TTL_MS`.
 * The caller mints `id` from `crypto.randomUUID()` before calling; the
 * helper does not generate ids, so the action route owns the entropy
 * source and the helper stays a pure DB primitive.
 *
 * `consumeImpersonationHandoff(db, id, now)` — issues a single
 *
 *   UPDATE impersonation_handoffs
 *      SET consumed = 1
 *    WHERE id = ?
 *      AND consumed = 0
 *      AND expires_at > ?
 *    RETURNING actor_user_id, target_tenant_id, target_role, reason;
 *
 * Returning a row implies the consume succeeded; no row implies
 * failure (not found, expired, or already consumed) and the helper
 * returns `null`. D1 supports RETURNING in UPDATE, so the consume is
 * one round-trip and race-safe — two browsers racing on the same id
 * will see the loser get rowcount 0. (A SELECT-then-UPDATE pattern
 * would be racy and is deliberately avoided.)
 *
 * The helper deliberately does NOT cross-check the
 * `target_tenant_id` against the request host or the `target_role`
 * against any operator-side authorisation rule. Defence-in-depth
 * resolution lives in the handoff route, after
 * consume, against the request's own resolved tenant. Keeping the
 * helper a pure DB primitive lets the route own the host-check and
 * authorisation logic where the request context lives.
 *
 * 30s TTL rationale: browser hop is sub-second on the happy
 * path; 30s slack for slow mobile networks; narrow replay window if
 * the token leaks via referer or browser history. The bounded TTL is
 * applied inside `insertImpersonationHandoff`, not at the call site,
 * so the action route cannot accidentally drift it.
 *
 * @version v0.4.0
 */

import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

/**
 * Time-to-live for an impersonation_handoffs row, in milliseconds.
 * 30s matches the OAuth handoff TTL — same browser-hop
 * threat model, same slack budget for slow mobile networks.
 */
export const IMPERSONATION_HANDOFF_TTL_MS = 30_000 as const;

/**
 * The six role flag literal names. Mirrors the CHECK constraint on
 * `impersonation_handoffs.target_role` exactly. A future migration
 * that adds a seventh role flag must update both this union AND the
 * SQL CHECK clause; mismatch is caught by the consume helper's
 * runtime CHECK rejection (the helper does no narrowing).
 */
export type ImpersonationRole =
  | "isAdmin"
  | "isSuperAdmin"
  | "isCollabAdmin"
  | "isArchiveUser"
  | "isUserManager"
  | "isCataloguer";

export interface InsertImpersonationHandoffRow {
  /**
   * Opaque 256-bit URL-safe random id. The caller mints this with
   * `crypto.randomUUID()` (Workers runtime guarantees a
   * cryptographically strong UUIDv4). The helper does not generate
   * ids.
   */
  id: string;
  /** Operator's user id (lives in the `platform` tenant). */
  actorUserId: string;
  /** FK to `tenants.id` — the tenant the operator will impersonate within. */
  targetTenantId: string;
  /** One of the six role flag names; CHECK-enforced at the DB layer. */
  targetRole: ImpersonationRole;
  /** Optional operator notes captured at login-as time. */
  reason: string | null;
  /** Epoch-ms wall clock; `expires_at = now + IMPERSONATION_HANDOFF_TTL_MS`. */
  now: number;
}

/**
 * Inserts a fresh handoff row. The TTL is computed inside the helper
 * so the action route cannot drift it by accident.
 */
export async function insertImpersonationHandoff(
  db: DrizzleD1Database<any>,
  row: InsertImpersonationHandoffRow,
): Promise<void> {
  const expiresAt = row.now + IMPERSONATION_HANDOFF_TTL_MS;
  await db.run(sql`
    INSERT INTO impersonation_handoffs (
      id, actor_user_id, target_tenant_id, target_role, reason,
      expires_at, consumed, created_at
    ) VALUES (
      ${row.id}, ${row.actorUserId}, ${row.targetTenantId}, ${row.targetRole}, ${row.reason},
      ${expiresAt}, 0, ${row.now}
    )
  `);
}

export interface ConsumedImpersonationHandoff {
  actorUserId: string;
  targetTenantId: string;
  /**
   * One of the six role flag names. Typed as `string` because the
   * helper does not narrow at the runtime boundary; callers cast to
   * `ImpersonationRole` after their own validation (the DB CHECK
   * already ensures the value is one of the six literals on insert).
   */
  targetRole: string;
  reason: string | null;
}

/**
 * Atomically marks a handoff row consumed and returns its
 * identity-bearing fields. Returns `null` when the row does not
 * exist, has already been consumed, or has expired. The
 * single-statement UPDATE … RETURNING is race-safe across concurrent
 * requests — D1 serialises writes per row.
 */
export async function consumeImpersonationHandoff(
  db: DrizzleD1Database<any>,
  id: string,
  now: number,
): Promise<ConsumedImpersonationHandoff | null> {
  const result = await db.run(sql`
    UPDATE impersonation_handoffs
       SET consumed = 1
     WHERE id = ${id}
       AND consumed = 0
       AND expires_at > ${now}
     RETURNING actor_user_id, target_tenant_id, target_role, reason
  `);

  // Drizzle's d1 driver surfaces RETURNING rows under `results`. The
  // shape is an array of plain objects with the column names as keys
  // (mirrors app/lib/oauth-handoff.server.ts:117–123).
  const rows = (result as unknown as { results?: Array<Record<string, unknown>> })
    .results;
  if (!rows || rows.length === 0) {
    return null;
  }
  const r = rows[0];
  return {
    actorUserId: String(r.actor_user_id),
    targetTenantId: String(r.target_tenant_id),
    targetRole: String(r.target_role),
    reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
  };
}

// @version v0.4.0
