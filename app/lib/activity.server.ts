/**
 * Activity Feed Server Helpers
 *
 * This module deals with reading rows out of the `activity_log` table
 * for the three surfaces that render an activity feed: the per-user
 * dashboard, the per-volume side panel in the segmentation viewer, and
 * the per-project overview. Each helper is a thin Drizzle select that
 * scopes by the relevant foreign key (`userId`, `volumeId`, or
 * `projectId`), orders by `createdAt` descending so newest events
 * surface first, and caps the result with a caller-supplied `limit`
 * defaulting to fifty rows.
 *
 * Writes to `activity_log` live elsewhere — this module is read-only
 * and exists to keep the SELECT shapes in one testable place so the
 * three feeds stay consistent in ordering and column projection.
 *
 * @version v0.3.0
 */
import { eq, desc } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { activityLog } from "../db/schema";

/**
 * Get recent activity log entries for a user.
 */
export async function getActivityForUser(
  db: DrizzleD1Database<any>,
  userId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.userId, userId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get activity log entries for a specific volume.
 */
export async function getActivityForVolume(
  db: DrizzleD1Database<any>,
  volumeId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.volumeId, volumeId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}

/**
 * Get activity log entries for a project.
 */
export async function getActivityForProject(
  db: DrizzleD1Database<any>,
  projectId: string,
  limit = 50
) {
  return db
    .select()
    .from(activityLog)
    .where(eq(activityLog.projectId, projectId))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit)
    .all();
}
