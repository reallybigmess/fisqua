/**
 * Segmentation Viewer Autosave Hook
 *
 * This hook debounces the segmentation viewer's boundary-state
 * changes and persists them to D1 via `/api/entries/save`. One of
 * two autosave
 * paths in the editor codebase (the description editor has its own
 * inlined autosave inside the `_auth.description.$projectId.$entryId`
 * route); both compose against the same shared retry primitive in
 * `app/lib/autosave-retry.ts` so the retry+settle contract cannot
 * drift between them.
 *
 * Flow:
 *   1. Boundary action arrives via the reducer. `state.isDirty` flips
 *      true and `state.version` bumps.
 *   2. Effect debounces 1.5 s before calling the helper.
 *   3. Helper makes up to 3 attempts with 1 s / 2 s exponential
 *      backoff. Each attempt is a raw `fetch("/api/entries/save",
 *      { method: "POST", body: FormData })` — the hook does NOT
 *      use `useFetcher` so the helper can compose against a real
 *      Promise.
 *   4. On success, `MARK_SAVED` — guarded by `versionAtSaveRef` so a
 *      save that completes after the user has typed further edits
 *      does not clear the dirty flag prematurely.
 *   5. On bounded-retry exhaustion, `MARK_ERROR` — the pill goes red
 *      and surfaces a retry affordance.
 *   6. An `AbortController` is passed into the helper so an unmount
 *      mid-save aborts the backoff loop cleanly (no
 *      dispatch-after-unmount, no unhandled-rejection noise).
 *
 * The `beforeunload` handler covers true tab-close and refresh —
 * it does NOT fire on React Router client-side navigations
 * (`useBlocker` in the viewer route covers those). The handler sets
 * `event.returnValue = ""` in addition to `preventDefault()` so
 * modern Chrome and Firefox actually surface the unload prompt
 * (the HTML spec change ~2022 deprecated `preventDefault()` alone
 * for this case; both lines together cover every supported
 * browser).
 *
 * Manual save escape hatch: the hook exposes a stable `flush()`
 * callable in its return value so the viewer route's Cmd/Ctrl+S
 * keydown handler and its visible "Save now" button can route
 * through the same bounded-retry path as the debounced autosave.
 * The debounced effect calls the same `runSave` helper that
 * `flush()` uses, so the manual and debounced paths cannot drift
 * apart.
 *
 * `flush()` semantics: cancels the pending 1.5 s debounce (if any),
 * aborts any in-flight save via the supersede path, and fires a
 * fresh `withBoundedRetry` against the current entries snapshot. It
 * resolves to a `SaveResult` discriminated union from
 * `autosave-retry.ts`. Callers that just want to fire-and-forget
 * (Cmd/Ctrl+S, Save now button) can `void flush()`; callers that
 * want to await the settle (none in the viewer route today, but the
 * symmetry with the description editor's `flush()` is deliberate)
 * can `await` and discriminate on `.ok`.
 *
 * @version v0.4.1
 */
import { useCallback, useEffect, useRef } from "react";
import type { BoundaryState, BoundaryAction } from "./boundary-types";
import { withBoundedRetry, type SaveResult } from "./autosave-retry";

export function useAutosave(
  state: BoundaryState,
  dispatch: React.Dispatch<BoundaryAction>,
  volumeId: string,
) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedVersionRef = useRef(state.version);
  const versionAtSaveRef = useRef(state.version);

  // Per-debounce-cycle AbortController. Aborted on cleanup (unmount or
  // when a fresh debounce supersedes the in-flight save). The
  // bounded-retry helper resolves with `{ ok: false, error: "aborted" }`
  // when its signal aborts, so the catch path is a no-op rather than
  // a console.error.
  const abortRef = useRef<AbortController | null>(null);

  // Snapshot the latest entries-to-save into a ref so the debounced
  // save reads what's current at fire time, not what was current when
  // the effect was scheduled. Avoids the closure-over-stale-state
  // hazard that an inline `state.entries` access would have.
  const entriesRef = useRef(state.entries);
  useEffect(() => {
    entriesRef.current = state.entries;
  }, [state.entries]);

  // Snapshot the current version into a ref too — flush() needs the
  // latest version at call-time, not whatever the closure captured.
  const versionRef = useRef(state.version);
  useEffect(() => {
    versionRef.current = state.version;
  }, [state.version]);

  // `runSave` is the single bounded-retry call that BOTH the debounced
  // effect and the exposed `flush()` use. Centralising it ensures the
  // retry+settle contract cannot drift between the two paths.
  // Extracted from the debounced effect so `flush()` can fire the
  // same fetch shape against the latest entries+version snapshot
  // without duplicating the save plumbing.
  const runSave = useCallback(async (): Promise<SaveResult> => {
    // Supersede any in-flight save before starting a fresh one. A
    // pending debounce timer is the caller's responsibility to clear
    // (see `flush()` below); the debounced effect clears its own
    // timer in its setup branch.
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const versionAtSave = versionRef.current;
    versionAtSaveRef.current = versionAtSave;
    dispatch({ type: "MARK_SAVING" });

    const controller = new AbortController();
    abortRef.current = controller;

    const saveFn = async (): Promise<{ ok: boolean; error?: string }> => {
      const formData = new FormData();
      formData.set("volumeId", volumeId);
      formData.set("entries", JSON.stringify(entriesRef.current));

      try {
        const res = await fetch("/api/entries/save", {
          method: "POST",
          body: formData,
          credentials: "include",
          signal: controller.signal,
        });
        if (res.ok) {
          // Endpoint returns `{ success: true }` (api.entries.save).
          return { ok: true };
        }
        return { ok: false, error: `HTTP ${res.status}` };
      } catch (err) {
        // Surface an aborted fetch as an aborted SaveResult so the
        // helper's abort branch fires cleanly rather than producing
        // a confusing "TypeError" string in the error field.
        if (err instanceof DOMException && err.name === "AbortError") {
          return { ok: false, error: "aborted" };
        }
        throw err;
      }
    };

    const result = await withBoundedRetry(saveFn, { signal: controller.signal });

    // Drop the controller reference if it's still the one we
    // started with — a fresh debounce or flush() may have already
    // installed a new controller via the abort-and-supersede path.
    if (abortRef.current === controller) {
      abortRef.current = null;
    }

    if (result.ok) {
      // Only mark saved if the version on disk still matches the
      // version we captured at submit time. If the user typed
      // more between submit and reply, leave the dirty flag
      // alone and let the next debounce cycle persist the diff.
      if (versionAtSaveRef.current === versionAtSave) {
        savedVersionRef.current = versionAtSave;
        dispatch({ type: "MARK_SAVED" });
      }
      return result;
    }

    // Aborted cleanups are not user-visible failures — they
    // happen on unmount or when a newer edit supersedes the
    // current attempt. Swallow.
    if (result.error === "aborted") return result;

    // Bounded-retry exhaustion. The pill goes red regardless of
    // whether the user has typed further edits since submit —
    // error state must be visible. The dirty flag is preserved
    // by the reducer so the next edit (or a manual retry via
    // Save now / Cmd/Ctrl+S) can still flush.
    dispatch({ type: "MARK_ERROR", error: result.error });
    return result;
  }, [dispatch, volumeId]);

  // Debounced save trigger.
  useEffect(() => {
    if (!state.isDirty) return;

    // Clear any pending debounce; `runSave` handles aborting any
    // in-flight save itself via the supersede path.
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void runSave();
    }, 1500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [state.version, state.isDirty, runSave]);

  // Manual flush — cancels any pending debounce and fires `runSave`
  // immediately against the current entries+version snapshot.
  // Returns the SaveResult so callers can `await` and discriminate;
  // the viewer route's Cmd/Ctrl+S handler and its Save now button
  // both fire-and-forget via `void flush()`.
  const flush = useCallback(async (): Promise<SaveResult> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    return runSave();
  }, [runSave]);

  // beforeunload handler — fires on true tab close / refresh.
  // `event.returnValue = ""` is set in addition to `preventDefault()`
  // so modern Chrome and Firefox
  // actually surface the unload prompt; the spec change ~2022
  // deprecated `preventDefault()` alone for this case.
  useEffect(() => {
    if (!state.isDirty) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.isDirty]);

  // Cleanup on unmount: clear debounce, abort any in-flight save so
  // the bounded-retry helper resolves with `error: "aborted"` and
  // does not try to dispatch into a torn-down reducer.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { saveStatus: state.saveStatus, flush };
}

/* @version v0.4.1 */
