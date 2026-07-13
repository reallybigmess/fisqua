/**
 * Boundary state types
 *
 * This module deals with the shared type vocabulary for the
 * segmentation viewer's volume-boundary model. It defines `Entry` —
 * one row in the outline of a volume, with its page-relative
 * coordinates, type, subtype, title, and the description-side fields
 * that fill in once cataloguing starts on the volume; `BoundaryState`,
 * the snapshot the reducer mutates (the list of entries, the
 * `isDirty` flag, a four-state save status, the last error message,
 * and a monotonic version counter); and `BoundaryAction`, the
 * discriminated union of every edit the reducer accepts — structural
 * edits like adding, moving, deleting, nesting and renaming entries,
 * plus non-undoable status transitions like `MARK_SAVING` and
 * `MARK_ERROR` that the autosave pipeline drives.
 *
 * This module sits one layer below `boundary-reducer.ts` (which
 * applies the transitions) and `use-undoable-reducer.ts` (which
 * wraps the reducer with undo/redo history). Every viewer or
 * outline component that reads or writes a boundary edit imports
 * its types from here, so the file is kept free of React imports —
 * the save-status union is re-declared rather than imported from
 * the SaveStatus pill component, so `app/lib/` stays unit-testable
 * without dragging in the component layer.
 *
 * @version v0.4.0
 */

// EntryType is derived from the canonical `ENTRY_TYPES` array
// (app/lib/validation/enums.ts) so the segmentation type vocabulary has
// a single source of truth shared with the Drizzle schema and the save
// validator. Imported locally for use below and re-exported so the many
// modules that import `EntryType` from here keep working.
import type { EntryType } from "./validation/enums";
export type { EntryType };

export type Entry = {
  id: string;
  volumeId: string;
  parentId: string | null;
  position: number; // 0-based sibling order
  startPage: number; // 1-based page number
  startY: number; // 0.0-1.0 fraction of page height (0 = top)
  endPage: number | null; // explicit for children, null for top-level
  endY: number | null; // 0.0-1.0, null for top-level
  type: EntryType | null; // null = unset
  // Per-project document subtype label (e.g. "Escritura", "Poder").
  // Free text so projects can add new subtypes via settings; defaults
  // to `DEFAULT_DOCUMENT_SUBTYPES` when no project-level list is set.
  subtype: string | null;
  title: string | null;
  modifiedBy: string | null; // userId of last modifier, null = original cataloguer
  // Description fields (all nullable -- populated during description workflow)
  translatedTitle: string | null;
  resourceType: string | null;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  extent: string | null;
  scopeContent: string | null;
  language: string | null;
  descriptionNotes: string | null;
  internalNotes: string | null;
  descriptionLevel: string | null;
  descriptionStatus: string | null;
  assignedDescriber: string | null;
  assignedDescriptionReviewer: string | null;
  createdAt: number;
  updatedAt: number;
};

// The segmentation viewer's save-status union matches the shared
// `SaveStatusValue` from `app/components/viewer/save-status.tsx` so
// the reducer can settle to the `error` state once the bounded-retry
// helper exhausts its attempt budget. The type alias is re-declared
// here (rather than imported) to keep `app/lib/` free of React /
// component-layer imports — the component module exports its own
// copy of the same union.
export type BoundaryState = {
  entries: Entry[];
  isDirty: boolean;
  saveStatus: "saved" | "saving" | "unsaved" | "error";
  /**
   * Last error message recorded by `MARK_ERROR`. Populated only when
   * `saveStatus === "error"`; left as `null` otherwise. Used to drive
   * any future surface that wants to show *what* failed (e.g. an HTTP
   * status code); the SaveStatus pill itself only needs the status
   * union member.
   */
  lastError: string | null;
  version: number;
};

export type BoundaryAction =
  | { type: "INIT"; entries: Entry[] }
  | { type: "ADD_BOUNDARY"; startPage: number; startY?: number; id?: string; modifiedBy?: string }
  | { type: "MOVE_BOUNDARY"; entryId: string; startPage: number; toY?: number; modifiedBy?: string }
  | { type: "DELETE_BOUNDARY"; entryId: string; modifiedBy?: string }
  | { type: "INDENT"; entryId: string; modifiedBy?: string }
  | { type: "OUTDENT"; entryId: string; modifiedBy?: string }
  | { type: "SET_TYPE"; entryId: string; entryType: EntryType | null; modifiedBy?: string }
  | { type: "SET_SUBTYPE"; entryId: string; subtype: string | null; modifiedBy?: string }
  | { type: "SET_TITLE"; entryId: string; title: string; modifiedBy?: string }
  | { type: "SET_END_PAGE"; entryId: string; endPage: number; modifiedBy?: string }
  | { type: "SET_END_Y"; entryId: string; endY: number; modifiedBy?: string }
  | { type: "MARK_SAVED" }
  | { type: "MARK_SAVING" }
  | { type: "MARK_DIRTY" }
  // Emitted by `useAutosave` after the bounded-retry helper exhausts
  // its attempt budget. Settles
  // `saveStatus` to `"error"` so the shared SaveStatus pill renders
  // the madder dot + retry affordance. Does NOT touch `isDirty` —
  // the caller still has unflushed work — and is non-undoable.
  | { type: "MARK_ERROR"; error: string };
