/**
 * `withAuditLog` Wrapper
 *
 * This module deals with the single mechanism that makes "every
 * operator action writes a row before responding" structurally true.
 * Every operator action
 * handler in `app/routes/_operator.*.tsx` wraps its database work in
 * this helper; the wrapper composes the audit insert + the caller's
 * work statements into one atomic D1 batch.
 *
 * ## Atomicity contract
 *
 * The wrapper builds a single `db.batch([...workStatements, auditInsert])`
 * and submits it. D1 batches are all-or-nothing: if any statement fails
 * (CHECK violation, FK violation, transient D1 error), the entire batch
 * rolls back. The caller's work and the audit insert therefore land
 * together or not at all.
 *
 *   - Audit insert is the LAST statement in the batch (not the first).
 *     Atomicity is preserved either way, but putting audit last lets
 *     `create_tenant` insert the new tenant before the audit row's
 *     `target_tenant_id` FK references it — D1 has no DEFERRED FK
 *     support, so audit-first would FK-fail on every `create_tenant`.
 *     Atomicity contract unchanged regardless of position.
 *   - Audit failure (e.g., CHECK violation on `action`) prevents the
 *     batch from committing; the work rolls back.
 *   - Work failure (e.g., a CHECK violation in the caller's INSERT)
 *     prevents the audit row from surviving — no orphaned audit
 *     records pointing at uncommitted work.
 *   - The wrapper rethrows on failure; the route translates the throw
 *     into a 5xx and the operator retries. The wrapper does not swallow.
 *
 * ## CI grep backstop
 *
 * `tests/operator/audit-coverage.test.ts` is the keystone meta-grep
 * that asserts every operator action handler calls `withAuditLog`
 * exactly once. A new operator action that forgets the wrapper fails
 * CI before review. More than one wrapper per action handler also
 * fails — a multi-batch action defeats the atomicity contract.
 *
 * ## `details` JSON convention
 *
 * The `details` parameter is a `Record<string, unknown> | null`. The
 * wrapper `JSON.stringify`s the value onto `audit_log.details`
 * (TEXT column). `null` produces SQL NULL, not the four-character
 * string `"null"`. Future audit-UI work can render structured payloads
 * without a schema migration. Non-serialisable values throw at
 * `JSON.stringify` (caller bug, not security).
 *
 * ## Cross-tenant reads not audited
 *
 * Operator-list and operator-detail page LOADERS do not call this
 * wrapper. The temporal capture for cross-tenant reads is the
 * impersonation envelope's 30-min window plus the `login_as` audit
 * row that opens it. "Reads logged for support actions" is satisfied
 * at the session level, not the request level.
 *
 * ## Helper does NOT generate ids
 *
 * `audit_log.id` is `crypto.randomUUID()` minted inside the wrapper.
 * The Workers runtime guarantees a cryptographically strong UUIDv4.
 * The caller does not pass an id; the helper owns the entropy source
 * for forensic-trail uniqueness.
 *
 * @version v0.4.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { auditLog } from "../db/schema";
import { AUDIT_LOG_ACTIONS, type AuditAction } from "./audit-actions";

// Re-export so callers can `import { AUDIT_LOG_ACTIONS, type AuditAction }
// from "~/lib/audit.server"` without reaching into the constants module.
export { AUDIT_LOG_ACTIONS, type AuditAction };

/**
 * Parameters for `withAuditLog`. Mirrors the columns the wrapper
 * writes into `audit_log` one-to-one, plus the optional `now`
 * override used by tests and any future deterministic-clock
 * plumbing.
 */
export interface WithAuditLogParams {
  /**
   * One of the seven bounded `audit_log.action` values. The
   * `AuditAction` union is the compile-time guard; the DB CHECK
   * (migration 0037) is the runtime guard.
   */
  action: AuditAction;
  /**
   * The operator's user id (FK to `users.id`). Nullable in the
   * schema for the FK SET NULL cascade after user deletion;
   * route handlers should always pass a value.
   */
  actorUserId: string | null;
  /**
   * Denormalised forensic string. Operators come and go but the
   * audit trail must remain reconstructible — the FK on
   * `actor_user_id` is `ON DELETE SET NULL`, so this column is the
   * one place denormalisation buys real audit integrity. Pass the
   * operator's email or a stable handle.
   */
  actorUserIdText: string;
  /**
   * The actor's tenant — `PLATFORM_TENANT_ID` for operator actions.
   * `ON DELETE RESTRICT`; the platform tenant is never deleted in
   * v0.4.
   */
  actorTenantId: string;
  /**
   * The tenant the action targets, when applicable.
   * `create_tenant` sets it to the new tenant's id; `set_capability`
   * to the tenant being modified; `reset_superadmin` may be null
   * if the action is platform-scoped.
   */
  targetTenantId?: string | null;
  /**
   * Free-text discriminator for the target object (e.g. `"tenant"`,
   * `"capability"`, `"role"`).
   */
  targetObjectKind?: string | null;
  /**
   * The target object's id (e.g. the tenant id, the capability
   * flag name, the role flag name for `login_as`).
   */
  targetObjectId?: string | null;
  /**
   * The `impersonation_handoffs.id` — threaded through every action
   * the operator takes during an impersonation session so the audit
   * trail is reconstructible.
   */
  impersonationSessionId?: string | null;
  /**
   * Structured payload for the audit-UI. JSON-stringified onto
   * `audit_log.details` (TEXT). `null` writes SQL NULL.
   */
  details?: Record<string, unknown> | null;
  /**
   * Test/clock-injection hook. Defaults to `Date.now()` in production.
   */
  now?: number;
}

/**
 * The shape `fn` must return: an array of Drizzle batch items
 * (insert/update/delete query builders or raw `db.run(sql)` builders)
 * plus a `result` value passed through to the caller.
 */
export interface WithAuditLogWorkResult<T> {
  /**
   * Drizzle batch items composed by the caller. Each item must be a
   * statement that can be embedded in `db.batch([...])` — typically
   * `db.insert(...)`, `db.update(...)`, `db.delete(...)`, or
   * `db.run(sql\`...\`)`. An empty array means "audit row only";
   * the wrapper still composes a single-statement batch.
   */
  workStatements: BatchItem<"sqlite">[];
  /**
   * Whatever the caller wants the wrapper to return on success.
   */
  result: T;
}

/**
 * Wraps a unit of operator work so the audit insert and the work
 * happen in one atomic D1 batch. See the file's narrative header for
 * the full atomicity contract.
 *
 * @param db    The Drizzle D1 instance from the route's `context.cloudflare.env.DB`.
 * @param params The audit-row payload.
 * @param fn    Callback returning `{ workStatements, result }`. The
 *              wrapper prepends the audit insert and submits the
 *              batch via `db.batch(...)`.
 * @returns     Whatever `fn`'s `result` field carries. Throws on
 *              batch failure; caller emits 5xx.
 */
export async function withAuditLog<T>(
  db: DrizzleD1Database<any>,
  params: WithAuditLogParams,
  fn: (db: DrizzleD1Database<any>) => Promise<WithAuditLogWorkResult<T>>,
): Promise<T> {
  const { workStatements, result } = await fn(db);

  const now = params.now ?? Date.now();
  const detailsJson =
    params.details === undefined || params.details === null
      ? null
      : JSON.stringify(params.details);

  // Build the audit insert as a Drizzle batch item. Drizzle's d1
  // driver accepts the un-awaited query builder in `db.batch([...])`
  // and serialises every item into a single round-trip.
  const auditInsert = db.insert(auditLog).values({
    id: crypto.randomUUID(),
    createdAt: now,
    actorUserId: params.actorUserId,
    actorUserIdText: params.actorUserIdText,
    actorTenantId: params.actorTenantId,
    action: params.action,
    targetTenantId: params.targetTenantId ?? null,
    targetObjectKind: params.targetObjectKind ?? null,
    targetObjectId: params.targetObjectId ?? null,
    impersonationSessionId: params.impersonationSessionId ?? null,
    details: detailsJson,
  });

  // Statement ordering: work first, audit last. Atomicity is preserved
  // either way (D1 batches are all-or-nothing), but putting the audit
  // insert LAST lets the row reference target objects the work just
  // created in the same batch — `create_tenant`'s audit row carries
  // `target_tenant_id = <new-tenant-id>`, and the FK to `tenants(id)`
  // requires the tenant row to exist before the audit row commits.
  // SQLite/D1 enforces FKs per-statement (no DEFERRED constraint
  // support in D1), so audit-first would FK-fail on every
  // `create_tenant` action. Documented in the file's narrative header.
  await db.batch([
    ...workStatements,
    auditInsert,
  ] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);

  return result;
}

// @version v0.4.0
