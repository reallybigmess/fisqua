/**
 * Entry Description Editor
 *
 * The full-page description editor for a single entry -- one of the
 * segmented documentary units a cataloguer carved out of a volume.
 * Renders a split-pane layout with the entry's IIIF image tiles on
 * one side and the standard-aware description form on the other, with
 * autosave and a review workflow (submit / approve / send back) built
 * in. Entity and place linker dialogs attach authority records to the
 * draft description, and the per-page QC-flag dialog lets cataloguers
 * raise digitisation problems without leaving the editor.
 *
 * Breaks out of the sidebar chrome via a path check in `_auth.tsx` so
 * cataloguers have the full viewport for image and form.
 *
 * The route resolves `tenant.descriptiveStandard` from
 * `tenantContext` and passes it to `<DescriptionForm
 * standard={...}>`, so a non-ISAD(G) tenant with crowdsourcing on
 * sees the right per-standard required marks and label overrides at
 * segmentation time. The section TOC and `sectionCompletion`
 * property accesses use the English column-name keys (`identity`,
 * `physical_description`, `content`, `notes`).
 *
 * **Autosave shape.** `handleFieldChange` always POSTs the FULL
 * fields object on every debounced autosave, not just the edited
 * field. A per-field-only payload would marshal every other
 * description column as `undefined`, strip it through
 * `JSON.stringify`, and null it on the server side via the old
 * `?? null` writer — losing all other description content on the
 * entry each time a single field was edited. The fix is
 * belt-and-braces with `saveDescription`'s additive server
 * contract: the client sends everything, and the server only writes
 * what it receives. `handleFieldChange` builds the payload from
 * `entryRef.current` (the latest committed React state) merged with
 * the just-edited field, so the value crossing the wire is always
 * current. The full-save path is exposed via `flush()` — same
 * payload shape, but routed through the bounded-retry helper so
 * manual flushes inherit the retry contract.
 *
 * **Save status indicator.** The top bar renders the shared
 * `<SaveStatus>` from `app/components/viewer/save-status.tsx`, with
 * the four-state labels resolved against the description
 * namespace's nested `editor.save_status_*` shape. The local
 * `saveStatus` state uses the shared `SaveStatusValue` union so it
 * can settle to `error` when bounded retry exhausts.
 *
 * **Bounded retry.** Both the debounced autosave inside
 * `handleFieldChange` and the explicit `flush()` path compose
 * against the shared `withBoundedRetry` helper from
 * `app/lib/autosave-retry.ts`. Three attempts with 1 s / 2 s
 * exponential backoff; on exhaustion the pill settles to `error`
 * and the retry affordance becomes clickable.
 *
 * `flush()` cancels the pending debounce, fires a fresh
 * `withBoundedRetry` against the latest fields, and returns the
 * `SaveResult` so flush-before-navigate and Cmd/Ctrl+S can await it
 * and react to failure. It also wires to the SaveStatus retry
 * affordance's `onRetry` callback so a user-clicked retry attempt
 * fires immediately.
 *
 * **In-app navigation guard.** `useBlocker` (React Router 7)
 * interrupts any client-side navigation away from this route while
 * there is unsaved or unsettled work — `hasUnsaved`, `saving`, or
 * `error`. On confirm-leave we attempt a single best-effort
 * `navigator.sendBeacon` flush to `/api/description/save` against
 * the current fields before proceeding with the navigation, then
 * call `blocker.proceed()`. The beacon is fire-and-forget — the
 * Worker accepts the request after the page navigates — but the
 * 60 KiB size guard (`shouldSendBeacon`) skips the beacon for
 * oversized payloads so we never silently drop work into a request
 * the browser will reject.
 *
 * The blocker's confirmation is a Tailwind-styled, i18n-driven
 * `<UnsavedChangesDialog>` from
 * `app/components/viewer/unsaved-changes-dialog.tsx` rendered at
 * the route's JSX tree root when `blocker.state === "blocked"`. A
 * native `window.confirm` would have no i18n leverage on its
 * buttons and would block browser automation. The flush semantics
 * are: onLeave calls `shouldSendBeacon(body.size)` +
 * `navigator.sendBeacon(...)` + `blocker.proceed()`, gated by a
 * `typeof navigator.sendBeacon === "function"` SSR-safety check.
 * onStay calls `blocker.reset()`. The dialog uses four
 * `editor.unsaved_dialog_*` keys for its strings.
 *
 * `handlePrev`, `handleNext`, and `handleSubmitForReview`
 * `await flush()` BEFORE navigating or firing the submit fetch. On
 * a `{ ok: false }` non-aborted return the navigation is aborted
 * and the SaveStatus pill (already in `error` state) is the user's
 * exit ramp via the retry affordance.
 *
 * The `beforeunload` handler covers true tab-close / refresh; it
 * also sets `event.returnValue = ""` so modern Chrome and Firefox
 * actually surface the unload prompt (the spec change ~2022
 * deprecated `preventDefault()` alone for this case).
 *
 * **Manual save escape hatch.** A window-level `keydown` handler
 * intercepts Cmd/Ctrl+S, calls `event.preventDefault()` to suppress
 * the browser's native save-page dialog, and routes to `flush()` —
 * the same bounded-retry call that the debounced autosave uses. A
 * visible "Save now" button sits next to the SaveStatus pill in the
 * top bar; its onClick is the same `() => { void flush(); }`. Even
 * if the autosave path regresses, the cataloguer has a manual
 * override that never relies on debounce timing or in-app
 * navigation lifecycle.
 *
 * **Field coverage.** `buildFieldsPayload` derives its payload from
 * the shared `DESCRIPTION_FIELD_KEYS` registry — the same tuple the
 * server writer iterates — so a field cannot exist on one side of
 * the wire only (the failure mode behind the title-field incident).
 * Pinned by tests in `tests/description/autosave.test.ts`.
 *
 * @version v0.4.2
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import { Link, useNavigate, useRevalidator, useBlocker } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext, tenantContext } from "../context";
import { getSectionCompletion } from "../lib/description-types";
import type { Standard } from "../lib/standards/types";
import type { DescriptionEntry, CommentWithAuthor } from "../lib/description-types";
import {
  DESCRIPTION_STATUS_STYLES,
  DESCRIPTION_STATUS_LABELS,
  DESCRIPTION_FIELD_KEYS,
  type DescriptionStatus,
} from "../lib/description-workflow";
import { DescriptionForm } from "../components/description/description-form";
import { DescriptionImageViewer } from "../components/description/description-image-viewer";
import { EntryNav } from "../components/description/entry-nav";
import { SectionTOC } from "../components/description/section-toc";
import { CommentThread } from "../components/comments/comment-thread";
import { FlagQcDialog } from "../components/qc-flags/flag-qc-dialog";
import { ResizableDivider } from "../components/outline/resizable-divider";
import {
  SaveStatus,
  type SaveStatusValue,
} from "../components/viewer/save-status";
import { UnsavedChangesDialog } from "../components/viewer/unsaved-changes-dialog";
import {
  withBoundedRetry,
  type SaveResult,
} from "../lib/autosave-retry";
import { shouldBlockNavigation } from "../lib/blocker-condition";
import {
  shouldSendBeacon,
  buildDescriptionBeaconBody,
} from "../lib/beacon-save";
import type { Route } from "./+types/_auth.description.$projectId.$entryId";
import { PROJECT_ROLES } from "../lib/validation/enums";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { requireProjectRole, highestProjectRole } = await import("../lib/permissions.server");
  const {
    loadDescriptionEntry,
    loadVolumeEntriesForDescription,
  } = await import("../lib/description.server");
  const { getCommentsForEntry } = await import("../lib/comments.server");
  const { hasOpenFlags } = await import("../lib/resegmentation.server");
  const { entries, volumes, projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  // `descriptive_standard` is NOT NULL for `kind = 'tenant'` per
  // the schema CHECK in drizzle/0034_tenants_table.sql. The
  // cataloguing form routes do not reach platform-tenant requests,
  // so a null here is schema corruption (the CHECK was bypassed).
  // Throw rather than silently defaulting to ISAD-shaped behaviour.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }
  const descriptiveStandard: Standard = tenant.descriptiveStandard;
  const db = drizzle(context.cloudflare.env.DB);

  // Verify project membership
  const memberships = await requireProjectRole(
    db,
    user.id,
    params.projectId,
    [...PROJECT_ROLES],
    user.isAdmin
  );

  // Load entry data
  const { entry, volume, pages } = await loadDescriptionEntry(
    db,
    params.entryId
  );

  // Verify the entry belongs to this project
  if (volume.projectId !== params.projectId) {
    throw new Response("Entry does not belong to this project", {
      status: 404,
    });
  }

  // Check description access. Admins can arrive with no membership
  // rows (requireProjectRole bypass); cataloguer is the floor.
  const userRole = highestProjectRole(memberships) ?? "cataloguer";

  const isLead = userRole === "lead";
  const isAssignedDescriber = entry.assignedDescriber === user.id;
  const isAssignedReviewer = entry.assignedDescriptionReviewer === user.id;

  if (!user.isAdmin && !isLead && !isAssignedDescriber && !isAssignedReviewer) {
    throw new Response("Forbidden", { status: 403 });
  }

  // Load all entries for navigation
  const allEntries = await loadVolumeEntriesForDescription(db, entry.volumeId);

  // Load comments
  const commentsData = await getCommentsForEntry(db, params.entryId);

  // Check for open resegmentation flags
  const isPaused = await hasOpenFlags(db, entry.volumeId);

  // Determine if read-only (reviewer viewing, or entry in non-editable status)
  const editableStatuses = ["assigned", "in_progress", "sent_back"];
  const statusAllowsEdit = editableStatuses.includes(entry.descriptionStatus ?? "");
  const hasEditRole = isLead || isAssignedDescriber;
  const canEdit = hasEditRole && statusAllowsEdit;
  const isReadOnly = !canEdit;

  // Determine why it's read-only so we can tell the user
  let readOnlyReason: string | null = null;
  if (isReadOnly) {
    if (!entry.descriptionStatus || entry.descriptionStatus === "unassigned") {
      readOnlyReason = "unassigned";
    } else if (!hasEditRole) {
      readOnlyReason = "not_assigned";
    } else if (!statusAllowsEdit) {
      readOnlyReason = "status";
    }
  }

  return {
    entry,
    volume,
    pages,
    allEntries,
    comments: commentsData as CommentWithAuthor[],
    currentUser: { id: user.id, email: user.email },
    userRole,
    isPaused,
    isReadOnly,
    readOnlyReason,
    projectId: params.projectId,
    descriptiveStandard,
  };
}

// --- Main component ---

export default function DescriptionEditorRoute({
  loaderData,
}: Route.ComponentProps) {
  const {
    entry: initialEntry,
    volume,
    pages,
    allEntries,
    comments,
    currentUser,
    userRole,
    isPaused,
    isReadOnly,
    readOnlyReason,
    projectId,
    descriptiveStandard,
  } = loaderData;

  const { t } = useTranslation("description");
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // Local entry state for optimistic updates
  const [entry, setEntry] = useState<DescriptionEntry>(
    initialEntry as DescriptionEntry
  );

  // Sync entry state when route changes (new entry loaded).
  //
  // Do NOT touch `saveStatus` here. With `flush()` +
  // flush-before-navigate wiring, the previous entry's save is fully
  // settled (success, error, or aborted) before this effect runs —
  // `runSave` has already pushed `saveStatus` to either "saved" or
  // "error", or the user explicitly accepted leaving with unsaved
  // work via the confirm dialog. Touching `saveStatus` here would
  // race that settlement and let stale state from the prior entry
  // contaminate the new one.
  useEffect(() => {
    setEntry(initialEntry as DescriptionEntry);
  }, [initialEntry.id]);

  // Autosave state. Uses the shared `SaveStatusValue` union
  // (saved / saving / unsaved / error) so the route can dispatch the
  // `error` state from the bounded-retry helper.
  const [saveStatus, setSaveStatus] = useState<SaveStatusValue>("saved");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentEntryRef = useRef(initialEntry.id);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  // Latest committed entry state, mirrored into a ref so the
  // debounced autosave can build a full-fields payload at fire time
  // without needing the entry object in its `useCallback` dependency
  // list (which would otherwise rebuild the callback on every keystroke
  // and lose the in-flight debounce timer).
  const entryRef = useRef<DescriptionEntry>(initialEntry as DescriptionEntry);
  useEffect(() => {
    entryRef.current = entry;
  }, [entry]);

  // Track current entry ID to discard stale saves
  useEffect(() => {
    currentEntryRef.current = initialEntry.id;
  }, [initialEntry.id]);

  // Section completion
  const sectionCompletion = useMemo(
    () => getSectionCompletion(entry),
    [entry]
  );

  // Active section tracking for TOC
  const [activeSectionId, setActiveSectionId] = useState("identity");

  // Resizable panel
  const MIN_PANEL_PCT = 35;
  const MAX_PANEL_PCT = 60;
  const [formPanelPct, setFormPanelPct] = useState(45);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (deltaX: number) => {
      if (!containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      const deltaPct = (deltaX / containerWidth) * 100;
      setFormPanelPct((pct) =>
        Math.min(MAX_PANEL_PCT, Math.max(MIN_PANEL_PCT, pct + deltaPct))
      );
    },
    []
  );

  // Build a full description-fields payload from the latest committed
  // entry state, with an optional last-keystroke override layered on
  // top. Centralising this here means `handleFieldChange` and
  // `flush()` send byte-identical request bodies — the client half
  // of the belt-and-braces guard that pairs with the server's
  // additive `saveDescription` writer.
  const buildFieldsPayload = useCallback(
    (override?: { fieldName: string; value: string }) => {
      const current = entryRef.current as Record<string, unknown>;
      // Derived from the shared registry, not a hand-kept literal — the
      // server writer iterates the same DESCRIPTION_FIELD_KEYS, so a
      // field can no longer exist on one side of the wire only.
      const fields: Record<string, unknown> = {};
      for (const key of DESCRIPTION_FIELD_KEYS) {
        fields[key] = current[key] ?? null;
      }

      if (override && override.fieldName in fields) {
        fields[override.fieldName] = override.value || null;
      }

      return fields;
    },
    []
  );

  // Per-debounce-cycle AbortController. Aborted when the unmount
  // cleanup fires (so the bounded-retry helper resolves with
  // `{ ok: false, error: "aborted" }` instead of dispatching into a
  // torn-down component).
  const saveAbortRef = useRef<AbortController | null>(null);

  // Shared save executor used by both the debounced `handleFieldChange`
  // path and the explicit `flush()` path. Runs `withBoundedRetry`
  // against a fresh `/api/description/save` fetch, settling the
  // `saveStatus` UI state on success/failure and discarding stale
  // results when the user has switched to a different entry during
  // the save. On bounded-retry exhaustion the pill settles to the
  // visible `error` state and surfaces the retry affordance.
  const runSave = useCallback(
    async (
      fields: Record<string, unknown>,
    ): Promise<SaveResult> => {
      const entryIdAtSave = currentEntryRef.current;

      // Abort any in-flight save before starting a fresh one — a
      // newer edit (or an explicit flush) supersedes the prior cycle.
      if (saveAbortRef.current) {
        saveAbortRef.current.abort();
      }
      const controller = new AbortController();
      saveAbortRef.current = controller;

      setSaveStatus("saving");

      const saveFn = async (): Promise<{ ok: boolean; error?: string }> => {
        try {
          const res = await fetch("/api/description/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entryId: entryIdAtSave,
              fields,
            }),
            credentials: "include",
            signal: controller.signal,
          });
          if (!res.ok) {
            return { ok: false, error: `HTTP ${res.status}` };
          }
          const data = (await res.json()) as { ok?: boolean };
          if (data.ok) return { ok: true };
          return { ok: false, error: "server rejected save" };
        } catch (err) {
          // AbortError surfaces here when the signal aborts mid-fetch
          // — propagate to the helper, which has its own abort path.
          if (err instanceof Error && err.name === "AbortError") {
            return { ok: false, error: "aborted" };
          }
          throw err;
        }
      };

      const result = await withBoundedRetry(saveFn, {
        signal: controller.signal,
      });

      // Drop the controller reference if it's still ours — a fresh
      // edit may have installed a new controller via the
      // abort-and-supersede path above.
      if (saveAbortRef.current === controller) {
        saveAbortRef.current = null;
      }

      if (result.ok) {
        // Stale-discard guard: only flip back to "saved" if the user
        // is still on the same entry. If they navigated away during
        // the save, the new entry's effect has already reset the
        // pill via the `setSaveStatus("saved")` on `initialEntry.id`
        // change — touching it again here would race that. The save
        // itself still landed on the prior entry's server row.
        if (currentEntryRef.current === entryIdAtSave) {
          setSaveStatus("saved");
        }
        return result;
      }

      // Aborted: the supersede path or the unmount cleanup fired. Not
      // a user-visible failure — leave the pill alone.
      if (result.error === "aborted") return result;

      // Bounded-retry exhaustion. Surface the error pill regardless
      // of stale-discard — even if the user has navigated, the prior
      // entry's save genuinely failed, and showing the error is more
      // honest than silently rolling back to "unsaved". The retry
      // affordance lets them fire a fresh attempt against the current
      // fields on the current entry.
      setSaveStatus("error");
      return result;
    },
    [],
  );

  // Field change handler with autosave. The autosave POST body
  // carries the FULL fields object — every controlled field's
  // current value, plus the just-edited override — not just the
  // edited field. A per-field-only payload would cause the server to
  // receive `undefined` for every other column, and the old
  // `?? null` writer would null it on disk. With the full-fields
  // payload plus the server-side additive contract in
  // `saveDescription`, neither half can null an absent column.
  //
  // The debounced save routes through `runSave` → `withBoundedRetry`,
  // so 3-attempt exponential backoff and the `error` settle state
  // come for free.
  const handleFieldChange = useCallback(
    (fieldName: string, value: string) => {
      setEntry((prev) => ({ ...prev, [fieldName]: value || null }));
      setSaveStatus("unsaved");
      setValidationErrors((prev) => {
        if (prev[fieldName]) {
          const next = { ...prev };
          delete next[fieldName];
          return next;
        }
        return prev;
      });

      // Debounced autosave
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        // Build the full-fields payload at fire time so the latest
        // committed state is included alongside the just-edited
        // override. `entryRef.current` is updated by the effect above
        // on every render, so by the time the 1500 ms debounce
        // expires it already reflects the keystroke that triggered
        // this save.
        const fields = buildFieldsPayload({ fieldName, value });
        void runSave(fields);
      }, 1500);
    },
    [buildFieldsPayload, runSave],
  );

  /**
   * Flush any pending debounced autosave immediately and run the
   * bounded-retry helper against the current fields. Returns the
   * `SaveResult` so callers can discriminate on success vs. failure
   * without a try/catch.
   *
   * Wiring:
   *   - The shared SaveStatus's retry affordance calls this on click.
   *   - `handlePrev` / `handleNext` / `handleSubmitForReview` await
   *     this before navigating so an in-flight save cannot lose
   *     unflushed edits when the user changes entry.
   *   - The Cmd/Ctrl+S keyboard handler and the "Save now" button
   *     both await this.
   *
   * Stable via `useCallback` so callers can include it in their own
   * dependency lists.
   */
  const flush = useCallback(async (): Promise<SaveResult> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    return runSave(buildFieldsPayload());
  }, [buildFieldsPayload, runSave]);

  // Clean up debounce + abort any in-flight save on unmount. Aborting
  // makes `withBoundedRetry` settle to `{ ok: false, error: "aborted" }`
  // so no `setSaveStatus` runs against a torn-down component.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (saveAbortRef.current) saveAbortRef.current.abort();
    };
  }, []);

  // Submit for review.
  //
  // The submit path has the same race shape as prev/next — firing
  // the "submit" action while a debounced autosave is still pending
  // would push a partially-stale description into the review queue.
  // The handler awaits `flush()` before firing. On a non-abort
  // `{ ok: false }` from flush the submit aborts entirely; the pill
  // is already in `error` state and the user can retry via the
  // SaveStatus affordance.
  const handleSubmitForReview = useCallback(async () => {
    const flushResult = await flush();
    if (!flushResult.ok && flushResult.error !== "aborted") {
      // Save settled to error after bounded retries. Abort submit;
      // the SaveStatus pill is already showing the error and the
      // retry affordance is the user's exit.
      return;
    }

    const entryIdAtSave = currentEntryRef.current;

    try {
      const res = await fetch("/api/description/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryId: entryIdAtSave,
          action: "submit",
        }),
      });
      const data: any = await res.json();
      if (data.ok) {
        setEntry((prev) => ({
          ...prev,
          descriptionStatus: "described" as DescriptionStatus,
        }));
        setValidationErrors({});
        revalidator.revalidate();
      } else if (data.validationErrors) {
        const errors: Record<string, string> = {};
        for (const err of data.validationErrors) {
          errors[err.field] = err.message;
        }
        setValidationErrors(errors);
      }
    } catch {
      // Network/parse failure on the submit POST itself. The
      // preceding flush ensured the underlying description was
      // persisted; only the workflow transition failed. The user
      // can retry submitting.
    }
  }, [flush, revalidator]);

  // Entry navigation.
  //
  // Both prev and next await `flush()` BEFORE `navigate(...)`, so
  // the previous entry's pending autosave is settled (success,
  // error, or aborted) before the route re-renders with the new
  // `entryId`. On a non-abort `{ ok: false }` from flush we leave
  // the user on the current entry; the SaveStatus pill is already
  // in `error` state and the retry affordance is the exit.
  const currentIndex = allEntries.findIndex((e) => e.id === entry.id);

  const handlePrev = useCallback(async () => {
    if (currentIndex <= 0) return;
    const flushResult = await flush();
    if (!flushResult.ok && flushResult.error !== "aborted") {
      return;
    }
    const prevEntry = allEntries[currentIndex - 1];
    navigate(`/projects/${projectId}/describe/${prevEntry.id}`);
  }, [currentIndex, allEntries, navigate, projectId, flush]);

  const handleNext = useCallback(async () => {
    if (currentIndex >= allEntries.length - 1) return;
    const flushResult = await flush();
    if (!flushResult.ok && flushResult.error !== "aborted") {
      return;
    }
    const nextEntry = allEntries[currentIndex + 1];
    navigate(`/projects/${projectId}/describe/${nextEntry.id}`);
  }, [currentIndex, allEntries, navigate, projectId, flush]);

  // Section TOC data — English column-name section IDs. Labels
  // resolved against the cataloguing namespace shape. The TOC
  // mirrors the form's section structure;
  // because the cataloguing form's section structure is hardcoded
  // (per the form-component header on the entries-vs-descriptions
  // domain difference), the TOC's section list is hardcoded too. The
  // standard prop isn't needed here: TOC labels are common across
  // ISAD(G), DACS, and RAD in the cataloguing namespace; per-standard
  // overrides are an option if a divergence ever surfaces.
  const tocSections = useMemo(
    () => [
      {
        id: "identity",
        isComplete: sectionCompletion.identity,
        label: t("sections.identity"),
      },
      {
        id: "physical_description",
        isComplete: sectionCompletion.physical_description,
        label: t("sections.physical_description"),
      },
      {
        id: "content",
        isComplete: sectionCompletion.content,
        label: t("sections.content"),
      },
      {
        id: "notes",
        isComplete: sectionCompletion.notes,
        label: t("sections.notes"),
      },
    ],
    [sectionCompletion, t]
  );

  const handleSectionClick = useCallback((sectionId: string) => {
    const el = document.getElementById(`section-${sectionId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setActiveSectionId(sectionId);
  }, []);

  // Resegmentation dialog state
  const [showResegDialog, setShowResegDialog] = useState(false);

  // QC flag dialog state (per-page flag raise in the
  // description editor). Single dialog instance at the tree root,
  // pre-filled via the page id and position captured when the
  // per-page flag button is clicked.
  const [flagDialog, setFlagDialog] = useState<{
    open: boolean;
    pageId: string | null;
    pagePosition: number | null;
  }>({ open: false, pageId: null, pagePosition: null });

  const handleFlagPage = useCallback(
    (pageId: string, pagePosition: number) => {
      setFlagDialog({ open: true, pageId, pagePosition });
    },
    []
  );

  const handleFlagDialogClose = useCallback(() => {
    setFlagDialog({ open: false, pageId: null, pagePosition: null });
  }, []);

  const handleFlagCreated = useCallback(() => {
    // Revalidate so any downstream surfaces picking up openQcFlagCount
    // (viewer, volume cards) refresh on the next loader pass.
    revalidator.revalidate();
  }, [revalidator]);

  const handleCommentAdded = useCallback(() => {
    revalidator.revalidate();
  }, [revalidator]);

  // beforeunload handler for unsaved changes.
  //
  // The handler fires while the editor is in any non-`saved` state
  // (unsaved edits, in-flight save, or settled error) — `useBlocker`
  // covers client-side navigations, but `beforeunload` is still the
  // only path that catches true tab-close and refresh. The handler
  // sets `event.returnValue = ""` in addition to `preventDefault()`;
  // modern Chrome and Firefox no longer honour `preventDefault()`
  // alone for the unload prompt (HTML spec change ~2022). Both
  // lines together cover every supported browser.
  useEffect(() => {
    if (saveStatus === "saved") return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveStatus]);

  // Intercepts in-app navigations (Link clicks, navigate() from
  // prev/next, browser back via popstate) while there is work the
  // user would lose by leaving. The
  // `currentLocation.pathname !== nextLocation.pathname` guard
  // prevents the blocker from firing on search-param-only changes
  // (e.g. filter toggles inside the route).
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      shouldBlockNavigation(saveStatus, saveStatus === "unsaved") &&
      currentLocation.pathname !== nextLocation.pathname,
  );

  // The blocker's confirmation is a Tailwind/i18n-driven
  // `<UnsavedChangesDialog>` rendered at the bottom of the route's
  // JSX tree, controlled by `blocker.state === "blocked"`. The
  // handlers below close over `currentEntryRef`, `buildFieldsPayload`,
  // and `blocker` so the sendBeacon flush semantics are preserved
  // verbatim — only the UI of the confirmation changes.
  const handleUnsavedStay = useCallback(() => {
    if (blocker.state === "blocked") {
      blocker.reset();
    }
  }, [blocker]);

  const handleUnsavedLeave = useCallback(() => {
    if (blocker.state !== "blocked") return;
    // Best-effort fire-and-forget flush via sendBeacon.
    // The Worker accepts the POST even after navigation begins; the
    // 60 KiB strict-less-than guard protects against silent drop for
    // unusually large payloads. typeof guard so SSR / test pools
    // without `navigator.sendBeacon` don't blow up.
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const body = buildDescriptionBeaconBody(
        currentEntryRef.current,
        buildFieldsPayload(),
      );
      if (shouldSendBeacon(body.size)) {
        navigator.sendBeacon("/api/description/save", body);
      }
    }
    blocker.proceed();
  }, [blocker, buildFieldsPayload]);

  // Cmd/Ctrl+S keyboard shortcut — manual save escape hatch.
  // Intercepts the platform save shortcut on macOS (Cmd-S) and
  // Linux/Windows (Ctrl-S). `preventDefault()` is essential: without
  // it the browser surfaces its native "save page" dialog over the
  // editor, which is the opposite of what the cataloguer wants.
  // `e.key.toLowerCase()` is defensive against Shift-S → "S" (the
  // Cmd+Shift+S browser shortcut for save-as is left to the browser
  // — but accepting upper/lowercase keeps the handler robust to
  // platforms that report capitalised key names under modifier
  // combinations). Listening on `window` rather than `document`
  // covers focus-in-iframe edge cases.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s")) return;
      e.preventDefault();
      // Fire-and-forget: the returned SaveResult drives the pill
      // via runSave's own state transitions, not this handler.
      // `void` here keeps any aborted-result from surfacing as an
      // unhandled promise rejection.
      void flush();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flush]);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-12 shrink-0 items-center border-b border-stone-200 bg-stone-50 px-4">
        {/* Left: logo + subtitle */}
        <div className="flex items-center gap-2">
          <Link to="/" className="flex items-center">
            <img src="/brand/fisqua-mark.svg" alt="" className="h-6 w-6" aria-hidden="true" />
          </Link>
          <span className="font-sans text-sm text-stone-500">
            {t("editor.subtitle")}
          </span>
        </div>

        {/* Centre: entry title */}
        <div className="flex min-w-0 flex-1 justify-center">
          <h1 className="truncate font-serif text-xl font-semibold text-stone-700">
            {entry.title || entry.translatedTitle || `#${entry.position + 1}`}
          </h1>
        </div>

        {/* Right: save status + user + logout */}
        <div className="flex items-center gap-3">
          {/* SaveStatus pill + visible Save-now button. Both share
              the flex wrapper convention so the button always sits
              adjacent to the pill rather than floating elsewhere in
              the top bar. The SaveStatus component is
              presentation-only (labels-as-props); the Save-now
              button lives in this wrapper directly so it can call
              `flush()` without threading another prop through the
              shared component. */}
          <div className="flex items-center gap-2">
            <SaveStatus
              status={saveStatus}
              labels={{
                saved: t("editor.save_status_saved"),
                saving: t("editor.save_status_saving"),
                unsaved: t("editor.save_status_unsaved"),
                error: t("editor.save_status_error"),
              }}
              retryLabel={t("editor.save_failed_retry")}
              onRetry={() => {
                // Fire-and-forget: the returned SaveResult is consumed by
                // the pill's own state machine, not by the click handler.
                // `void` here keeps any AbortError-shaped abort result
                // from surfacing as an unhandled promise rejection.
                void flush();
              }}
            />
            <button
              type="button"
              onClick={() => {
                // Same fire-and-forget contract as the Cmd/Ctrl+S
                // handler and the retry affordance — `flush()`
                // drives the pill via runSave's state transitions.
                void flush();
              }}
              className="font-sans text-xs font-medium text-stone-600 underline-offset-2 hover:text-stone-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-verdigris"
            >
              {t("editor.save_now")}
            </button>
          </div>
          <span className="font-sans text-sm text-stone-500">
            {currentUser.email}
          </span>
          <Link
            to="/auth/logout"
            className="font-sans text-sm font-medium text-indigo hover:underline"
          >
            {t("editor.cerrar_sesion")}
          </Link>
        </div>
      </div>

      {/* Entry navigation bar */}
      <div className="flex items-center justify-between border-b border-stone-200 bg-white px-4 py-2">
        <EntryNav
          currentIndex={currentIndex}
          totalEntries={allEntries.length}
          currentEntry={{
            title: entry.title,
            descriptionStatus: entry.descriptionStatus,
          }}
          onPrev={handlePrev}
          onNext={handleNext}
          prevDisabled={currentIndex <= 0}
          nextDisabled={currentIndex >= allEntries.length - 1}
        />

        {/* Report issue button */}
        {!isPaused && userRole !== "lead" && (
          <button
            type="button"
            onClick={() => setShowResegDialog(true)}
            className="flex items-center gap-1.5 rounded-md border border-saffron bg-saffron-tint px-3 py-1.5 font-sans text-13 font-medium text-saffron-deep hover:bg-saffron-tint"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            {t("editor.reportar_problema")}
          </button>
        )}
      </div>

      {/* Read-only notice */}
      {isReadOnly && readOnlyReason && (
        <div className="flex items-center gap-2 border-b border-saffron bg-saffron-tint px-4 py-2 text-sm text-saffron-deep">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {t(`editor.readonly_${readOnlyReason}`)}
        </div>
      )}

      {/* Main split pane */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Form panel */}
        <div
          className="flex shrink-0 overflow-hidden"
          style={{ width: `${formPanelPct}%` }}
        >
          {/* Form scroll area */}
          <div className="flex-1 overflow-y-auto p-4">
            <DescriptionForm
              entry={entry}
              onFieldChange={handleFieldChange}
              sectionCompletion={sectionCompletion}
              isReadOnly={isReadOnly}
              isPaused={isPaused}
              onSubmitForReview={handleSubmitForReview}
              validationErrors={validationErrors}
              standard={descriptiveStandard}
            />

            {/* Comments section (pass volumeId through the legacy
                shim prop path; a future migration moves to the
                discriminated target prop). */}
            <CommentThread
              entryId={entry.id}
              volumeId={entry.volumeId}
              comments={comments}
              onCommentAdded={handleCommentAdded}
            />
          </div>

          {/* Section TOC sidebar */}
          <SectionTOC
            sections={tocSections}
            onSectionClick={handleSectionClick}
            activeSectionId={activeSectionId}
          />
        </div>

        {/* Resizable divider */}
        <ResizableDivider onResize={handleResize} />

        {/* Image viewer panel */}
        <div className="flex-1 overflow-hidden">
          <DescriptionImageViewer
            pages={pages}
            currentEntryStartPage={entry.startPage}
            currentEntryEndPage={entry.endPage}
            onFlagPage={handleFlagPage}
          />
        </div>
      </div>

      {/* QC flag dialog. Single instance at the tree
          root — opened by handleFlagPage, closed either by submission or
          by the user. `volumeId` is derived from the loaded entry's volume
          so the server-side access check passes. */}
      {flagDialog.open && flagDialog.pageId && flagDialog.pagePosition !== null && (
        <FlagQcDialog
          open={flagDialog.open}
          onClose={handleFlagDialogClose}
          volumeId={volume.id}
          pageId={flagDialog.pageId}
          pagePosition={flagDialog.pagePosition}
          onCreated={handleFlagCreated}
        />
      )}

      {/* In-app unsaved-changes dialog. Renders when `useBlocker`
          has intercepted a dirty navigation. Stay →
          blocker.reset(); Leave → sendBeacon flush +
          blocker.proceed(). Stay is the safe default (autoFocus +
          Escape + backdrop + X all route through onStay). */}
      <UnsavedChangesDialog
        open={blocker.state === "blocked"}
        titleLabel={t("editor.unsaved_dialog_title")}
        bodyLabel={t("editor.unsaved_dialog_body")}
        stayLabel={t("editor.unsaved_dialog_stay")}
        leaveLabel={t("editor.unsaved_dialog_leave")}
        onStay={handleUnsavedStay}
        onLeave={handleUnsavedLeave}
      />

      {/* Re-segmentation dialog stub — to be replaced by the real
          FlagResegmentationDialog when that component lands. */}
      {showResegDialog && (
        <ResegmentationDialogStub
          onClose={() => {
            setShowResegDialog(false);
            revalidator.revalidate();
          }}
          entryId={entry.id}
          volumeId={volume.id}
          entry={entry}
          volume={volume}
          allEntries={allEntries}
          currentIndex={currentIndex}
        />
      )}
    </div>
  );
}

/**
 * Temporary stub for FlagResegmentationDialog.
 * Will be replaced when the real component lands.
 */
function ResegmentationDialogStub({
  onClose,
  entryId,
  volumeId,
  entry,
  volume,
  allEntries,
  currentIndex,
}: {
  onClose: () => void;
  entryId: string;
  volumeId: string;
  entry: DescriptionEntry;
  volume: any;
  allEntries: any[];
  currentIndex: number;
}) {
  const { t } = useTranslation("description");
  const [problemType, setProblemType] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Get neighbouring entries
  const neighbourEntries = allEntries.filter(
    (_e, i) => Math.abs(i - currentIndex) <= 3 && i !== currentIndex
  );

  const [selectedAffected, setSelectedAffected] = useState<Set<string>>(
    () => new Set()
  );

  const canSubmit = problemType && description.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    setSubmitting(true);

    fetch("/api/resegmentation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volumeId,
        entryId,
        problemType,
        affectedEntryIds: JSON.stringify(Array.from(selectedAffected)),
        description,
      }),
    })
      .then((res) => res.json())
      .then((data: any) => {
        if (data.ok) {
          onClose();
        }
        setSubmitting(false);
      })
      .catch(() => setSubmitting(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[90vh] w-full max-w-[560px] overflow-y-auto rounded-lg bg-white p-6">
        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-saffron-tint">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#C68A2E"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 className="font-display text-2xl font-semibold text-stone-700">
            {t("resegmentation.reportar_problema")}
          </h2>
        </div>

        {/* Warning */}
        <div className="mb-4 rounded-lg bg-saffron-tint p-3 text-sm text-saffron-deep">
          {t("resegmentation.warning")}
        </div>

        {/* Problem type */}
        <div className="mb-4">
          <p className="mb-2 font-sans text-sm font-medium text-stone-700">
            {t("resegmentation.tipo_problema")}
          </p>
          <div className="space-y-2">
            {[
              {
                value: "incorrect_boundaries",
                label: t("resegmentation.limites_incorrectos"),
                desc: t("resegmentation.limites_incorrectos_desc"),
              },
              {
                value: "merged_documents",
                label: t("resegmentation.documentos_fusionados"),
                desc: t("resegmentation.documentos_fusionados_desc"),
              },
              {
                value: "split_document",
                label: t("resegmentation.documento_dividido"),
                desc: t("resegmentation.documento_dividido_desc"),
              },
              {
                value: "missing_pages",
                label: t("resegmentation.paginas_faltantes"),
                desc: "",
              },
              {
                value: "other",
                label: t("resegmentation.otro"),
                desc: "",
              },
            ].map((opt) => (
              <label
                key={opt.value}
                className="font-medium flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-stone-50"
              >
                <input
                  type="radio"
                  name="problemType"
                  value={opt.value}
                  checked={problemType === opt.value}
                  onChange={() => setProblemType(opt.value)}
                  className="mt-0.5 accent-saffron"
                />
                <div>
                  <span className="font-sans text-sm font-medium text-stone-700">
                    {opt.label}
                  </span>
                  {opt.desc && (
                    <p className="font-sans text-xs text-stone-500">
                      {opt.desc}
                    </p>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Affected entries */}
        {neighbourEntries.length > 0 && (
          <div className="mb-4">
            <p className="mb-2 font-sans text-sm font-medium text-stone-700">
              {t("resegmentation.entradas_afectadas")}
            </p>
            <div className="max-h-32 overflow-y-auto rounded border border-stone-200 p-2">
              {neighbourEntries.map((ne) => (
                <label
                  key={ne.id}
                  className="flex items-center gap-2 py-1 font-sans text-13 font-medium text-indigo"
                >
                  <input
                    type="checkbox"
                    checked={selectedAffected.has(ne.id)}
                    onChange={(e) => {
                      setSelectedAffected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) {
                          next.add(ne.id);
                        } else {
                          next.delete(ne.id);
                        }
                        return next;
                      });
                    }}
                  />
                  #{ne.position + 1}{" "}
                  {ne.title || ne.translatedTitle || t("viewer:no_title")}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        <div className="mb-4">
          <textarea
            className="min-h-[100px] w-full rounded border border-stone-200 p-3 font-sans text-sm text-stone-700 placeholder:text-stone-400 focus:border-saffron focus:outline-none focus:ring-1 focus:ring-saffron"
            placeholder={t("resegmentation.descripcion_placeholder")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-2 font-sans text-sm text-stone-500 hover:bg-stone-100"
          >
            {t("resegmentation.cancelar")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="rounded bg-saffron px-4 py-2 font-sans text-sm font-medium text-white hover:bg-saffron-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("resegmentation.enviar_reporte")}
          </button>
        </div>
      </div>
    </div>
  );
}
