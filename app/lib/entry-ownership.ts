/**
 * Entry Ownership Helpers
 *
 * This module deals with the pure utilities for deciding who "owns" a
 * volume entry at any given time — the current describer, the
 * reviewer, or the lead — based on the workflow status. The outline,
 * the viewer, and the comments API all consult these helpers to route
 * mutations to the right actor.
 *
 * @version v0.3.0
 */
import type { Entry } from "./boundary-types";

/**
 * Lexicographic ordering on (page, y). Negative if A < B, positive if A > B,
 * zero if equal. Page has higher precedence; within the same page the
 * y-fraction breaks the tie. Private helper -- not exported because the
 * call site for it is the walk below.
 */
function comparePageY(
  page1: number,
  y1: number,
  page2: number,
  y2: number,
): number {
  if (page1 !== page2) return page1 - page2;
  return y1 - y2;
}

/**
 * Return the id of the deepest entry whose span contains the query point,
 * or `null` when no entry covers it (including the empty-outline case).
 *
 * Called with 1-based `pageNumber` to match the existing outline-panel
 * convention; `yFraction` is the [0, 1] fraction of page height with 0 at
 * the top.
 */
export function findCurrentEntry(
  entries: Entry[],
  pageNumber: number,
  yFraction: number,
  totalPages: number,
): string | null {
  if (entries.length === 0) return null;

  // Group by parentId so we can walk sibling chains in position order.
  const childrenByParent = new Map<string | null, Entry[]>();
  for (const entry of entries) {
 const key = entry.parentId;
 if (!childrenByParent.has(key)) childrenByParent.set(key, []);
 childrenByParent.get(key)!.push(entry);
  }
  for (const children of childrenByParent.values()) {
 children.sort((a, b) => a.position - b.position);
  }

  function findInGroup(parentId: string | null): string | null {
 const siblings = childrenByParent.get(parentId);
 if (!siblings) return null;

 for (let i = 0; i < siblings.length; i++) {
 const entry = siblings[i];
 const startPage = entry.startPage;
 const startY = entry.startY;

 // Determine the end position for this entry.
 let endPage: number;
 let endY: number;
 if (entry.endPage != null) {
 endPage = entry.endPage;
 endY = entry.endY ?? 1;
 } else if (i + 1 < siblings.length) {
 // Extends to just before the next sibling.
 endPage = siblings[i + 1].startPage;
 endY = siblings[i + 1].startY;
 } else {
 // Last sibling: extends to end of volume.
 endPage = totalPages;
 endY = 1;
 }

 // Inclusive start, exclusive end -- earlier-sibling-wins is a
 // consequence of this plus the position-sorted loop order.
 const afterStart =
 comparePageY(pageNumber, yFraction, startPage, startY) >= 0;
 const beforeEnd =
 comparePageY(pageNumber, yFraction, endPage, endY) < 0;

 if (afterStart && beforeEnd) {
 // Descend -- a child whose range is contained inside this entry's
 // range should win over the parent (deepest match).
 const childMatch = findInGroup(entry.id);
 return childMatch || entry.id;
 }
 }
 return null;
  }

  return findInGroup(null);
}

