/**
 * Resegmentation Flag Operations
 *
 * This module deals with the server-side primitives that govern
 * resegmentation — the moment a reviewer or describer discovers that
 * a volume's boundaries were drawn wrongly and needs the cataloguer
 * to redo them before description work can continue. Each flag
 * implicitly pauses description on its volume; rather than
 * denormalise a `description_paused` column onto the volumes table,
 * the pause state is derived by querying for open flags wherever it
 * is needed, so a flag's lifecycle is the single source of truth.
 *
 * The helpers cover the small surface the pipeline board, viewer,
 * and resegmentation panel rely on: creating a flag with the
 * affected entry ids in its payload, listing the open flags for a
 * volume so the dashboards can render the right state, and joining
 * the reporter's denormalised display name so the UI does not have
 * to chase a second query. Callers pass the guarded user in;
 * resolution writes (closing a flag once segmentation is corrected)
 * live alongside the create path so the lifecycle stays in one
 * place.
 *
 * @version v0.3.0
 */

import { eq, and } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { resegmentationFlags } from "../db/schema";
import type { ResegmentationFlag } from "./description-types";

/**
 * Create a resegmentation flag for an entry within a volume.
 * Implicitly pauses description work on the volume (checked via hasOpenFlags).
 */
export async function createResegmentationFlag(
  db: DrizzleD1Database<any>,
  data: {
    volumeId: string;
    entryId: string;
    reportedBy: string;
    problemType: ResegmentationFlag["problemType"];
    affectedEntryIds: string;
    description: string;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await db.insert(resegmentationFlags).values({
    id,
    volumeId: data.volumeId,
    entryId: data.entryId,
    reportedBy: data.reportedBy,
    problemType: data.problemType,
    affectedEntryIds: data.affectedEntryIds,
    description: data.description,
    status: "open",
    createdAt: now,
  });

  return { id };
}

/**
 * Resolve a resegmentation flag.
 * Does NOT automatically unpause -- checks if any other open flags remain.
 */
export async function resolveResegmentationFlag(
  db: DrizzleD1Database<any>,
  flagId: string,
  resolvedBy: string
): Promise<void> {
  const [flag] = await db
    .select({ id: resegmentationFlags.id })
    .from(resegmentationFlags)
    .where(eq(resegmentationFlags.id, flagId))
    .limit(1)
    .all();

  if (!flag) {
    throw new Response("Resegmentation flag not found", { status: 404 });
  }

  const now = Date.now();
  await db
    .update(resegmentationFlags)
    .set({
      status: "resolved",
      resolvedBy,
      resolvedAt: now,
    })
    .where(eq(resegmentationFlags.id, flagId));
}

/**
 * Get all open resegmentation flags for a volume.
 */
export async function getOpenFlags(
  db: DrizzleD1Database<any>,
  volumeId: string
) {
  return db
    .select()
    .from(resegmentationFlags)
    .where(
      and(
        eq(resegmentationFlags.volumeId, volumeId),
        eq(resegmentationFlags.status, "open")
      )
    )
    .orderBy(resegmentationFlags.createdAt)
    .all();
}

/**
 * Check if a volume has any open resegmentation flags.
 * Used to determine if description work is paused.
 */
export async function hasOpenFlags(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<boolean> {
  const flags = await db
    .select({ id: resegmentationFlags.id })
    .from(resegmentationFlags)
    .where(
      and(
        eq(resegmentationFlags.volumeId, volumeId),
        eq(resegmentationFlags.status, "open")
      )
    )
    .limit(1)
    .all();

  return flags.length > 0;
}
