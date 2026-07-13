/**
 * Volume Entries Server Helpers
 *
 * This module deals with the read and write side of the `entries`
 * table — the per-volume list of segmentation entries that the
 * segmentation viewer paints over the IIIF canvas. `loadEntries`
 * returns every entry for a volume in `position` order, falling back
 * to a synthetic auto-entry pinned to page one when the volume has
 * never been segmented; that fallback matches the initial-state
 * contract documented in `CONTEXT.md` so the viewer always has a
 * starting boundary to render.
 *
 * `saveEntries` implements the additive-diff save the viewer drives
 * on autosave. It loads the existing ids, partitions the incoming
 * payload into UPDATE / INSERT / DELETE buckets, only touches the
 * segmentation-relevant columns on UPDATE so description data written
 * separately is preserved, and chunks the resulting statement list
 * into batches of 89 to stay under D1's 100-statement batch ceiling.
 * `validateEntries` enforces the per-entry invariants (non-empty id,
 * matching `volumeId`, `position >= 0`, `startPage >= 1`, `startY` /
 * `endY` in `[0, 1]`, type from the closed enum) before any SQL runs,
 * so a malformed payload fails fast with a useful message rather than
 * surfacing as a CHECK violation deep in the batch.
 *
 * @version v0.4.2
 */
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { entries, volumes } from "../db/schema";
import type { Entry } from "./boundary-types";
import { ENTRY_TYPES } from "./validation/enums";

/**
 * Load all entries for a volume, ordered by position.
 * If no entries exist, returns a single auto-entry at page 1
 * (initial state per CONTEXT.md -- auto-boundary on page 1, type unset).
 */
export async function loadEntries(
  db: DrizzleD1Database<any>,
  volumeId: string
): Promise<Entry[]> {
  const rows = await db
    .select()
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .orderBy(entries.position)
    .all();

  if (rows.length > 0) {
    return rows.map(rowToEntry);
  }

  // No entries -- return default auto-entry at page 1
  const now = Date.now();
  return [
    {
      id: crypto.randomUUID(),
      volumeId,
      parentId: null,
      position: 0,
      startPage: 1,
      startY: 0,
      endPage: null,
      endY: null,
      type: null,
      subtype: null,
      title: null,
      modifiedBy: null,
      translatedTitle: null,
      resourceType: null,
      dateExpression: null,
      dateStart: null,
      dateEnd: null,
      extent: null,
      scopeContent: null,
      language: null,
      descriptionNotes: null,
      internalNotes: null,
      descriptionLevel: null,
      descriptionStatus: null,
      assignedDescriber: null,
      assignedDescriptionReviewer: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

/**
 * Diff-based save for entries in a volume.
 *
 * Strategy: load existing entry IDs, partition incoming entries into
 * update (ID exists), insert (new ID), delete (ID missing from incoming).
 * UPDATE only touches segmentation-relevant fields, preserving description
 * data that may have been written separately.
 *
 * Chunks all statements into batches of 89 to respect the D1 batch limit.
 */
export async function saveEntries(
  db: DrizzleD1Database<any>,
  volumeId: string,
  entriesToSave: Entry[]
): Promise<void> {
  // Validate entries shape
  validateEntries(entriesToSave, volumeId);

  const now = Date.now();

  // An entry inherits its tenant from its parent volume. Resolve it once
  // so every inserted row carries tenant_id explicitly (the schema has no
  // default). Every entry in the payload shares this volumeId
  // (validateEntries enforces it), so one lookup suffices.
  const volumeRow = await db
    .select({ tenantId: volumes.tenantId })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();
  if (!volumeRow) {
    throw new Error(`saveEntries: volume ${volumeId} not found`);
  }
  const tenantId = volumeRow.tenantId;

  // 1. Load existing entry IDs for this volume
  const existingRows = await db
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.volumeId, volumeId))
    .all();
  const existingIds = new Set(existingRows.map((r) => r.id));

  // 2. Partition incoming entries
  const incomingIds = new Set(entriesToSave.map((e) => e.id));

  const toUpdate: Entry[] = [];
  const toInsert: Entry[] = [];
  for (const e of entriesToSave) {
    if (existingIds.has(e.id)) {
      toUpdate.push(e);
    } else {
      toInsert.push(e);
    }
  }

  const toDeleteIds = [...existingIds].filter((id) => !incomingIds.has(id));

  // 3. Build all statements
  const stmts: any[] = [];

  // DELETE statements for removed entries
  for (const id of toDeleteIds) {
    stmts.push(db.delete(entries).where(eq(entries.id, id)));
  }

  // UPDATE statements -- only segmentation-relevant fields
  for (const e of toUpdate) {
    stmts.push(
      db
        .update(entries)
        .set({
          parentId: e.parentId,
          position: e.position,
          startPage: e.startPage,
          startY: e.startY,
          endPage: e.endPage,
          endY: e.endY,
          type: e.type,
          modifiedBy: e.modifiedBy,
          updatedAt: now,
        })
        .where(eq(entries.id, e.id))
    );
  }

  // INSERT statements for new entries (carries all fields including description)
  for (const e of toInsert) {
    stmts.push(
      db.insert(entries).values({
        id: e.id,
        tenantId,
        volumeId,
        parentId: e.parentId,
        position: e.position,
        startPage: e.startPage,
        startY: e.startY,
        endPage: e.endPage,
        endY: e.endY,
        type: e.type,
        title: e.title,
        modifiedBy: e.modifiedBy,
        translatedTitle: e.translatedTitle,
        resourceType: e.resourceType as typeof entries.$inferInsert.resourceType,
        dateExpression: e.dateExpression,
        dateStart: e.dateStart,
        dateEnd: e.dateEnd,
        extent: e.extent,
        scopeContent: e.scopeContent,
        language: e.language,
        descriptionNotes: e.descriptionNotes,
        internalNotes: e.internalNotes,
        descriptionLevel: e.descriptionLevel,
        descriptionStatus: e.descriptionStatus as typeof entries.$inferInsert.descriptionStatus,
        assignedDescriber: e.assignedDescriber,
        assignedDescriptionReviewer: e.assignedDescriptionReviewer,
        createdAt: e.createdAt,
        updatedAt: now,
      })
    );
  }

  // 4. Handle empty case -- delete all for volume
  if (entriesToSave.length === 0 && existingIds.size > 0) {
    stmts.push(db.delete(entries).where(eq(entries.volumeId, volumeId)));
  }

  // 5. Nothing to do
  if (stmts.length === 0) return;

  // 6. Chunk and execute batches (D1 limit ~100 statements)
  const CHUNK_SIZE = 89;

  for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
    const chunk = stmts.slice(i, i + CHUNK_SIZE);
    await db.batch(chunk as any);
  }
}

/**
 * Validate that the entries array has the expected shape.
 * Throws if validation fails.
 */
function validateEntries(entriesToSave: Entry[], volumeId: string): void {
  if (!Array.isArray(entriesToSave)) {
    throw new Error("entries must be an array");
  }

  for (const entry of entriesToSave) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error("each entry must have a non-empty string id");
    }
    if (entry.volumeId !== volumeId) {
      throw new Error("entry volumeId must match the target volumeId");
    }
    if (typeof entry.position !== "number" || entry.position < 0) {
      throw new Error("each entry must have a non-negative position");
    }
    if (typeof entry.startPage !== "number" || entry.startPage < 1) {
      throw new Error("each entry must have a positive startPage");
    }
    if (typeof entry.startY !== "number" || entry.startY < 0 || entry.startY > 1) {
      throw new Error("each entry must have a startY between 0 and 1");
    }
    if (entry.endY !== null && entry.endY !== undefined) {
      if (typeof entry.endY !== "number" || entry.endY < 0 || entry.endY > 1) {
        throw new Error("endY must be a number between 0 and 1, or null");
      }
    }
    if (entry.type !== null && !(ENTRY_TYPES as readonly string[]).includes(entry.type)) {
      throw new Error(`invalid entry type: ${entry.type}`);
    }
  }
}

/**
 * Convert a DB row to an Entry object.
 */
function rowToEntry(row: typeof entries.$inferSelect): Entry {
  return {
    id: row.id,
    volumeId: row.volumeId,
    parentId: row.parentId,
    position: row.position,
    startPage: row.startPage,
    startY: row.startY,
    endPage: row.endPage,
    endY: row.endY,
    type: row.type,
    subtype: row.subtype,
    title: row.title,
    modifiedBy: row.modifiedBy,
    translatedTitle: row.translatedTitle,
    resourceType: row.resourceType,
    dateExpression: row.dateExpression,
    dateStart: row.dateStart,
    dateEnd: row.dateEnd,
    extent: row.extent,
    scopeContent: row.scopeContent,
    language: row.language,
    descriptionNotes: row.descriptionNotes,
    internalNotes: row.internalNotes,
    descriptionLevel: row.descriptionLevel,
    descriptionStatus: row.descriptionStatus,
    assignedDescriber: row.assignedDescriber,
    assignedDescriptionReviewer: row.assignedDescriptionReviewer,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
