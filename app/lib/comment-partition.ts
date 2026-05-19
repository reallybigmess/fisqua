/**
 * Comment Partition
 *
 * This module deals with the pure helpers that split an array of
 * comments into the buckets the viewer and outline render: by page,
 * by entry, by QC flag, and by anchored region. Keeping the
 * partitioning logic in one testable place means the server and
 * client agree on how each comment is surfaced.
 *
 * @version v0.3.0
 */
import type { Entry } from "./boundary-types";
import { findCurrentEntry } from "./entry-ownership";

/**
 * The subset of a raw comments row this module needs. Matching the
 * loader's Drizzle select shape would couple this helper to the schema —
 * keep it narrow so tests can construct fixtures without importing
 * schema.ts.
 */
export interface PartitionInputComment {
  id: string;
  entryId: string | null;
  pageId: string | null;
  qcFlagId: string | null;
  regionX: number | null;
  regionY: number | null;
  regionW: number | null;
  regionH: number | null;
  /** Author id threaded through regionsByPage for task 15 per-pin
 *  move-mode gating (non-authors can't drag someone else's pin). */
  authorId: string;
  // Other fields pass through unchanged; the helper is generic over extras.
  [key: string]: unknown;
}

export interface PartitionInputPage {
  id: string;
  position: number;
}

export interface PartitionResult<C extends PartitionInputComment> {
  commentsByEntry: Record<string, C[]>;
  commentsByPage: Record<string, C[]>;
  commentsByQcFlag: Record<string, C[]>;
  regionsByPage: Record<
 string,
 Array<{
 commentId: string;
 x: number;
 y: number;
 w: number;
 h: number;
 authorId: string;
 }>
  >;
  commentCountByEntry_attached: Record<string, number>;
  commentCountByEntry_anchored: Record<string, number>;
}

/**
 * Partition a volume's raw comments into the viewer / outline shape.
 * Pure: no IO, no global state, no framework dependencies. Safe to call
 * from loader code and from tests.
 */
export function partitionComments<C extends PartitionInputComment>(
  rawComments: C[],
  pages: PartitionInputPage[],
  entries: Entry[],
): PartitionResult<C> {
  const commentsByEntry: Record<string, C[]> = {};
  const commentsByPage: Record<string, C[]> = {};
  const commentsByQcFlag: Record<string, C[]> = {};
  const regionsByPage: Record<
 string,
 Array<{
 commentId: string;
 x: number;
 y: number;
 w: number;
 h: number;
 authorId: string;
 }>
  > = {};
  const commentCountByEntry_attached: Record<string, number> = {};
  const commentCountByEntry_anchored: Record<string, number> = {};

  const pageIdToPosition: Record<string, number> = {};
  for (const p of pages) pageIdToPosition[p.id] = p.position;
  const totalPages = pages.length;

  for (const c of rawComments) {
 const hasRegion = c.regionX !== null && c.regionY !== null;

 if (c.entryId) {
 (commentsByEntry[c.entryId] ??= []).push(c);
 const bucket = hasRegion
 ? commentCountByEntry_anchored
 : commentCountByEntry_attached;
 bucket[c.entryId] = (bucket[c.entryId] ?? 0) + 1;
 } else if (c.qcFlagId) {
 (commentsByQcFlag[c.qcFlagId] ??= []).push(c);
 } else if (c.pageId) {
 (commentsByPage[c.pageId] ??= []).push(c);
 // Page-anchored comments with a region re-resolve to
 // their owning entry so the outline renders them under the
 // correct entry. Skip silently when no entry covers the point
 // (volume-edge case) — the legacy page bucket still holds the row.
 if (hasRegion) {
 const pagePosition = pageIdToPosition[c.pageId];
 if (pagePosition !== undefined) {
 const owningEntryId = findCurrentEntry(
 entries,
 pagePosition + 1,
 c.regionY!,
 totalPages,
 );
 if (owningEntryId) {
 (commentsByEntry[owningEntryId] ??= []).push(c);
 commentCountByEntry_anchored[owningEntryId] =
 (commentCountByEntry_anchored[owningEntryId] ?? 0) + 1;
 }
 }
 }
 }

 // regionsByPage keys by pageId for any row with region coordinates.
 // Entry-anchored + region rows don't exist in the current data model
 // (the three-way XOR CHECK rejects entry_id + page_id together, and
 // createComment only sets region on the page arm) but the predicate
 // is defensive in case a future `entry-region` arm lands.
 if (c.pageId && hasRegion) {
 (regionsByPage[c.pageId] ??= []).push({
 commentId: c.id,
 x: c.regionX!,
 y: c.regionY!,
 w: c.regionW ?? 0,
 h: c.regionH ?? 0,
 authorId: c.authorId,
 });
 }
  }

  return {
 commentsByEntry,
 commentsByPage,
 commentsByQcFlag,
 regionsByPage,
 commentCountByEntry_attached,
 commentCountByEntry_anchored,
  };
}

