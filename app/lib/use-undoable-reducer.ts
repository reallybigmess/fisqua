/**
 * Undoable reducer hook
 *
 * This module deals with undo/redo history for the segmentation
 * viewer. `useUndoableReducer` is the React hook that wraps
 * `boundaryReducer` with past/present/future snapshot stacks, so
 * the `⌘Z` / `⌘⇧Z` shortcuts can rewind and replay edits without
 * the reducer itself needing to know about history.
 * `createUndoableDispatch` is the underlying pure transition
 * function — exported so the hook's behaviour can be unit-tested
 * without rendering React.
 *
 * Three categories of action are handled separately. Structural
 * edits (`ADD_BOUNDARY`, `MOVE_BOUNDARY`, `DELETE_BOUNDARY`,
 * `INDENT`, `OUTDENT`, `SET_TYPE`, `SET_SUBTYPE`, `SET_TITLE`,
 * `SET_END_PAGE`, `SET_END_Y`) push the previous present onto
 * `past`, set the new present, and clear the future. Non-undoable
 * actions (`INIT`, `MARK_SAVED`, `MARK_SAVING`, `MARK_DIRTY`,
 * `MARK_ERROR`) update the present without touching the history —
 * these are UI state transitions and a bulk load, and folding them
 * into the history stack would let the user "undo" a successful
 * save back into a dirty state, or rewind past the initial volume
 * load. No-op actions, where the reducer returns the same state
 * reference because a validation rejected an edit, are dropped
 * entirely. `maxHistory` caps the size of the `past` stack so a
 * long editing session does not grow unbounded; the default is 100
 * snapshots.
 *
 * @version v0.4.0
 */

import { useState, useCallback } from "react";
import type { BoundaryState, BoundaryAction } from "./boundary-types";

/**
 * Actions that should NOT be recorded in undo history. `MARK_ERROR`
 * is included: autosave failure is a UI state transition, not a data
 * edit, so it must not push a snapshot onto the undo stack.
 */
const NON_UNDOABLE = new Set([
  "INIT",
  "MARK_SAVED",
  "MARK_SAVING",
  "MARK_DIRTY",
  "MARK_ERROR",
]);

/** Undo/redo meta-actions. */
export type UndoRedoAction = { type: "UNDO" } | { type: "REDO" };

/** The full history state: past snapshots, current present, and future (redo) snapshots. */
export type HistoryState = {
  past: BoundaryState[];
  present: BoundaryState;
  future: BoundaryState[];
};

/**
 * Pure state transition function for undo/redo history.
 * Exported for testability without React rendering.
 *
 * Returns a function that takes the current history and an action, and returns the new history.
 */
export function createUndoableDispatch(
  reducer: (state: BoundaryState, action: BoundaryAction) => BoundaryState,
  maxHistory: number
) {
  return function undoableTransition(
    history: HistoryState,
    action: BoundaryAction | UndoRedoAction
  ): HistoryState {
    if (action.type === "UNDO") {
      if (history.past.length === 0) return history;
      const previous = history.past[history.past.length - 1];
      return {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      };
    }

    if (action.type === "REDO") {
      if (history.future.length === 0) return history;
      const next = history.future[0];
      return {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
      };
    }

    // Regular boundary action
    const newPresent = reducer(history.present, action as BoundaryAction);

    // No-op detection: if reducer returns same state reference, don't push
    if (newPresent === history.present) return history;

    // Non-undoable actions update present without affecting history
    if (NON_UNDOABLE.has(action.type)) {
      return { ...history, present: newPresent };
    }

    // Undoable action: push current to past, clear future
    const newPast = [...history.past, history.present].slice(-maxHistory);
    return {
      past: newPast,
      present: newPresent,
      future: [],
    };
  };
}

/**
 * React hook that wraps a boundary reducer with undo/redo history.
 *
 * Structural actions (ADD_BOUNDARY, MOVE_BOUNDARY, DELETE_BOUNDARY, INDENT, OUTDENT,
 * SET_TYPE, SET_TITLE, SET_END_PAGE, SET_END_Y) are recorded in history.
 *
 * Non-undoable actions (INIT, MARK_SAVED, MARK_SAVING, MARK_DIRTY,
 * MARK_ERROR) update state without entering history.
 *
 * No-op actions (reducer returns same reference) are ignored entirely.
 */
export function useUndoableReducer(
  reducer: (state: BoundaryState, action: BoundaryAction) => BoundaryState,
  initialState: BoundaryState,
  maxHistory = 100
) {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: initialState,
    future: [],
  });

  const transition = createUndoableDispatch(reducer, maxHistory);

  const dispatch = useCallback(
    (action: BoundaryAction | UndoRedoAction) => {
      setHistory((prev) => transition(prev, action));
    },
    [transition]
  );

  return {
    state: history.present,
    dispatch,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
