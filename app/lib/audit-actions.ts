/**
 * Audit Log Action Enum
 *
 * This module deals with the seven bounded action values that
 * `audit_log.action` accepts. The enum lives here, in a tiny
 * constants-only module, so it can be
 * imported from BOTH `app/db/schema.ts` (for the Drizzle column's
 * `enum:` runtime hint that gives TypeScript narrowing on selects) AND
 * `app/lib/audit.server.ts` (for the `withAuditLog` wrapper's
 * compile-time `AuditAction` type). Putting the constant in either
 * downstream file would create a circular import — `audit.server.ts`
 * imports the table from `schema.ts`, so `schema.ts` cannot import the
 * constant from `audit.server.ts`.
 *
 * The DB layer's CHECK constraint on `audit_log.action` (migration
 * 0037) is the structural source of truth; this constant is the
 * TypeScript mirror that lets the `withAuditLog` wrapper's signature
 * reject typos at compile time. If the migration ever extends the
 * enum, this constant extends in lockstep — and the keystone
 * `tests/db/audit-log.test.ts` "action CHECK" assertion will catch
 * a drift in either direction.
 *
 * @version v0.4.0
 */

/**
 * The seven bounded `audit_log.action` values.
 *
 *   - `create_tenant` — operator creates a new tenant. The
 *     bootstrap-superadmin user insert is part of this action's
 *     scope; it does not get its own audit row.
 *   - `soft_disable_tenant` — operator flips `tenants.disabled_at` to
 *     the current epoch.
 *   - `reset_superadmin` — reserved enum slot; no UI in v0.4.
 *     Recovery flows through `login_as` + tenant-side admin UI.
 *   - `login_as` — operator mints an impersonation handoff and the
 *     tenant subdomain consumes it.
 *   - `edit_on_behalf` — reserved enum slot; no v0.4 code path.
 *     Tenant content edits flow through `login_as` instead.
 *   - `set_capability` — operator toggles one of the four capability
 *     booleans on a tenant.
 *   - `set_quota` — reserved enum slot; quota columns exist on
 *     `tenants` but no code path enforces them in v0.4.
 */
export const AUDIT_LOG_ACTIONS = [
  "create_tenant",
  "soft_disable_tenant",
  "reset_superadmin",
  "login_as",
  "edit_on_behalf",
  "set_capability",
  "set_quota",
] as const;

/**
 * Compile-time narrowing of the seven valid action values. Used by
 * `withAuditLog`'s parameter type so a typo in a route handler is
 * a TypeScript error, not a runtime CHECK violation surfaced to the
 * operator as a 500.
 */
export type AuditAction = (typeof AUDIT_LOG_ACTIONS)[number];

// @version v0.4.0
