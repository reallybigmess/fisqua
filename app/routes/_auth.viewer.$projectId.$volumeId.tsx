/**
 * Segmentation Viewer Route
 *
 * The cataloguing workspace: IIIF viewer on the left, outline on the
 * right, with the QC flag and comment surfaces integrated through the
 * toolbar and overlays. The loader pulls everything the page needs in
 * a single round-trip — pages, entries, open comments partitioned by
 * page / entry / flag / region, open QC flags per page, and any open
 * resegmentation requests — so the render never waterfalls.
 *
 * In-app navigation must not discard in-flight saves. `useBlocker`
 * (React Router 7) interrupts any client-side navigation away from
 * the viewer route while the boundary state is dirty, a save is in
 * flight, or the last save settled to error. On confirm-leave we
 * attempt a single best-effort `navigator.sendBeacon` flush of the
 * current entries to `/api/entries/save` (FormData body — a
 * first-class sendBeacon type) before calling `blocker.proceed()`.
 * The back-arrow `<Link>` in `ViewerTopBar` is intercepted
 * automatically because `useBlocker` covers all client-side RR
 * navigations.
 *
 * The blocker's confirmation is a Tailwind-styled, i18n-driven
 * `<UnsavedChangesDialog>` from
 * `app/components/viewer/unsaved-changes-dialog.tsx` rendered at the
 * route's JSX tree root when `blocker.state === "blocked"`. A
 * native `window.confirm` would have no i18n leverage on its buttons
 * and would block browser automation. The sendBeacon flush
 * semantics are: onLeave builds the FormData via
 * `buildEntriesBeaconBody`, estimates size via the JSON-serialised
 * entries length (FormData has no portable synchronous `.size`),
 * gates with `shouldSendBeacon`, fires `navigator.sendBeacon` and
 * then `blocker.proceed()`. onStay calls `blocker.reset()`. The
 * dialog uses four `save_status.unsaved_dialog_*` keys for its
 * strings.
 *
 * Manual save escape hatch: the `useAutosave` hook exposes a stable
 * `flush()` callable; the viewer route destructures it and wires it
 * to (a) a window-level `keydown` handler that intercepts Cmd/Ctrl+S
 * with `preventDefault()` so the browser's native save-page dialog
 * does not fire, and (b) the "Save now" button rendered by
 * `ViewerTopBar` next to the SaveStatus pill (the button click is
 * forwarded via the `onSaveNow` prop). Both paths fire-and-forget
 * `void flush()` — the SaveStatus pill drives the UI via
 * MARK_SAVING / MARK_SAVED / MARK_ERROR transitions inside the
 * hook itself.
 *
 * @version v0.4.1
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRevalidator, useBlocker } from "react-router";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { userContext } from "../context";
import { IIIFViewer, type PinMode } from "../components/viewer/iiif-viewer";
import { ViewerToolbar } from "../components/viewer/viewer-toolbar";
import { ViewerTopBar } from "../components/viewer/viewer-top-bar";
import { OutlinePanel } from "../components/outline/outline-panel";
import { ResizableDivider } from "../components/outline/resizable-divider";
import { FlagQcDialog } from "../components/qc-flags/flag-qc-dialog";
import { type QcFlagCardData } from "../components/qc-flags/qc-flag-card";
import { QCFlagCardExpandable } from "../components/qc-flags/qc-flag-card-expandable";
import { ResolveQcFlagDialog } from "../components/qc-flags/resolve-qc-flag-dialog";
import { FlagResegmentationDialog } from "../components/assignments/flag-resegmentation-dialog";
import { computeAllRefCodes } from "../lib/reference-codes";
import { boundaryReducer, createInitialState } from "../lib/boundary-reducer";
import { useUndoableReducer, type UndoRedoAction } from "../lib/use-undoable-reducer";
import { useAutosave } from "../lib/use-autosave";
import { shouldBlockNavigation } from "../lib/blocker-condition";
import {
  shouldSendBeacon,
  buildEntriesBeaconBody,
} from "../lib/beacon-save";
import { UnsavedChangesDialog } from "../components/viewer/unsaved-changes-dialog";
import { findCurrentEntry } from "../lib/entry-ownership";
import { partitionComments } from "../lib/comment-partition";
import type { BoundaryAction } from "../lib/boundary-types";
import type { Route } from "./+types/_auth.viewer.$projectId.$volumeId";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { inArray } = await import("drizzle-orm");
  const { requireProjectRole, requireVolumeAccess } = await import("../lib/permissions.server");
  const { loadEntries } = await import("../lib/entries.server");
  const { getCommentsForVolume } = await import("../lib/comments.server");
  const { getOpenQcFlags } = await import("../lib/qc-flags.server");
  const { getOpenFlags: getOpenResegFlags } = await import(
 "../lib/resegmentation.server"
  );
  const { volumes, volumePages, users, projects } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Any project member can access the viewer (access level determined by role + assignment)
  const memberships = await requireProjectRole(
 db, user.id, params.projectId,
 ["lead", "cataloguer", "reviewer"],
 user.isAdmin
  );

  // Fetch volume, verify it belongs to this project
  const volume = await db
 .select()
 .from(volumes)
 .where(
 and(eq(volumes.id, params.volumeId), eq(volumes.projectId, params.projectId))
 )
 .get();

  if (!volume) {
 throw new Response("Volume not found", { status: 404 });
  }

  // post-Wave-2: fetch the owning project's `settings` blob
  // so the outline's two-step type picker can surface the per-project
  // Colombian Spanish document subtype list. Scoped to the settings
  // column only -- we never leak the full project row into the viewer
  // bundle.
  const projectRow = await db
 .select({ settings: projects.settings })
 .from(projects)
 .where(eq(projects.id, params.projectId))
 .get();
  const { getDocumentSubtypes } = await import("../lib/project-settings");
  const documentSubtypes = getDocumentSubtypes(projectRow?.settings ?? null);

  // Determine user's role on this project (highest privilege: lead > reviewer > cataloguer)
  const roleOrder = ["lead", "reviewer", "cataloguer"] as const;
  const userRole = memberships.length > 0
 ? roleOrder.find((r) => memberships.some((m) => m.role === r)) ?? "cataloguer"
 : "cataloguer";

  // Determine access level (edit, review, readonly)
  const accessLevel = requireVolumeAccess(user.id, volume, userRole, user.isAdmin);

  // Fetch pages with dimensions for virtualised viewer. we
  // additionally select `id` because per-page QC flag badges and the
  // flag-raise dialog need the volume_pages primary key to target flags
  // to a stable row (a page's position can change under resegmentation).
  const pages = await db
 .select({
 id: volumePages.id,
 position: volumePages.position,
 label: volumePages.label,
 imageUrl: volumePages.imageUrl,
 width: volumePages.width,
 height: volumePages.height,
 })
 .from(volumePages)
 .where(eq(volumePages.volumeId, params.volumeId))
 .orderBy(volumePages.position)
 .all();

  // Load entries for boundary state
  const entries = await loadEntries(db, params.volumeId);

  // Load comments for the volume. extends the
  // partition loop with two new buckets:
  // - commentsByQcFlag: feeds QCFlagCardExpandable
  // - regionsByPage: feeds RegionPinOverlay 
  // The existing commentsByEntry / commentsByPage keys stay intact so
  // (outline restyle) and the page-comment paths
  // don't regress.
  const rawComments = await getCommentsForVolume(db, params.volumeId);
  // : the partition logic lives in
  // app/lib/comment-partition.ts so the loader stays IO-bound and the
  // outline + viewer shape is unit-testable without a Cloudflare
  // runtime. Produces the existing commentsByEntry / commentsByPage /
  // commentsByQcFlag / regionsByPage buckets plus the two new per-entry
  // count maps that drive the entry-delete warning copy.
  const {
 commentsByEntry,
 commentsByPage,
 commentsByQcFlag,
 regionsByPage,
 commentCountByEntry_attached,
 commentCountByEntry_anchored,
  } = partitionComments(rawComments, pages, entries);

  // Alias preserved for existing outline-panel / outline-entry callers
  // that expect `commentsMap` keyed by entryId. Page-level rendering in
  // the viewer proper lands in .
  const commentsMap = commentsByEntry;

  // per-page open-QC-flag counts drive the FlagBadge
  // overlaid on each page in the IIIF viewer.
  // additionally group the flag rows themselves by
  // pageId so the badge-click popover can list them with reporter names
  // without a second round-trip. Reporter names are denormalised here so
  // QcFlagCard renders with the display-name it expects.
  const openFlags = await getOpenQcFlags(db, params.volumeId);
  const openFlagsByPage: Record<string, number> = {};
  for (const f of openFlags) {
 openFlagsByPage[f.pageId] = (openFlagsByPage[f.pageId] ?? 0) + 1;
  }

  const reporterIds = Array.from(
 new Set(openFlags.map((f) => f.reportedBy).filter(Boolean))
  ) as string[];
  const reporterMap = new Map<string, { name: string | null; email: string }>();
  if (reporterIds.length > 0) {
 const rows = await db
 .select({ id: users.id, name: users.name, email: users.email })
 .from(users)
 .where(inArray(users.id, reporterIds))
 .all();
 for (const r of rows) reporterMap.set(r.id, { name: r.name, email: r.email });
  }

  const openFlagCardsByPage: Record<string, QcFlagCardDataForViewer[]> = {};
  for (const f of openFlags) {
 const reporter = reporterMap.get(f.reportedBy);
 const card: QcFlagCardDataForViewer = {
 id: f.id,
 pageId: f.pageId,
 problemType: f.problemType,
 description: f.description,
 status: "open",
 resolutionAction: null,
 resolverNote: null,
 reportedBy: f.reportedBy,
 reportedByName: reporter?.name ?? reporter?.email ?? f.reportedBy,
 resolvedBy: null,
 resolvedByName: null,
 resolvedAt: null,
 createdAt: f.createdAt,
 };
 (openFlagCardsByPage[f.pageId] ??= []).push(card);
  }

  // open resegmentation flags keyed by entryId.
  // At most one open flag per entry is expected; when the query
  // returns more (race condition), last-write-wins is fine -- Plan
  // 05 renders a single ResegmentationCard per entry anyway.
  // enrich each flag with reporter display name so
  // ResegmentationCard can render "{reporterName} · {reportedAt}"
  // without a second round-trip. Mirrors the QC-flag enrichment above.
  const openResegFlags = await getOpenResegFlags(db, params.volumeId);
  const resegReporterIds = Array.from(
 new Set(openResegFlags.map((f) => f.reportedBy).filter(Boolean)),
  ) as string[];
  const resegReporterMap = new Map<
 string,
 { name: string | null; email: string }
  >();
  if (resegReporterIds.length > 0) {
 const rows = await db
 .select({ id: users.id, name: users.name, email: users.email })
 .from(users)
 .where(inArray(users.id, resegReporterIds))
 .all();
 for (const r of rows) resegReporterMap.set(r.id, { name: r.name, email: r.email });
  }

  type OpenResegFlagForOutline = {
 id: string;
 entryId: string;
 reporterName: string;
 reportedAt: number;
 description: string;
  };
  const openResegFlagsByEntry: Record<string, OpenResegFlagForOutline> = {};
  for (const f of openResegFlags) {
 const r = resegReporterMap.get(f.reportedBy);
 openResegFlagsByEntry[f.entryId] = {
 id: f.id,
 entryId: f.entryId,
 reporterName: r?.name ?? r?.email ?? f.reportedBy,
 reportedAt: f.createdAt,
 description: f.description,
 };
  }

  return {
 volume,
 pages,
 entries,
 commentsMap,
 commentsByEntry,
 commentsByPage,
 commentsByQcFlag,
 regionsByPage,
 commentCountByEntry_attached,
 commentCountByEntry_anchored,
 openFlagsByPage,
 openFlagCardsByPage,
 openResegFlagsByEntry,
 projectId: params.projectId,
 accessLevel,
 userRole,
 userId: user.id,
 documentSubtypes,
  };
}

// Viewer-local alias for QcFlagCardData to avoid pulling the component
// type import into the loader (the loader file has no JSX).
type QcFlagCardDataForViewer = {
  id: string;
  pageId: string;
  problemType:
 | "damaged"
 | "repeated"
 | "out_of_order"
 | "missing"
 | "blank"
 | "other";
  description: string;
  status: "open" | "resolved" | "wontfix";
  resolutionAction: null;
  resolverNote: null;
  reportedBy: string;
  reportedByName: string;
  resolvedBy: null;
  resolvedByName: null;
  resolvedAt: null;
  createdAt: number;
};

export type PageData = {
  id: string;
  position: number;
  label: string | null;
  imageUrl: string;
  width: number;
  height: number;
};

export default function ViewerRoute({ loaderData }: Route.ComponentProps) {
  const {
 volume,
 pages,
 entries,
 commentsMap,
 commentsByQcFlag,
 regionsByPage,
 commentCountByEntry_attached,
 commentCountByEntry_anchored,
 openFlagsByPage,
 openFlagCardsByPage,
 openResegFlagsByEntry,
 projectId,
 accessLevel,
 userRole,
 userId,
 documentSubtypes,
  } = loaderData;

  // build a commentId -> pageNumber
  // lookup for region-anchored comments so the outline cards' inline
  // RegionChips can label their button "Región · p. N". The loader
  // already emits `regionsByPage` keyed by page id; invert here.
  const rawCommentsById = useMemo(() => {
 const map: Record<
 string,
 { pageId: string | null; regionY: number | null }
 > = {};
 for (const [pageId, rows] of Object.entries(regionsByPage)) {
 for (const r of rows) {
 map[r.commentId] = { pageId, regionY: r.y };
 }
 }
 return map;
  }, [regionsByPage]);
  const pageNumberByCommentId = useMemo(() => {
 const map: Record<string, number> = {};
 for (const [commentId, info] of Object.entries(rawCommentsById)) {
 if (!info.pageId) continue;
 const page = pages.find((p) => p.id === info.pageId);
 if (!page) continue;
 map[commentId] = page.position + 1;
 }
 return map;
  }, [rawCommentsById, pages]);

  // viewer-route-owned highlight ring
  // state. Set on RegionChip click, cleared ~1s later. Threaded into
  // IIIFViewer via the existing `highlightedCommentId` prop from .
  const [highlightedCommentId, setHighlightedCommentId] = useState<
 string | null
  >(null);
  const { t } = useTranslation(["qc_flags", "viewer"]);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [viewportYFraction, setViewportYFraction] = useState(0);
  const viewerRef = useRef<{
 zoomIn: () => void;
 zoomOut: () => void;
 scrollToPage: (index: number) => void;
 scrollToPosition: (pageIndex: number, yFraction: number) => void;
 getZoomPercent: () => number;
  } | null>(null);

  // flag-raise dialog state. Single dialog instance
  // rendered once at the tree root; the per-page flag button on each page
  // sets the target page here and opens the dialog.
  const [flagDialog, setFlagDialog] = useState<{
 open: boolean;
 pageId: string | null;
 pagePosition: number | null;
  }>({ open: false, pageId: null, pagePosition: null });

  // badge-click popover state. Holds the page whose
  // open flags are currently being listed in a floating panel. Clicking
  // the badge sets `pageId`; clicking "close" or any Resolve button
  // eventually clears it (Resolve goes through the resolve dialog).
  const [flagPopover, setFlagPopover] = useState<{
 pageId: string | null;
 pagePosition: number | null;
  }>({ pageId: null, pagePosition: null });

  // lead-only resolve dialog state.
  const [resolveState, setResolveState] = useState<{
 open: boolean;
 flagId: string | null;
  }>({ open: false, flagId: null });

  // cleanup: resegmentation dialog
  // state. The ResegmentationCard inside each OutlineEntry invokes
  // `onOpenResegDialog(flagId)`; we reverse-look the flag id in
  // `openResegFlagsByEntry` to find the owning entry, then render
  // `FlagResegmentationDialog` at the route level with the entry's
  // title/refCode and a neighbour list derived from its siblings.
  const [resegDialogFlagId, setResegDialogFlagId] = useState<string | null>(
 null,
  );
  const handleOpenResegDialog = useCallback((flagId: string) => {
 setResegDialogFlagId(flagId);
  }, []);
  const handleCloseResegDialog = useCallback(() => {
 setResegDialogFlagId(null);
  }, []);

  // drawing-mode + draft-region state. pinMode is the active tool; draftRegion is the in-
  // progress pin (amber-dashed until the comment submit succeeds).
  const [pinMode, setPinMode] = useState<PinMode>("off");
  const [draftRegion, setDraftRegion] = useState<{
 entryId: string;
 pageId: string;
 region: { x: number; y: number; w: number; h: number };
  } | null>(null);

  // follow-up (2026-04-18): the active inline draft comment.
  // Replaces the earlier modal promptState — every comment-creation
  // surface (entry-level Add comment, pin drop, reply) now renders as
  // an inline composer inside the outline. Cancel clears the amber pin
  // in lockstep so no region ever commits without its comment.
  const [draftCommentState, setDraftCommentState] = useState<
 import("../lib/outline-items").DraftCommentState | null
  >(null);

  // Boundary state management with undo/redo
  const { state, dispatch: rawDispatch, canUndo, canRedo } = useUndoableReducer(
 boundaryReducer,
 createInitialState(entries)
  );

  /** Actions that don't carry modifiedBy (meta/control actions). */
  const META_ACTIONS = new Set(["INIT", "MARK_SAVED", "MARK_SAVING", "MARK_DIRTY", "UNDO", "REDO"]);

  // Wrap dispatch to inject modifiedBy when the user is a reviewer
  const dispatch = useCallback(
 (action: BoundaryAction | UndoRedoAction) => {
 if (accessLevel === "review" && !META_ACTIONS.has(action.type)) {
 rawDispatch({ ...action, modifiedBy: userId } as BoundaryAction);
 } else {
 rawDispatch(action);
 }
 },
 [rawDispatch, accessLevel, userId]
  );

  const { saveStatus, flush } = useAutosave(state, rawDispatch, volume.id);
  const revalidator = useRevalidator();
  const handleCommentAdded = useCallback(() => {
 revalidator.revalidate();
  }, [revalidator]);

  // Intercepts in-app navigations (Link clicks like the back-arrow
  // in ViewerTopBar, browser back via popstate, etc.) while the
  // boundary state has unflushed work. The
  // `currentLocation.pathname !== nextLocation.pathname` guard
  // prevents the blocker from firing on search-param-only changes
  // (e.g. `?comments=` toggles).
  const blocker = useBlocker(
 ({ currentLocation, nextLocation }) =>
 shouldBlockNavigation(saveStatus, state.isDirty) &&
 currentLocation.pathname !== nextLocation.pathname,
  );

  // The blocker's confirmation is a Tailwind/i18n-driven
  // `<UnsavedChangesDialog>` rendered at the bottom of the route's
  // JSX tree, controlled by `blocker.state === "blocked"`. The
  // handlers below close over `volume.id`, `state.entries`, and
  // `blocker` so the sendBeacon flush semantics are preserved
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
      const body = buildEntriesBeaconBody(volume.id, state.entries);
      // FormData size is not directly observable in all runtimes;
      // conservatively estimate via the serialised JSON length (a
      // reasonable upper bound on the payload's entries field, which
      // dominates the body).
      const approxSize = JSON.stringify(state.entries).length;
      if (shouldSendBeacon(approxSize)) {
        navigator.sendBeacon("/api/entries/save", body);
      }
    }
    blocker.proceed();
  }, [blocker, volume.id, state.entries]);

  // clear draftRegion once the revalidator settles
  // after a successful comment POST (best-effort: a draft that fails
  // to submit also clears, but the user sees the server error first).
  const prevStateRef = useRef(revalidator.state);
  useEffect(() => {
 if (
 prevStateRef.current !== "idle" &&
 revalidator.state === "idle" &&
 draftRegion
 ) {
 setDraftRegion(null);
 }
 prevStateRef.current = revalidator.state;
  }, [revalidator.state, draftRegion]);

  // Compute the set of reviewer-modified entry IDs
  const reviewerModifiedIds = useMemo(() => {
 const ids = new Set<string>();
 for (const entry of state.entries) {
 if (entry.modifiedBy !== null && entry.modifiedBy !== volume.assignedTo) {
 ids.add(entry.id);
 }
 }
 return ids;
  }, [state.entries, volume.assignedTo]);

  // Undo/redo keyboard shortcuts
  useEffect(() => {
 function handleKeyDown(e: KeyboardEvent) {
 const mod = e.metaKey || e.ctrlKey;
 if (!mod) return;

 if (e.key === "z" && !e.shiftKey) {
 e.preventDefault();
 dispatch({ type: "UNDO" });
 } else if (e.key === "z" && e.shiftKey) {
 e.preventDefault();
 dispatch({ type: "REDO" });
 } else if (e.key === "y" && !e.metaKey) {
 // Ctrl+Y only (not Cmd+Y on macOS)
 e.preventDefault();
 dispatch({ type: "REDO" });
 }
 }
 window.addEventListener("keydown", handleKeyDown);
 return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dispatch]);

  // Cmd/Ctrl+S — manual save escape hatch. Routes the platform
  // save shortcut to the autosave
  // hook's exposed `flush()` instead of letting the browser
  // surface its native "save page" dialog. `preventDefault()` is
  // essential: without it the browser dialog fires. Listening on
  // `window` (not `document`) covers focus-in-iframe cases. The
  // handler lives in its own effect — separate from the undo/redo
  // shortcuts above — so each shortcut's dep array can be tight
  // and the handlers do not interfere with each other's
  // preventDefault timing. `e.key.toLowerCase()` is defensive
  // against platforms that report Shift-modified keys as
  // capitalised under Cmd/Ctrl modifier combinations.
  useEffect(() => {
 const onSaveKey = (e: KeyboardEvent) => {
 if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s")) return;
 e.preventDefault();
 // Fire-and-forget: the SaveStatus pill drives the UI via
 // the hook's MARK_SAVING / MARK_SAVED / MARK_ERROR
 // transitions. `void` here keeps any aborted-result from
 // surfacing as an unhandled promise rejection.
 void flush();
 };
 window.addEventListener("keydown", onSaveKey);
 return () => window.removeEventListener("keydown", onSaveKey);
  }, [flush]);

  // Stable click handler for the Save now button rendered by
  // `ViewerTopBar` next to the SaveStatus pill. Same fire-and-forget
  // contract as the Cmd/Ctrl+S handler above — the pill drives the
  // UI via the hook's reducer transitions.
  const handleSaveNow = useCallback(() => {
 void flush();
  }, [flush]);

  const handlePageChange = useCallback((pageIndex: number) => {
 setCurrentPageIndex(pageIndex);
  }, []);

  const handlePlaceBoundary = useCallback((startPage: number, startY: number) => {
 dispatch({ type: "ADD_BOUNDARY", startPage, startY });
  }, [dispatch]);

  const handleMoveBoundary = useCallback((entryId: string, startPage: number, startY: number) => {
 dispatch({ type: "MOVE_BOUNDARY", entryId, startPage, toY: startY });
  }, [dispatch]);

  const handleDeleteBoundary = useCallback((entryId: string) => {
 dispatch({ type: "DELETE_BOUNDARY", entryId });
  }, [dispatch]);

  const handleZoomIn = useCallback(() => {
 viewerRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
 viewerRef.current?.zoomOut();
  }, []);

  const handleUndo = useCallback(() => {
 dispatch({ type: "UNDO" });
  }, [dispatch]);

  const handleRedo = useCallback(() => {
 dispatch({ type: "REDO" });
  }, [dispatch]);

  /**
 * / called when the user drops
 * a region pin in drawing mode. Resolve the owning entry via
 * findCurrentEntry, set draftRegion, and write ?comments=entry:<id>
 * so the outline panel () can auto-expand the card.
 *
 * 2026-04-18 cleanup: the flag-dialog draw-new branch was
 * removed alongside "Vincular a región" -- this handler now has a
 * single role (entry-card draft region flow).
 */
  const handleRegionPlace = useCallback(
 ({
 pageId,
 region,
 }: {
 pageId: string;
 region: { x: number; y: number; w: number; h: number };
 }) => {
 const page = pages.find((p) => p.id === pageId);
 if (!page) return;

 // Resolve owning entry. findCurrentEntry expects a
 // 1-based page number; page.position is 0-based in the outline,
 // so we add 1 to match.
 const owningEntryId = findCurrentEntry(
 state.entries,
 page.position + 1,
 region.y,
 pages.length,
 );
 if (!owningEntryId) {
 // No entry covers this (page, y). Toast wiring is a known
 // follow-up; for now the pin drop is a no-op outside any
 // entry's span.
 console.warn(
 `No owning entry for pin at page ${page.position}, y ${region.y}`,
 );
 return;
 }
 // follow-up: hold the draft pin amber AND surface an
 // inline draft-comment row under the owning entry. Cancel clears
 // both pieces of state together.
 setDraftRegion({ entryId: owningEntryId, pageId, region });
 setDraftCommentState({
 entryId: owningEntryId,
 region: {
 pageId,
 pageLabel: page.label ?? String(page.position + 1),
 region,
 },
 });
 },
 [pages, state.entries],
  );

  const handleOpenEntryCommentPrompt = useCallback(
 (entryId: string) => {
 setDraftCommentState({ entryId, region: null });
 },
 [],
  );

  const handleCancelDraft = useCallback(() => {
 setDraftCommentState(null);
 setDraftRegion(null);
  }, []);

  const handleDraftCreated = useCallback(() => {
 revalidator.revalidate();
 setDraftCommentState(null);
 setDraftRegion(null);
  }, [revalidator]);

  const handleDraftCancel = useCallback(() => {
 setDraftRegion(null);
  }, []);

  // Resizable panel width
  const MIN_PANEL = 280;
  const MAX_PANEL = 720;
  const [panelWidth, setPanelWidth] = useState(480);

  const handleResize = useCallback((deltaX: number) => {
 setPanelWidth((w) => Math.min(MAX_PANEL, Math.max(MIN_PANEL, w + deltaX)));
  }, []);

  const currentPage = pages[currentPageIndex];

  // zoom percent read-through from the
  // IIIFViewer's imperative handle so the toolbar can render "75%".
  // A render-time poll is good enough for the non-urgent display.
  const [zoomPercent, setZoomPercent] = useState(75);
  useEffect(() => {
 const interval = setInterval(() => {
 const p = viewerRef.current?.getZoomPercent?.();
 if (typeof p === "number") {
 setZoomPercent((prev) => (p !== prev ? p : prev));
 }
 }, 200);
 return () => clearInterval(interval);
  }, []); // stable interval -- functional setter keeps the compare local

  const handleToggleFullscreen = useCallback(() => {
 if (typeof document === "undefined") return;
 if (document.fullscreenElement) {
 document.exitFullscreen?.();
 } else {
 document.documentElement.requestFullscreen?.();
 }
  }, []);

  // Cleanup 2026-04-18: `handleOpenRaiseFlagFromToolbar` was removed
  // alongside the toolbar "Marcar problema" button. The per-image
  // `onFlagClick` callback on IIIFViewer is now the single entry
  // point into the RaiseFlagDialog.

  // RegionChip click handler. Look
  // up the comment's pageId in the inverted regionsByPage map, scroll
  // the viewer to that page (yFraction = regionY), then highlight the
  // pin for ~1s before clearing so the user can find it on a busy page.
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScrollToRegion = useCallback(
 (commentId: string) => {
 const info = rawCommentsById[commentId];
 if (!info || !info.pageId) return;
 const page = pages.find((p) => p.id === info.pageId);
 if (!page) return;
 viewerRef.current?.scrollToPosition(page.position, info.regionY ?? 0);
 setHighlightedCommentId(commentId);
 if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
 highlightTimerRef.current = setTimeout(() => {
 setHighlightedCommentId(null);
 }, 1000);
 },
 [rawCommentsById, pages],
  );
  useEffect(() => {
 return () => {
 if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
 };
  }, []);

  // On drag-release, PATCH the comment's region coords
  // and revalidate so the pin settles at the server-confirmed position.
  // The overlay clamps coords in-bounds; the server re-validates and
  // enforces the author-only gate. Errors surface via a console warn
  // for now (toast wiring is a known follow-up) — the revalidator
  // still runs so the pin snaps back to its previous position if the
  // PATCH is rejected.
  const handlePinMove = useCallback(
 async (
 commentId: string,
 region: { x: number; y: number; w: number; h: number },
 ) => {
 const isBox = region.w > 0 && region.h > 0;
 const body = isBox
 ? {
 regionX: region.x,
 regionY: region.y,
 regionW: region.w,
 regionH: region.h,
 }
 : { regionX: region.x, regionY: region.y };
 try {
 const res = await fetch(`/api/comments/${commentId}`, {
 method: "PATCH",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify(body),
 });
 if (!res.ok) {
 const err = (await res.json().catch(() => ({}))) as { error?: string };
 console.warn("[pin-move] PATCH failed", res.status, err.error);
 }
 } catch (err) {
 console.warn("[pin-move] network error", err);
 } finally {
 revalidator.revalidate();
 }
 },
 [revalidator],
  );

  // edit, delete, resolve handlers wired to
  // the new endpoints. All three use the same pattern as handlePinMove:
  // fetch with JSON body, log a console.warn on failure (toast wiring
  // is a separate follow-up tracked in the plan), revalidate in finally
  // so the outline reflects server truth on both success and failure.
  const handleCommentEdit = useCallback(
 async (commentId: string, newText: string) => {
 try {
 const res = await fetch(`/api/comments/${commentId}`, {
 method: "PATCH",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({ body: newText }),
 });
 if (!res.ok) {
 const err = (await res.json().catch(() => ({}))) as { error?: string };
 console.warn("[comment-edit] PATCH failed", res.status, err.error);
 }
 } catch (err) {
 console.warn("[comment-edit] network error", err);
 } finally {
 revalidator.revalidate();
 }
 },
 [revalidator],
  );

  const handleCommentDelete = useCallback(
 async (commentId: string) => {
 try {
 const res = await fetch(`/api/comments/${commentId}`, {
 method: "DELETE",
 });
 if (!res.ok) {
 const err = (await res.json().catch(() => ({}))) as { error?: string };
 console.warn("[comment-delete] DELETE failed", res.status, err.error);
 }
 } catch (err) {
 console.warn("[comment-delete] network error", err);
 } finally {
 revalidator.revalidate();
 }
 },
 [revalidator],
  );

  const handleCommentResolve = useCallback(
 async (commentId: string, resolved: boolean) => {
 try {
 const res = await fetch(`/api/comments/${commentId}/resolve`, {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({ resolved }),
 });
 if (!res.ok) {
 const err = (await res.json().catch(() => ({}))) as { error?: string };
 console.warn("[comment-resolve] POST failed", res.status, err.error);
 }
 } catch (err) {
 console.warn("[comment-resolve] network error", err);
 } finally {
 revalidator.revalidate();
 }
 },
 [revalidator],
  );

  return (
 <div className="flex h-full flex-col">
 <ViewerTopBar
 volumeName={volume.name}
 projectId={projectId}
 saveStatus={saveStatus}
 canUndo={canUndo}
 canRedo={canRedo}
 onUndo={handleUndo}
 onRedo={handleRedo}
 onSaveNow={handleSaveNow}
 />
 <div className="flex flex-1 overflow-hidden">
 {/* Viewer panel */}
 <div className="relative flex flex-1 flex-col overflow-hidden">
 <ViewerToolbar
 zoomPercent={zoomPercent}
 onZoomIn={handleZoomIn}
 onZoomOut={handleZoomOut}
 pinMode={pinMode}
 onPinModeChange={setPinMode}
 onToggleFullscreen={handleToggleFullscreen}
 accessLevel={accessLevel}
 />
 <IIIFViewer
 pages={pages}
 onPageChange={handlePageChange}
 ref={viewerRef}
 boundaries={state.entries}
 onPlaceBoundary={accessLevel !== "readonly" ? handlePlaceBoundary : undefined}
 onDeleteBoundary={accessLevel !== "readonly" ? handleDeleteBoundary : undefined}
 onMoveBoundary={accessLevel !== "readonly" ? handleMoveBoundary : undefined}
 reviewerModifiedIds={reviewerModifiedIds}
 onYFractionChange={setViewportYFraction}
 openFlagsByPage={openFlagsByPage}
 onFlagClick={
 accessLevel !== "readonly"
 ? ({ pageId, pagePosition }) =>
 setFlagDialog({ open: true, pageId, pagePosition })
 : undefined
 }
 onFlagBadgeClick={(pageId) => {
 const page = pages.find((p) => p.id === pageId);
 if (!page) return;
 setFlagPopover({ pageId, pagePosition: page.position });
 }}
 pinMode={pinMode}
 onRegionPlace={
 accessLevel !== "readonly" ? handleRegionPlace : undefined
 }
 draftPin={
 draftRegion
 ? { pageId: draftRegion.pageId, region: draftRegion.region }
 : null
 }
 regionsByPage={regionsByPage}
 onDraftCancel={handleDraftCancel}
 highlightedCommentId={highlightedCommentId}
 onRegionPinClick={handleScrollToRegion}
 moveMode={pinMode === "move"}
 currentUserId={userId}
 onPinMove={accessLevel !== "readonly" ? handlePinMove : undefined}
 notAuthorTooltip={t("viewer:move_tool.not_author", {
 defaultValue: "Solo puedes mover tus propias anotaciones.",
 })}
 />
 </div>

 {/* Resizable divider */}
 <ResizableDivider onResize={handleResize} />

 {/* Outline panel */}
 <div className="shrink-0 h-full" style={{ width: panelWidth }}>
 <OutlinePanel
 entries={state.entries}
 volumeRefCode={volume.referenceCode}
 currentPageIndex={currentPageIndex}
 totalPages={pages.length}
 onScrollToEntry={(pageIndex, yFraction) => viewerRef.current?.scrollToPosition(pageIndex, yFraction)}
 dispatch={dispatch}
 accessLevel={accessLevel}
 assignedTo={volume.assignedTo}
 volumeStatus={volume.status}
 volumeId={volume.id}
 volumeName={volume.name}
 projectId={projectId}
 reviewComment={volume.reviewComment}
 viewportYFraction={viewportYFraction}
 commentsMap={commentsMap}
 onCommentAdded={handleCommentAdded}
 openResegFlagsByEntry={openResegFlagsByEntry}
 draftRegion={draftRegion}
 onScrollToRegion={handleScrollToRegion}
 pageNumberByCommentId={pageNumberByCommentId}
 onOpenResegDialog={handleOpenResegDialog}
 documentSubtypes={documentSubtypes}
 onOpenEntryCommentPrompt={handleOpenEntryCommentPrompt}
 commentCountByEntry_attached={commentCountByEntry_attached}
 commentCountByEntry_anchored={commentCountByEntry_anchored}
 draftCommentState={draftCommentState}
 onCancelDraft={handleCancelDraft}
 onDraftCreated={handleDraftCreated}
 currentUserId={userId}
 currentUserIsLead={userRole === "lead"}
 onEditComment={
 accessLevel !== "readonly" ? handleCommentEdit : undefined
 }
 onDeleteComment={
 accessLevel !== "readonly" ? handleCommentDelete : undefined
 }
 onResolveComment={
 accessLevel !== "readonly" ? handleCommentResolve : undefined
 }
 />
 </div>
 </div>
 {/*
 * single dialog instance
 * shared by all pages. `handleCommentAdded` is reused as the
 * revalidation callback -- both a new comment and a new QC
 * flag require the loader to re-run so the outline panel and
 * per-page badges stay in sync. 2026-04-18 cleanup:
 * "Vincular a región" props removed -- QC flags are image-level
 * by definition (see app/components/qc-flags/flag-qc-dialog.tsx
 * header note).
 */}
 {flagDialog.open &&
 flagDialog.pageId !== null &&
 flagDialog.pagePosition !== null && (
 <FlagQcDialog
 open={flagDialog.open}
 onClose={() => {
 setFlagDialog({
 open: false,
 pageId: null,
 pagePosition: null,
 });
 }}
 volumeId={volume.id}
 pageId={flagDialog.pageId}
 pagePosition={flagDialog.pagePosition}
 initialPageId={flagDialog.pageId}
 onCreated={() => {
 handleCommentAdded();
 }}
 />
 )}
 {/*
 * page-level flag popover now renders
 * QCFlagCardExpandable so each card has an inline "Comentarios
 * (N)" toggle that reveals a CommentThread bound to the flag's
 * qcFlagId. Lead-only Resolver button still flows through.
 */}
 {flagPopover.pageId !== null &&
 flagPopover.pagePosition !== null && (
 <div
 className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-8"
 onClick={() =>
 setFlagPopover({ pageId: null, pagePosition: null })
 }
 >
 <div
 className="mt-20 max-h-[80vh] w-full max-w-[520px] overflow-y-auto rounded-xl bg-white p-5 shadow-lg"
 onClick={(e) => e.stopPropagation()}
 >
 <div className="mb-4 flex items-center justify-between">
 <h2 className="font-display text-xl font-semibold text-stone-800">
 {t("qc_flags:dialog.page_label", {
 position: flagPopover.pagePosition,
 })}
 </h2>
 <button
 type="button"
 aria-label={t("qc_flags:dialog.cancel")}
 onClick={() =>
 setFlagPopover({ pageId: null, pagePosition: null })
 }
 className="text-stone-400 hover:text-stone-600"
 >
 <X className="h-5 w-5" />
 </button>
 </div>
 <div className="space-y-3">
 {(
 openFlagCardsByPage[flagPopover.pageId] as
 | QcFlagCardData[]
 | undefined
 )?.map((flag) => (
 <QCFlagCardExpandable
 key={flag.id}
 flag={flag}
 volumeId={volume.id}
 comments={commentsByQcFlag?.[flag.id] ?? []}
 userRole={userRole}
 onResolveClick={
 userRole === "lead"
 ? () =>
 setResolveState({
 open: true,
 flagId: flag.id,
 })
 : undefined
 }
 onCommentAdded={handleCommentAdded}
 />
 ))}
 {(openFlagCardsByPage[flagPopover.pageId] ?? []).length ===
 0 && (
 <p className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-400">
 {t("qc_flags:badge.no_flags")}
 </p>
 )}
 </div>
 </div>
 </div>
 )}
 {/* Shared resolve dialog (leads only). */}
 {resolveState.open && resolveState.flagId && (
 <ResolveQcFlagDialog
 open={resolveState.open}
 flagId={resolveState.flagId}
 userRole={userRole}
 onClose={() => setResolveState({ open: false, flagId: null })}
 onResolved={() => {
 setResolveState({ open: false, flagId: null });
 setFlagPopover({ pageId: null, pagePosition: null });
 revalidator.revalidate();
 }}
 />
 )}
 {/*
 * cleanup: resegmentation
 * dialog. Opens when a ResegmentationCard's CTA fires
 * `handleOpenResegDialog(flagId)`. We reverse-look the flag id
 * in `openResegFlagsByEntry` to find the owning entry, compute
 * refCodes so the dialog can label the entry in the user's own
 * language, and pass the entry's siblings as neighbours so the
 * cataloguer can tick the adjacent entries that should also be
 * considered affected. Uses the existing * FlagResegmentationDialog unchanged.
 */}
 {resegDialogFlagId && (() => {
 // Reverse-lookup: find the entry whose open flag has this id.
 let targetEntryId: string | null = null;
 for (const [entryId, flag] of Object.entries(openResegFlagsByEntry)) {
 if (flag.id === resegDialogFlagId) {
 targetEntryId = entryId;
 break;
 }
 }
 if (!targetEntryId) return null;
 const targetEntry = state.entries.find((e) => e.id === targetEntryId);
 if (!targetEntry) return null;
 const refCodeMap = computeAllRefCodes(
 state.entries,
 volume.referenceCode,
 );
 const entryRefCode = refCodeMap.get(targetEntry.id) ?? null;
 // Neighbours = siblings (same parentId) other than the target
 // itself, sorted by position. Keeps the dialog's "entradas
 // afectadas" list focused on the contiguous cluster rather
 // than the entire volume.
 const neighbours = state.entries
 .filter(
 (e) =>
 e.parentId === targetEntry.parentId && e.id !== targetEntry.id,
 )
 .sort((a, b) => a.position - b.position)
 .map((e) => ({
 id: e.id,
 position: e.position,
 title: e.title,
 }));
 return (
 <FlagResegmentationDialog
 open={true}
 onClose={handleCloseResegDialog}
 entryId={targetEntry.id}
 entryTitle={targetEntry.title ?? ""}
 entryRefCode={entryRefCode}
 volumeId={volume.id}
 volumeTitle={volume.name}
 volumeRefCode={volume.referenceCode}
 neighbours={neighbours}
 />
 );
 })()}
 {/* In-app unsaved-changes dialog. Renders when `useBlocker` has
     intercepted a dirty navigation. Stay → blocker.reset();
     Leave → sendBeacon flush + blocker.proceed(). Stay is the safe
     default (autoFocus + Escape + backdrop + X all route through
     onStay). */}
 <UnsavedChangesDialog
 open={blocker.state === "blocked"}
 titleLabel={t("viewer:save_status.unsaved_dialog_title")}
 bodyLabel={t("viewer:save_status.unsaved_dialog_body")}
 stayLabel={t("viewer:save_status.unsaved_dialog_stay")}
 leaveLabel={t("viewer:save_status.unsaved_dialog_leave")}
 onStay={handleUnsavedStay}
 onLeave={handleUnsavedLeave}
 />
 </div>
  );
}

