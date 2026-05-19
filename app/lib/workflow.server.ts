/**
 * Workflow Server — Volume status transitions + activity log
 *
 * This module deals with the server-side workflow helpers for
 * cataloguing. Two responsibilities:
 *
 *   - `transitionVolumeStatus` validates a status change against the
 *     role-aware state machine in `./workflow`, then writes the new
 *     status on the volumes row AND a matching `status_changed` row
 *     in `activity_log`. Both writes must land together — see the
 *     atomicity contract below.
 *   - `logActivity` is the general-purpose append-an-activity-row
 *     helper used by many callers throughout the app for events
 *     that do NOT need to land in lockstep with another write
 *     (login, volume_opened, comment_added, etc.).
 *
 * ## Atomicity contract
 *
 * `transitionVolumeStatus` composes the volumes UPDATE and the
 * activity_log INSERT into a single `db.batch([...])`. D1 batches are
 * SQL transactions — either every statement commits or none of them
 * do (the entire sequence rolls back on any statement's failure).
 * This closes the Apr 24 forensic case in which volume
 * `5636e0b6-1e46-4aa4-975b-7c2f62dd7b3c` ended up with
 * `status=in_progress` AND an `activity_log` row saying it had
 * transitioned `in_progress -> unstarted`: one statement landed and
 * the other did not, leaving silent drift behind.
 *
 * The canonical atomicity precedent lives in
 * `app/lib/audit.server.ts` (the `withAuditLog` wrapper) — see that
 * file's narrative header for the full discussion of D1 batch
 * semantics, FK ordering, and why audit rows go last in operator
 * actions. For volume-status transitions the FK ordering is trivial
 * (the volumes row already exists; the activity_log row's
 * `volume_id` FK resolves immediately), so either statement order
 * works.
 *
 * Drizzle accepts un-awaited query builders inside `db.batch([...])`.
 * The activity-log INSERT is inlined here rather than going through
 * `logActivity` because `logActivity` `await`s its insert, which is
 * incompatible with batch composition. Other callers of `logActivity`
 * (login, volume_opened, comment_*, qc_flag_*, etc.) keep using the
 * un-batched helper — those events do not need to be atomic with any
 * other write.
 *
 * ## Reconciliation
 *
 * Pre-existing drift from before this fix is NOT auto-repaired by
 * this code path. The forensic detector lives in
 * `scripts/reconcile-volume-status.ts` (read-only); the report of the
 * one known case from Apr 24 is held by the maintainer. Repair of
 * that case is a separate operator-gated step outside this code
 * path.
 *
 * @version v0.4.1
 */

import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { volumes, activityLog } from "../db/schema";
import {
  canTransition,
  type VolumeStatus,
  type WorkflowRole,
} from "./workflow";

export type ActivityEvent =
  | "login"
  | "volume_opened"
  | "status_changed"
  | "review_submitted"
  | "assignment_changed"
  | "description_status_changed"
  | "description_assignment_changed"
  | "resegmentation_flagged"
  | "comment_added"
  | "comment_edited"
  | "comment_deleted"
  | "comment_resolved"
  | "comment_unresolved"
  | "comment_region_moved"
  | "qc_flag_raised"
  | "qc_flag_resolved";

/**
 * Transition a volume's status after validating the transition is allowed.
 * Logs the status change as an activity event in the same atomic batch
 * as the status UPDATE (see file narrative header).
 *
 * @throws Response(400) if the transition is not valid for the given role
 * @throws Response(404) if the volume does not exist
 * @throws on D1 batch failure (caller emits 5xx); either both writes
 *   committed or neither did
 */
export async function transitionVolumeStatus(
  db: DrizzleD1Database<any>,
  volumeId: string,
  targetStatus: VolumeStatus,
  userId: string,
  role: WorkflowRole,
  comment?: string
): Promise<void> {
  // Fetch current volume status
  const [volume] = await db
    .select({ status: volumes.status, projectId: volumes.projectId })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .limit(1)
    .all();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  const currentStatus = volume.status as VolumeStatus;

  if (!canTransition(currentStatus, targetStatus, role)) {
    throw new Response(
      `Invalid transition from ${currentStatus} to ${targetStatus} for role ${role}`,
      { status: 400 }
    );
  }

  const now = Date.now();

  // Update volume status and optionally set reviewComment (for sent_back)
  const updateData: Record<string, unknown> = {
    status: targetStatus,
    updatedAt: now,
  };

  if (targetStatus === "sent_back" && comment) {
    updateData.reviewComment = comment;
  } else if (targetStatus !== "sent_back") {
    // Clear reviewComment when moving away from sent_back
    updateData.reviewComment = null;
  }

  // Atomic with activity_log insert; see audit.server.ts for
  // the full atomicity contract. Drizzle accepts un-awaited query
  // builders as batch items; D1 serialises the two statements into
  // one all-or-nothing transaction.
  await db.batch([
    db.update(volumes).set(updateData).where(eq(volumes.id, volumeId)),
    db.insert(activityLog).values({
      id: crypto.randomUUID(),
      userId,
      event: "status_changed",
      projectId: volume.projectId ?? null,
      volumeId,
      detail: JSON.stringify({
        from: currentStatus,
        to: targetStatus,
        comment: comment ?? null,
      }),
      createdAt: now,
    }),
  ]);
}

/**
 * Insert an activity log entry.
 *
 * Used for events that do NOT need to be atomic with another write
 * (login, volume_opened, comment_*, qc_flag_*, assignment_changed,
 * etc.). For status_changed events that must land in lockstep with
 * a volumes UPDATE, see `transitionVolumeStatus` above which composes
 * its own batch directly rather than going through this helper.
 */
export async function logActivity(
  db: DrizzleD1Database<any>,
  userId: string,
  event: ActivityEvent,
  options: {
    projectId?: string;
    volumeId?: string;
    detail?: string;
  } = {}
): Promise<void> {
  await db.insert(activityLog).values({
    id: crypto.randomUUID(),
    userId,
    event,
    projectId: options.projectId ?? null,
    volumeId: options.volumeId ?? null,
    detail: options.detail ?? null,
    createdAt: Date.now(),
  });
}

// @version v0.4.1
