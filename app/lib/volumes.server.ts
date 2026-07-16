/**
 * Volume Server Operations
 *
 * This module deals with the create / list / delete lifecycle for
 * volumes plus the volume list shape consumed by the project volumes
 * page, the member dashboard, and the per-project workspace. Volume
 * cards across the platform read from `getProjectVolumes`, which
 * also reports the `openQcFlagCount` per volume so the "N open
 * flags" badge can render without the caller having to fan out a
 * second query.
 *
 * @version v0.4.2
 */
import { eq, and, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  projects,
  volumes,
  volumePages,
  entries,
  comments,
  resegmentationFlags,
  activityLog,
  qcFlags,
} from "../db/schema";
import type { ParsedManifest } from "./iiif.server";

/**
 * Number of page rows per INSERT statement.
 * 9 columns per row * 11 rows = 99 bound params (under D1's 100 limit).
 * Each volume_pages row binds 9 columns — id, tenant_id, volume_id,
 * position, image_url, width, height, label, created_at — and every
 * inserted row must set tenant_id explicitly (the column is NOT NULL with
 * no Drizzle default), so the per-row bind count is fixed at 9.
 */
const PAGE_CHUNK_SIZE = 11;

type Volume = typeof volumes.$inferSelect;

export interface VolumeListItem {
  id: string;
  name: string;
  referenceCode: string;
  pageCount: number;
  status: string;
  assignedTo: string | null;
  assignedReviewer: string | null;
  firstPageImageUrl: string | null;
  openQcFlagCount: number;
}

/**
 * Creates a volume and all its pages from a parsed IIIF manifest.
 * Pages are inserted in chunks to stay within D1's bound parameter limit.
 */
export async function createVolume(
  db: DrizzleD1Database<any>,
  projectId: string,
  manifest: ParsedManifest
): Promise<Volume> {
  const now = Date.now();
  const volumeId = crypto.randomUUID();

  // A volume inherits its tenant from its parent project; the
  // volume_pages rows below inherit the same tenantId from the volume.
  // Resolving it from the project row (rather than taking a session
  // tenant) keeps the volume's tenant equal to its project's by
  // construction -- the invariant the crowdsourcing tree relies on.
  const projectRow = await db
    .select({ tenantId: projects.tenantId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!projectRow) {
    throw new Error(`createVolume: project ${projectId} not found`);
  }
  const tenantId = projectRow.tenantId;

  const volumeRow: typeof volumes.$inferInsert = {
    id: volumeId,
    tenantId,
    projectId,
    name: manifest.name,
    referenceCode: manifest.referenceCode,
    manifestUrl: manifest.manifestUrl,
    pageCount: manifest.pageCount,
    status: "unstarted",
    createdAt: now,
    updatedAt: now,
  };

  // Insert volume row first
  await db.insert(volumes).values(volumeRow);

  // Chunk pages and insert via batch
  if (manifest.pages.length > 0) {
    const chunks: (typeof volumePages.$inferInsert)[][] = [];

    for (let i = 0; i < manifest.pages.length; i += PAGE_CHUNK_SIZE) {
      chunks.push(
        manifest.pages.slice(i, i + PAGE_CHUNK_SIZE).map((page) => ({
          id: crypto.randomUUID(),
          tenantId,
          volumeId,
          position: page.position,
          imageUrl: page.imageUrl,
          width: page.width,
          height: page.height,
          label: page.label,
          createdAt: now,
        }))
      );
    }

    // db.batch sends all statements in a single round-trip
    const statements = chunks.map((chunk) =>
      db.insert(volumePages).values(chunk)
    );

    if (statements.length === 1) {
      await statements[0];
    } else {
      await db.batch(statements as any);
    }
  }

  return {
    id: volumeId,
    tenantId,
    projectId,
    name: manifest.name,
    referenceCode: manifest.referenceCode,
    manifestUrl: manifest.manifestUrl,
    pageCount: manifest.pageCount,
    status: "unstarted",
    assignedTo: null,
    assignedReviewer: null,
    reviewComment: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Returns all volumes for a project with the first page's image URL
 * for use as a thumbnail and the count of open QC flags per volume
 *.
 *
 * Implementation note: the loop over volumes already issues a first-page
 * SELECT per volume, so adding a single sidecar GROUP-BY over `qc_flags`
 * keyed by `volume_id` is cheaper than interleaving another per-volume
 * COUNT. Volumes with zero open flags simply do not appear in the map
 * and resolve to `0`.
 */
export async function getProjectVolumes(
  db: DrizzleD1Database<any>,
  projectId: string
): Promise<VolumeListItem[]> {
  const volumeRows = await db
    .select()
    .from(volumes)
    .where(eq(volumes.projectId, projectId))
    .all();

  const volumeIds = volumeRows.map((v) => v.id);

  // Build a volumeId -> openQcFlagCount map in a single grouped query.
  // `inArray` on an empty list is an error in D1, so guard it.
  const openFlagCountByVolume = new Map<string, number>();
  if (volumeIds.length > 0) {
    const counts = await db
      .select({
        volumeId: qcFlags.volumeId,
        count: sql<number>`COUNT(*)`,
      })
      .from(qcFlags)
      .where(
        and(
          inArray(qcFlags.volumeId, volumeIds),
          eq(qcFlags.status, "open")
        )
      )
      .groupBy(qcFlags.volumeId)
      .all();
    for (const row of counts) {
      openFlagCountByVolume.set(row.volumeId, Number(row.count));
    }
  }

  const result: VolumeListItem[] = [];

  for (const vol of volumeRows) {
    // Get first page for thumbnail
    const firstPage = await db
      .select({ imageUrl: volumePages.imageUrl })
      .from(volumePages)
      .where(
        and(
          eq(volumePages.volumeId, vol.id),
          eq(volumePages.position, 1)
        )
      )
      .get();

    result.push({
      id: vol.id,
      name: vol.name,
      referenceCode: vol.referenceCode,
      pageCount: vol.pageCount,
      status: vol.status,
      assignedTo: vol.assignedTo,
      assignedReviewer: vol.assignedReviewer,
      firstPageImageUrl: firstPage?.imageUrl || null,
      openQcFlagCount: openFlagCountByVolume.get(vol.id) ?? 0,
    });
  }

  return result;
}

/**
 * Deletes a volume. Only volumes with status "unstarted" can be deleted.
 * Cascades through all dependent rows (entries, comments, flags, activity
 * log, volume pages) in case the volume was demoted to "unstarted" after
 * accumulating work.
 */
export async function deleteVolume(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<void> {
  const volume = await db
    .select({ status: volumes.status })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  if (volume.status !== "unstarted") {
    throw new Response(
      "Only volumes with status 'unstarted' can be deleted",
      { status: 400 }
    );
  }

  await forceDeleteVolume(db, volumeId);
}

/**
 * Force-deletes a volume and all dependent rows (pages, entries, comments,
 * flags, activity log rows, description_entities links). Superadmin-only.
 *
 * WARNING: this bypasses the status check and will destroy cataloguing work.
 * Callers must confirm before invoking.
 */
export async function forceDeleteVolume(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<void> {
  const volume = await db
    .select({ id: volumes.id })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    throw new Response("Volume not found", { status: 404 });
  }

  // Collect entry IDs for downstream cascades
  const entryRows = await db
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .all();
  const entryIds = entryRows.map((r) => r.id);

  if (entryIds.length > 0) {
    // D1 limits bound params — chunk in batches of 50
    const CHUNK = 50;
    for (let i = 0; i < entryIds.length; i += CHUNK) {
      const batch = entryIds.slice(i, i + CHUNK);
      await db.delete(comments).where(inArray(comments.entryId, batch));
      await db
        .delete(resegmentationFlags)
        .where(inArray(resegmentationFlags.entryId, batch));
    }
  }

  // Activity log: scope by volume
  await db.delete(activityLog).where(eq(activityLog.volumeId, volumeId));

  // Resegmentation flags scoped by volume (covers any not tied to an entry)
  await db
    .delete(resegmentationFlags)
    .where(eq(resegmentationFlags.volumeId, volumeId));

  // Entries
  await db.delete(entries).where(eq(entries.volumeId, volumeId));

  // Volume pages
  await db.delete(volumePages).where(eq(volumePages.volumeId, volumeId));

  // Finally the volume itself
  await db.delete(volumes).where(eq(volumes.id, volumeId));
}

