/**
 * Boundary reducer
 *
 * This module deals with every state transition in the segmentation
 * viewer. `boundaryReducer` is the pure reducer that takes a
 * `BoundaryState` and a `BoundaryAction` and returns the new state;
 * `createInitialState` builds the starting snapshot from a list of
 * entries fetched off the server. The reducer is exhaustive over the
 * action union — adding, moving, deleting, indenting, outdenting,
 * renaming and re-typing outline entries; plus the four save-status
 * transitions (`MARK_SAVED`, `MARK_SAVING`, `MARK_DIRTY`,
 * `MARK_ERROR`) that the autosave pipeline drives.
 *
 * Structural edits validate before they mutate. The minimum y-gap
 * (`MIN_Y_GAP`, 2% of page height) keeps two boundaries from landing
 * on top of each other; child entries are kept inside their parent's
 * (page, y) range; the very first top-level entry is protected from
 * deletion. When a validation rejects an edit, the reducer returns
 * the same state reference, which the undoable wrapper reads as a
 * no-op and skips pushing onto the history stack. ID generation for
 * `ADD_BOUNDARY` reads an optional `id` field off the action and
 * falls back to `crypto.randomUUID()` — that seam lets tests pin
 * deterministic IDs.
 *
 * No side effects: this module imports nothing but its own types
 * and does no I/O. It pairs with `boundary-types.ts` (type
 * vocabulary) and `use-undoable-reducer.ts` (history wrapper).
 *
 * @version v0.4.0
 */

import type { Entry, BoundaryAction, BoundaryState } from "./boundary-types";

/** Minimum gap between boundaries on the same page (2% of page height). */
export const MIN_Y_GAP = 0.02;

/**
 * Create the initial boundary state from a list of entries loaded from the server.
 */
export function createInitialState(entries: Entry[]): BoundaryState {
  return {
    entries: [...entries],
    isDirty: false,
    saveStatus: "saved",
    lastError: null,
    version: 0,
  };
}

/**
 * Pure reducer for all boundary/entry state management.
 * No side effects -- ID generation for ADD_BOUNDARY uses the optional `id` field
 * on the action, falling back to crypto.randomUUID().
 */
export function boundaryReducer(
  state: BoundaryState,
  action: BoundaryAction
): BoundaryState {
  switch (action.type) {
    case "INIT": {
      return {
        entries: [...action.entries],
        isDirty: false,
        saveStatus: "saved",
        lastError: null,
        version: state.version,
      };
    }

    case "ADD_BOUNDARY": {
      const startY = action.startY ?? 0;

      // Minimum gap check: reject if any same-page entry is too close
      if (hasTooCloseEntry(state.entries, action.startPage, startY, null)) {
        return state;
      }

      const now = Date.now();
      const newEntry: Entry = {
        id: action.id ?? crypto.randomUUID(),
        volumeId: state.entries[0]?.volumeId ?? "",
        parentId: null,
        position: 0, // will be renumbered
        startPage: action.startPage,
        startY,
        endPage: null,
        endY: null,
        type: null,
        subtype: null,
        title: null,
        modifiedBy: action.modifiedBy ?? null,
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
      };

      const entries = [...state.entries, newEntry];
      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "MOVE_BOUNDARY": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry) return state;

      const newStartPage = action.startPage;
      const newStartY = action.toY ?? 0;

      // Minimum gap check at target position (exclude the entry being moved)
      if (hasTooCloseEntry(state.entries, newStartPage, newStartY, entry.id)) {
        return state;
      }

      // Validate containment for child entries (y-aware)
      if (entry.parentId !== null) {
        const parent = state.entries.find((e) => e.id === entry.parentId);
        if (parent) {
          const parentEnd = getEffectiveEndPage(parent, state.entries);

          // Y-aware containment: child's (page, y) must be >= parent's (page, y)
          if (comparePageY(newStartPage, newStartY, parent.startPage, parent.startY) < 0) {
            return state; // no-op: would move above parent
          }

          // Also check page-level upper bound
          if (newStartPage > parentEnd) {
            return state; // no-op: would violate containment
          }
        }
      }

      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              startPage: newStartPage,
              startY: newStartY,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "DELETE_BOUNDARY": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry) return state;

      // First entry protection: cannot delete the first top-level entry
      if (entry.parentId === null && entry.position === 0) {
        // Check if this is truly the first top-level entry by (startPage, startY)
        const topLevel = state.entries
          .filter((e) => e.parentId === null)
          .sort((a, b) => comparePageY(a.startPage, a.startY, b.startPage, b.startY));
        if (topLevel.length > 0 && topLevel[0].id === entry.id) {
          return state; // no-op
        }
      }

      // Collect all descendants to remove
      const idsToRemove = new Set<string>();
      idsToRemove.add(action.entryId);
      collectDescendants(action.entryId, state.entries, idsToRemove);

      const entries = state.entries.filter((e) => !idsToRemove.has(e.id));

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "INDENT": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry) return state;

      // Find the previous sibling at the same level
      const siblings = state.entries
        .filter((e) => e.parentId === entry.parentId)
        .sort((a, b) => comparePageY(a.startPage, a.startY, b.startPage, b.startY));

      const siblingIndex = siblings.findIndex((s) => s.id === entry.id);
      if (siblingIndex <= 0) return state; // no-op: first sibling

      const previousSibling = siblings[siblingIndex - 1];

      // Indent: set parentId to previous sibling
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              parentId: previousSibling.id,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "OUTDENT": {
      const entry = state.entries.find((e) => e.id === action.entryId);
      if (!entry || entry.parentId === null) return state; // no-op: already top-level

      const parent = state.entries.find((e) => e.id === entry.parentId);
      if (!parent) return state;

      // Promote to parent's level
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              parentId: parent.parentId,
              endPage: null, // clear endPage when becoming top-level
              endY: null, // clear endY when becoming top-level
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        entries: renumberSiblings(entries),
        isDirty: true,
        saveStatus: "unsaved",
        version: state.version + 1,
      };
    }

    case "SET_TYPE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              type: action.entryType,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "SET_SUBTYPE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              subtype: action.subtype,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "SET_TITLE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              title: action.title,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "SET_END_PAGE": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              endPage: action.endPage,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "SET_END_Y": {
      const entries = state.entries.map((e) =>
        e.id === action.entryId
          ? {
              ...e,
              endY: action.endY,
              modifiedBy: action.modifiedBy ?? e.modifiedBy,
              updatedAt: Date.now(),
            }
          : e
      );

      return {
        ...state,
        entries,
        isDirty: true,
        saveStatus: "unsaved",
      };
    }

    case "MARK_SAVED":
      // Successful save clears any stuck error state too.
      return {
        ...state,
        isDirty: false,
        saveStatus: "saved",
        lastError: null,
      };

    case "MARK_SAVING":
      // Starting a fresh attempt clears the prior error message so a
      // stale code does not survive into the next pill render.
      return { ...state, saveStatus: "saving", lastError: null };

    case "MARK_DIRTY":
      return { ...state, isDirty: true, saveStatus: "unsaved" };

    // Bounded-retry exhaustion. Caller still has unflushed work —
    // `isDirty` deliberately stays true — but the pill goes red and
    // surfaces the retry affordance.
    case "MARK_ERROR":
      return {
        ...state,
        saveStatus: "error",
        lastError: action.error,
      };

    default:
      return state;
  }
}

// --- Helper functions ---

/**
 * Compare two (page, y) tuples. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function comparePageY(pageA: number, yA: number, pageB: number, yB: number): number {
  if (pageA !== pageB) return pageA - pageB;
  return yA - yB;
}

/**
 * Check if any entry on the same page is too close to the given y-position.
 * excludeId allows excluding a specific entry (e.g., the one being moved).
 */
function hasTooCloseEntry(
  entries: Entry[],
  page: number,
  y: number,
  excludeId: string | null
): boolean {
  return entries.some(
    (e) =>
      e.id !== excludeId &&
      e.startPage === page &&
      Math.abs(e.startY - y) < MIN_Y_GAP
  );
}

/**
 * Renumber siblings by (startPage, startY) within each parent group.
 * Assigns position values 0, 1, 2... based on sort order.
 */
function renumberSiblings(entries: Entry[]): Entry[] {
  // Group by parentId
  const groups = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(entry);
  }

  // Sort each group by (startPage, startY) and assign positions
  const positionMap = new Map<string, number>();
  for (const children of groups.values()) {
    children.sort((a, b) => comparePageY(a.startPage, a.startY, b.startPage, b.startY));
    children.forEach((child, index) => {
      positionMap.set(child.id, index);
    });
  }

  return entries.map((e) => ({
    ...e,
    position: positionMap.get(e.id) ?? e.position,
  }));
}

/**
 * Recursively collect all descendant IDs of a given entry.
 */
function collectDescendants(
  parentId: string,
  entries: Entry[],
  result: Set<string>
): void {
  const children = entries.filter((e) => e.parentId === parentId);
  for (const child of children) {
    result.add(child.id);
    collectDescendants(child.id, entries, result);
  }
}

/**
 * Get the effective end page for an entry.
 * For entries with an explicit endPage, return that.
 * For top-level entries, the end is the next sibling's startPage - 1.
 */
function getEffectiveEndPage(entry: Entry, entries: Entry[]): number {
  if (entry.endPage !== null) return entry.endPage;

  // Find next sibling
  const siblings = entries
    .filter((e) => e.parentId === entry.parentId && e.id !== entry.id)
    .sort((a, b) => comparePageY(a.startPage, a.startY, b.startPage, b.startY));

  const nextSibling = siblings.find(
    (s) => comparePageY(s.startPage, s.startY, entry.startPage, entry.startY) > 0
  );
  if (nextSibling) return nextSibling.startPage - 1;

  // No next sibling -- return a very large number (effectively end of volume)
  return Number.MAX_SAFE_INTEGER;
}
