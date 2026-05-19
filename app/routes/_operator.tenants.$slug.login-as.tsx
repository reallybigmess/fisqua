/**
 * Operator — Login-As
 *
 * This action handles POST `/operator/tenants/:slug/login-as`, the
 * platform-host-side entry point for the role-based impersonation
 * flow. The role-picker
 * form on the tenant detail page (`_operator.tenants.$slug.tsx`) posts
 * here with `target_role` (one of the six role flag literal names) and
 * an optional free-text `reason`. The handler:
 *
 *   1. Validates the form via `LoginAsSchema`. Unknown roles → Zod
 *      `fieldErrors`; the form re-renders with the error.
 *   2. Looks up the target tenant by slug — cross-tenant read by
 *      design (operator surface). Unknown slug → 404. `kind='platform'`
 *      → 400 (operators do NOT impersonate INTO themselves;
 *      defence-in-depth).
 *   3. Atomically writes BOTH a fresh `impersonation_handoffs` row AND
 *      an `audit_log` row in ONE D1 batch via `withAuditLog`. The
 *      handoff insert is a workStatement inside the batch — if either
 *      insert fails (CHECK violation, FK violation, transient D1
 *      error), neither lands. Atomic-or-nothing.
 *   4. 302 redirects to the target tenant's subdomain handoff URL
 *      (`https://<slug>.fisqua.test/handoff/impersonation?t=<id>`).
 *      The host is constructed by replacing the `platform` subdomain
 *      with the target slug — host-aware URL convention.
 *
 * ## Atomicity contract — handoff INSERT lives inside withAuditLog's
 *    batch, not behind insertImpersonationHandoff
 *
 * `insertImpersonationHandoff(db, row)` in
 * `app/lib/impersonation-handoff.server.ts` ships an
 * `await db.run(sql\`...\`)` shape — convenient for standalone inserts
 * (which the helper's tests use) but NOT a Drizzle batch item shape.
 * `db.batch([...])` requires un-awaited query builders, not awaited
 * Promises. The choice here is to accept the duplication and document
 * it: the helper is for STANDALONE inserts (used by tests + any
 * future non-action call site); the batch form is used inside actions
 * where atomicity with the audit row is the contract.
 *
 * The TTL constant (`IMPERSONATION_HANDOFF_TTL_MS`) is imported from
 * the helper file so the call site cannot drift the 30-second
 * window. The expiry computation
 * `now + IMPERSONATION_HANDOFF_TTL_MS` is duplicated from the helper
 * exactly. The alternative — changing the helper's signature or
 * adding a sibling helper — would either break the helper's existing
 * test contract or add a near-duplicate. The duplication is six
 * lines and the call site is the only one that needs the batch
 * shape; refactoring the helper to support both shapes would cost
 * more readability than it saves.
 *
 * ## No tenant session minted here
 *
 * The action runs on the platform host. The impersonating session is
 * minted on the tenant subdomain by `/handoff/impersonation` (the
 * loader at `app/routes/handoff.impersonation.tsx`) AFTER the atomic
 * consume. The host-only cookie posture forbids cross-subdomain
 * session sharing; the handoff row is the explicit, D1-backed,
 * single-use rendezvous between the two cookie scopes.
 *
 * ## Audit row shape
 *
 *   - `action`                    = `'login_as'`
 *   - `actor_user_id`             = operator.id
 *   - `actor_user_id_text`        = operator.email (denormalised forensic)
 *   - `actor_tenant_id`           = PLATFORM_TENANT_ID
 *   - `target_tenant_id`          = tenant.id
 *   - `target_object_kind`        = `'role'`
 *   - `target_object_id`          = the role flag literal name
 *   - `impersonation_session_id`  = the handoff id (threads forensic
 *                                   continuity to the eventual
 *                                   impersonating session's audit-row
 *                                   trail)
 *   - `details`                   = `{ slug, role, reason }` JSON
 *
 * Exactly ONE audit_log row per impersonation episode lands here. The
 * handoff route does NOT write an audit row at consume; the
 * end-impersonation route does NOT write one either. The
 * session-level temporal envelope (login_as audit row's created_at +
 * impersonating session's lastActivityAt) captures the timeframe
 * without per-action audit traffic during impersonation.
 *
 * @version v0.4.0
 */

import { redirect } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tenants, impersonationHandoffs } from "../db/schema";
import { PLATFORM_TENANT_ID } from "../lib/tenant";
import { withAuditLog } from "../lib/audit.server";
import { IMPERSONATION_HANDOFF_TTL_MS } from "../lib/impersonation-handoff.server";
import { userContext } from "../context";
import type { Route } from "./+types/_operator.tenants.$slug.login-as";

/**
 * Form schema. The `target_role` enum mirrors the SQL CHECK on
 * `impersonation_handoffs.target_role` exactly (the six role flag
 * literal names). A drift between this list and the migration's CHECK
 * would surface as a 5xx at the batch boundary; the keystone
 * `tests/db/audit-log.test.ts`-style invariant for impersonation
 * handoffs lives in `tests/lib/impersonation-handoff.test.ts`.
 */
const LoginAsSchema = z.object({
  target_role: z.enum([
    "isAdmin",
    "isSuperAdmin",
    "isCollabAdmin",
    "isArchiveUser",
    "isUserManager",
    "isCataloguer",
  ]),
  // Optional free-text reason; capped at 500 chars to keep the audit
  // details payload bounded. Empty string → null (cleaner audit trail).
  reason: z
    .string()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = (context as any).cloudflare.env;
  const db = drizzle(env.DB);
  const operator = context.get(userContext);

  const formData = await request.formData();
  const parsed = LoginAsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Cross-tenant read by design — operator surface; no `where(tenantId, ...)`
  // predicate (the cross-tenant keystone deliberately scopes out
  // `_operator.*` files).
  const [target] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, params.slug))
    .limit(1)
    .all();
  if (!target) {
    throw new Response(null, { status: 404 });
  }

  // Defence-in-depth: the operator's own tenant cannot be an
  // impersonation target. The detail page hides the role-picker on
  // platform via canImpersonate=false; this is the action-boundary
  // backstop catching a hostile direct-POST.
  if (target.kind === "platform") {
    return new Response("Cannot impersonate into platform tenant", {
      status: 400,
    });
  }

  const handoffId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + IMPERSONATION_HANDOFF_TTL_MS;

  // Atomic batch: handoff insert + audit insert. withAuditLog appends
  // the audit insert as the LAST statement in the batch — audit-last
  // avoids FK ordering issues for create_tenant; structurally fine
  // here too because audit's target_tenant_id references the
  // EXISTING target tenant, not the handoff row.
  await withAuditLog(
    db,
    {
      action: "login_as",
      actorUserId: operator.id,
      actorUserIdText: operator.email,
      actorTenantId: PLATFORM_TENANT_ID,
      targetTenantId: target.id,
      targetObjectKind: "role",
      targetObjectId: parsed.data.target_role,
      impersonationSessionId: handoffId,
      details: {
        slug: target.slug,
        role: parsed.data.target_role,
        reason: parsed.data.reason,
      },
      now,
    },
    async (txDb) => {
      // Drizzle insert as a batch item (un-awaited builder). The TTL
      // constant is imported from impersonation-handoff.server so the
      // window cannot drift. See narrative header §"Atomicity contract"
      // for why this duplicates the helper's logic instead of calling
      // through to it.
      const insertHandoff = txDb.insert(impersonationHandoffs).values({
        id: handoffId,
        actorUserId: operator.id,
        targetTenantId: target.id,
        targetRole: parsed.data.target_role,
        reason: parsed.data.reason,
        expiresAt,
        consumed: false,
        createdAt: now,
      });
      return {
        workStatements: [insertHandoff],
        result: { handoffId, targetSlug: target.slug },
      };
    },
  );

  // Construct the tenant subdomain handoff URL. The platform host is
  // `platform.fisqua.test` in dev/test and `platform.fisqua.org` in
  // prod; replace the leading `platform` with the target slug. The
  // suffix (`.fisqua.test` / `.fisqua.org`) is preserved so dev and
  // prod produce structurally identical redirects.
  const apexHost = new URL(request.url).hostname;
  const subdomainSuffix = apexHost.replace(/^platform/, "");
  const tenantHost = `${target.slug}${subdomainSuffix}`;
  const proto = new URL(request.url).protocol;
  return redirect(
    `${proto}//${tenantHost}/handoff/impersonation?t=${handoffId}`,
  );
}

// @version v0.4.0
