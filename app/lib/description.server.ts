/**
 * Description CRUD and Workflow
 *
 * This module deals with every server-side mutation that touches the
 * entry-level description workflow. Saving individual fields from the
 * form, submitting a draft for review, approving or sending back a
 * reviewer's response, reassigning the describer or the reviewer, and
 * promoting a whole volume into the description phase all flow through
 * here so that validation, activity-log writes, and status transitions
 * are consistent across callers. The helpers sit between the route
 * actions (which handle request parsing and permission checks) and the
 * Drizzle queries (which do the actual table writes).
 *
 * Additive-save contract: `saveDescription` writes only the
 * description columns whose keys are present in the incoming `fields`
 * object, and never nulls a column merely because its key was absent.
 * Explicit `null` in the input is still honoured so callers can clear
 * a field on purpose. Combined with the belt-and-braces client fix in
 * `app/routes/_auth.description.$projectId.$entryId.tsx`, this closes
 * the data-loss bug surfaced in the 2026-05-14 UAT session where a
 * single-field autosave was nulling every other description column on
 * the same entry. The regression contract is pinned by
 * `tests/description/autosave.test.ts` ("preserves omitted fields
 * across a partial save").
 *
 * The field registry (`DESCRIPTION_FIELD_KEYS` + `DescriptionFields`)
 * is shared with the client's `buildFieldsPayload` via the pure
 * `description-workflow` module, precisely because the two surfaces
 * once declared it separately and the title field, missing from both,
 * cycled the save-status pill while `entries.title` never changed on
 * disk. Regression tests in `tests/description/autosave.test.ts` pin
 * the behaviour from both angles: title persists, and the additive
 * contract still holds.
 *
 * @version v0.4.1
 */

import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod/v4";
import { entries, volumes, volumePages, comments } from "../db/schema";
import {
  canDescriptionTransition,
  DESCRIPTION_FIELD_KEYS,
  type DescriptionFields,
  type DescriptionStatus,
} from "./description-workflow";
import type { WorkflowRole } from "./workflow";
import { logActivity } from "./workflow.server";
import { createComment } from "./comments.server";
import { RESOURCE_TYPES_ES } from "./validation/enums";

// The field registry (keys + type) lives in the pure, client-safe
// description-workflow module so the route's payload builder and this
// writer share one declaration; re-exported here for server callers.
export { DESCRIPTION_FIELD_KEYS, type DescriptionFields };

// --- Validation schema for submit-for-review ---

const submitSchema = z.object({
  title: z.string().min(1, "Title is required"),
  resourceType: z.enum(RESOURCE_TYPES_ES),
  dateExpression: z.string().min(1, "Date expression is required"),
  scopeContent: z.string().min(1, "Scope and content is required"),
  language: z.string().min(1, "Language is required"),
  extent: z.string().min(1, "Extent is required"),
});

/**
 * Save description fields on an entry (autosave).
 *
 * Additive contract: only keys present in `fields` are written.
 * Absent keys are preserved on disk; an
 * explicit `null` in the payload still clears the column. The
 * `updated_at` timestamp is always bumped when at least one column is
 * being written; an empty payload is a no-op (no UPDATE issued at
 * all) so a stray empty-fields call cannot churn the timestamp.
 *
 * Does NOT change description status.
 */
export async function saveDescription(
  db: DrizzleD1Database<any>,
  entryId: string,
  fields: DescriptionFields
): Promise<void> {
  // Build the SET payload from only the keys actually present in the
  // input. `key in fields` distinguishes "absent" from "explicitly
  // undefined" / "explicitly null"; absent keys are skipped, while
  // both explicit null and explicit value pass through unchanged.
  const updateValues: Record<string, unknown> = {};
  for (const key of DESCRIPTION_FIELD_KEYS) {
    if (key in fields) {
      updateValues[key] = fields[key];
    }
  }

  // Empty payload — nothing to write. Skip the UPDATE entirely so
  // callers cannot accidentally bump `updated_at` with a no-op save.
  if (Object.keys(updateValues).length === 0) {
    return;
  }

  updateValues.updatedAt = Date.now();

  await db
    .update(entries)
    .set(updateValues)
    .where(eq(entries.id, entryId));
}

export type ValidationError = {
  field: string;
  message: string;
};

/**
 * Validate required fields and submit entry for review.
 * Transitions status to "described" if validation passes.
 * Returns validation errors if required fields are missing.
 */
export async function submitForReview(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  role: WorkflowRole
): Promise<{ ok: true } | { ok: false; validationErrors: ValidationError[] }> {
  // Load current entry
  const [entry] = await db
    .select({
      title: entries.title,
      translatedTitle: entries.translatedTitle,
      resourceType: entries.resourceType,
      dateExpression: entries.dateExpression,
      scopeContent: entries.scopeContent,
      language: entries.language,
      extent: entries.extent,
      descriptionStatus: entries.descriptionStatus,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  // Validate required fields -- use title (original) or translatedTitle
  const titleValue = entry.title || entry.translatedTitle;

  const result = submitSchema.safeParse({
    title: titleValue,
    resourceType: entry.resourceType,
    dateExpression: entry.dateExpression,
    scopeContent: entry.scopeContent,
    language: entry.language,
    extent: entry.extent,
  });

  if (!result.success) {
    const validationErrors: ValidationError[] = result.error.issues.map(
      (issue) => ({
        field: String(issue.path[0]),
        message: issue.message,
      })
    );
    return { ok: false, validationErrors };
  }

  // Check transition is valid
  const currentStatus = entry.descriptionStatus as DescriptionStatus;
  if (!canDescriptionTransition(currentStatus, "described", role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to described for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: "described", updatedAt: now })
    .where(eq(entries.id, entryId));

  return { ok: true };
}

/**
 * Approve a description entry.
 * Reviewer: described -> reviewed. Lead: reviewed -> approved (or any valid transition).
 */
export async function approveDescription(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  role: WorkflowRole
): Promise<void> {
  const [entry] = await db
    .select({
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const currentStatus = entry.descriptionStatus as DescriptionStatus;

  // Determine target: reviewer approves to "reviewed", lead approves to "approved"
  let targetStatus: DescriptionStatus;
  if (role === "reviewer") {
    targetStatus = "reviewed";
  } else if (role === "lead" && currentStatus === "reviewed") {
    targetStatus = "approved";
  } else if (role === "lead") {
    targetStatus = "reviewed";
  } else {
    throw new Response("Insufficient role for approval", { status: 403 });
  }

  if (!canDescriptionTransition(currentStatus, targetStatus, role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to ${targetStatus} for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: targetStatus, updatedAt: now })
    .where(eq(entries.id, entryId));

  // Find project for activity log
  const [vol] = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (vol) {
    await logActivity(db, userId, "description_status_changed", {
      projectId: vol.projectId,
      volumeId: entry.volumeId,
      detail: JSON.stringify({
        entryId,
        from: currentStatus,
        to: targetStatus,
      }),
    });
  }
}

/**
 * Send back a description entry with reviewer feedback.
 * Creates a comment with the feedback text.
 */
export async function sendBackDescription(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string,
  role: WorkflowRole,
  commentText: string
): Promise<void> {
  const [entry] = await db
    .select({
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const currentStatus = entry.descriptionStatus as DescriptionStatus;

  if (!canDescriptionTransition(currentStatus, "sent_back", role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to sent_back for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: "sent_back", updatedAt: now })
    .where(eq(entries.id, entryId));

  // Create a comment with the feedback
  await createComment(db, {
    target: { kind: "entry", entryId },
    volumeId: entry.volumeId,
    parentId: null,
    authorId: userId,
    authorRole: role,
    text: commentText,
  });

  // Log activity
  const [vol] = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (vol) {
    await logActivity(db, userId, "description_status_changed", {
      projectId: vol.projectId,
      volumeId: entry.volumeId,
      detail: JSON.stringify({
        entryId,
        from: currentStatus,
        to: "sent_back",
      }),
    });
  }
}

/**
 * Load an entry with all description fields, its volume info, and ordered pages.
 */
export async function loadDescriptionEntry(
  db: DrizzleD1Database<any>,
  entryId: string
) {
  const [entry] = await db
    .select()
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const [volume] = await db
    .select()
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  const pages = await db
    .select()
    .from(volumePages)
    .where(eq(volumePages.volumeId, entry.volumeId))
    .orderBy(volumePages.position)
    .all();

  return { entry, volume, pages };
}

/**
 * Load all entries for a volume with their description status,
 * for the entry navigation in the description editor.
 */
export async function loadVolumeEntriesForDescription(
  db: DrizzleD1Database<any>,
  volumeId: string
) {
  return db
    .select({
      id: entries.id,
      position: entries.position,
      startPage: entries.startPage,
      title: entries.title,
      translatedTitle: entries.translatedTitle,
      descriptionStatus: entries.descriptionStatus,
      assignedDescriber: entries.assignedDescriber,
      assignedDescriptionReviewer: entries.assignedDescriptionReviewer,
    })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .orderBy(entries.position)
    .all();
}

/**
 * Assign a describer to an entry.
 * Transitions to "assigned" if currently "unassigned".
 */
export async function assignDescriber(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string
): Promise<void> {
  const [entry] = await db
    .select({
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    .limit(1)
    .all();

  if (!entry) {
    throw new Response("Entry not found", { status: 404 });
  }

  const now = Date.now();
  const updateData: Record<string, unknown> = {
    assignedDescriber: userId,
    updatedAt: now,
  };

  if (entry.descriptionStatus === "unassigned") {
    updateData.descriptionStatus = "assigned";
  }

  await db.update(entries).set(updateData).where(eq(entries.id, entryId));

  // Log activity
  const [vol] = await db
    .select({ projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, entry.volumeId))
    .limit(1)
    .all();

  if (vol) {
    await logActivity(db, userId, "description_assignment_changed", {
      projectId: vol.projectId,
      volumeId: entry.volumeId,
      detail: JSON.stringify({ entryId, assignedDescriber: userId }),
    });
  }
}

/**
 * Assign a description reviewer to an entry.
 */
export async function assignDescriptionReviewer(
  db: DrizzleD1Database<any>,
  entryId: string,
  userId: string
): Promise<void> {
  const now = Date.now();

  await db
    .update(entries)
    .set({ assignedDescriptionReviewer: userId, updatedAt: now })
    .where(eq(entries.id, entryId));
}

/**
 * Promote all entries in a volume to description phase.
 * Sets descriptionStatus to "unassigned" for all entries.
 * Only works if volume status is "approved".
 */
export async function promoteVolumeToDescription(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<void> {
  const [volume] = await db
    .select({ status: volumes.status })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  if (volume.status !== "approved") {
    throw new Response(
      "Volume must be approved before promoting to description",
      { status: 400 }
    );
  }

  const now = Date.now();
  await db
    .update(entries)
    .set({ descriptionStatus: "unassigned", updatedAt: now })
    .where(eq(entries.volumeId, volumeId));
}

/**
 * Get description progress for a volume.
 * Returns count of entries per description status for progress bar.
 */
export async function getVolumeDescriptionProgress(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      status: entries.descriptionStatus,
      count: sql<number>`count(*)`,
    })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .groupBy(entries.descriptionStatus)
    .all();

  const progress: Record<string, number> = {};
  for (const row of rows) {
    const status = row.status ?? "unassigned";
    progress[status] = row.count;
  }
  return progress;
}
