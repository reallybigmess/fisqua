/**
 * Drafts Server Helpers
 *
 * This module deals with the autosave side of the description, entity,
 * place, and repository admin pages. Every record type stores its
 * in-progress form state as a JSON blob in the `drafts` table so a
 * cataloguer's unsaved edits survive a page reload, a session timeout,
 * or a switch to another machine. The helpers upsert drafts keyed to
 * `(tenant_id, record_id, record_type)`, fetch a user's own draft on
 * page load, and surface draft-conflict state when a different user
 * already has an open draft on the same record. On explicit commit the
 * caller clears the draft through `deleteDraft`.
 *
 * Every helper takes the request-boundary session tenant
 * (`context.get(tenantContext).id`) and carries it as a predicate. The
 * draft's tenant cannot be inherited from the record: descriptions and
 * repositories are tenant-scoped but entities and places are
 * federation-SHARED (migrations 0045-0048), so two tenants of one
 * federation may legitimately hold independent drafts on the SAME
 * (record_id, record_type) -- the uniqueness domain is the tenant
 * (migration 0050), and an unscoped lookup, conflict check, or delete
 * would read, report, or destroy another tenant's in-progress edits.
 *
 * @version v0.4.2
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq, and, ne } from "drizzle-orm";
import { drafts } from "../db/schema";

/**
 * Save (or upsert) a draft snapshot for a record.
 * Uses the UNIQUE index on (tenant_id, record_id, record_type) — one
 * draft per record PER TENANT (migration 0050; see the module header
 * for why the uniqueness domain is the tenant).
 */
export async function saveDraft(
  db: DrizzleD1Database,
  tenantId: string,
  recordId: string,
  recordType: string,
  userId: string,
  snapshot: string
): Promise<void> {
  const existing = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.tenantId, tenantId),
        eq(drafts.recordId, recordId),
        eq(drafts.recordType, recordType),
      ),
    )
    .get();

  if (existing) {
    await db
      .update(drafts)
      .set({ snapshot, userId, updatedAt: Date.now() })
      .where(and(eq(drafts.tenantId, tenantId), eq(drafts.id, existing.id)));
  } else {
    await db.insert(drafts).values({
      id: crypto.randomUUID(),
      tenantId,
      recordId,
      recordType,
      userId,
      snapshot,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Retrieve the calling tenant's current draft for a record, or null if
 * none exists. Another tenant's draft on the same shared record is
 * invisible here.
 */
export async function getDraft(
  db: DrizzleD1Database,
  tenantId: string,
  recordId: string,
  recordType: string
): Promise<{
  id: string;
  userId: string;
  snapshot: string;
  updatedAt: number;
} | null> {
  return (
    (await db
      .select({
        id: drafts.id,
        userId: drafts.userId,
        snapshot: drafts.snapshot,
        updatedAt: drafts.updatedAt,
      })
      .from(drafts)
      .where(
        and(
          eq(drafts.tenantId, tenantId),
          eq(drafts.recordId, recordId),
          eq(drafts.recordType, recordType),
        ),
      )
      .get()) ?? null
  );
}

/**
 * Check if another user IN THE SAME TENANT has an active draft on the
 * record. Returns null if no conflict (no draft, or only the current
 * user's draft). Cross-tenant drafts on a shared record are not
 * conflicts -- each tenant edits its own snapshot.
 */
export async function getConflictDraft(
  db: DrizzleD1Database,
  tenantId: string,
  recordId: string,
  recordType: string,
  currentUserId: string
): Promise<{ userId: string; updatedAt: number } | null> {
  return (
    (await db
      .select({ userId: drafts.userId, updatedAt: drafts.updatedAt })
      .from(drafts)
      .where(
        and(
          eq(drafts.tenantId, tenantId),
          eq(drafts.recordId, recordId),
          eq(drafts.recordType, recordType),
          ne(drafts.userId, currentUserId)
        )
      )
      .get()) ?? null
  );
}

/**
 * Delete the calling tenant's draft for a record (after successful
 * explicit save). Another tenant's draft on the same shared record is
 * untouched.
 */
export async function deleteDraft(
  db: DrizzleD1Database,
  tenantId: string,
  recordId: string,
  recordType: string
): Promise<void> {
  await db
    .delete(drafts)
    .where(
      and(
        eq(drafts.tenantId, tenantId),
        eq(drafts.recordId, recordId),
        eq(drafts.recordType, recordType),
      ),
    );
}
