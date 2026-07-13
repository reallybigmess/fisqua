/**
 * IIIF Viewer
 *
 * This component is the virtualised, zoom-aware strip-scroller that
 * renders a volume's pages from a IIIF image service. Lets the cataloguer
 * zoom and scroll through hundreds of pages without loading every tile,
 * exposes handles for programmatic scroll, and hosts the comment
 * region-pin overlay when comments exist.
 *
 * @version v0.3.1
 */
import {
  useRef,
  useEffect,
  useState,
  useMemo,
  useImperativeHandle,
  useCallback,
  forwardRef,
} from "react";
import { useTranslation } from "react-i18next";
import type { PageData } from "../../routes/_auth.viewer.$projectId.$volumeId";
import type { Entry } from "../../lib/boundary-types";
import { pointerToPagePosition, useAutoScroll } from "../../lib/drag-utils";
import type { PagePosition } from "../../lib/drag-utils";
import { MIN_Y_GAP } from "../../lib/boundary-reducer";
import { BoundaryMarker } from "./boundary-marker";
import { DragOverlay } from "./drag-overlay";
import { PageGap } from "./page-gap";
import { Flag } from "lucide-react";
import { FlagBadge } from "./flag-badge";
import {
  RegionPinOverlay,
  type RegionPin,
} from "../comments/region-pin-overlay";

// How many pages above/below the viewport to pre-render
const BUFFER_PAGES = 2;
const PAGE_GAP = 48; // px between pages (generous visual separation; also gives boundary markers their hit area)
const DEFAULT_ZOOM = 0.75;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
/**
 * Minimum normalised box edge length to count as a real box pin. A
 * pointerdown followed by a pointerup at the same point -- or a tiny
 * drag that never left the hit threshold -- flattens into a single
 * point, which we drop on the floor so the user doesn't land an
 * accidental zero-size box.
 */
const MIN_BOX_EDGE = 0.01;

export type PinMode = "off" | "point" | "box" | "move";

/**
 * Pure helper: turn a click event + pinMode into either a boundary
 * placement or a region placement intent. Exported so the * pin-mode tests can exercise the branching without mounting a DOM
 * harness. The render body below calls this exact function; divergence
 * between helper and render body is a grep miss.
 */
export function routePageClick(
  pinMode: PinMode,
  args: { xNorm: number; yNorm: number },
):
  | { kind: "boundary" }
  | {
 kind: "region";
 region: { x: number; y: number; w: number; h: number };
 } {
  if (pinMode === "point") {
 return {
 kind: "region",
 region: { x: args.xNorm, y: args.yNorm, w: 0, h: 0 },
 };
  }
  // Box pinMode handled by pointerdown/move/up; a raw click in box mode
  // is ignored by the render body (click is suppressed in favour of the
  // full drag gesture).
  return { kind: "boundary" };
}

/**
 * Pure helper: compute a normalised box region from a pointerdown-
 * pointerup pair. Returns null when either edge is below MIN_BOX_EDGE
 *. x/y always snap to the top-left of the box
 * regardless of drag direction.
 */
export function computeBoxRegion(
  start: { x: number; y: number },
  end: { x: number; y: number },
): { x: number; y: number; w: number; h: number } | null {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x);
  const h = Math.abs(end.y - start.y);
  if (w < MIN_BOX_EDGE || h < MIN_BOX_EDGE) return null;
  return { x, y, w, h };
}

type IIIFViewerProps = {
  pages: PageData[];
  onPageChange?: (pageIndex: number) => void;
  boundaries?: Entry[];
  onPlaceBoundary?: (startPage: number, startY: number) => void;
  onDeleteBoundary?: (entryId: string) => void;
  onMoveBoundary?: (entryId: string, startPage: number, startY: number) => void;
  /** Set of entry IDs that were modified by a reviewer (rendered with red variant). */
  reviewerModifiedIds?: Set<string>;
  /** Called with the viewport's Y-fraction (0-1) within the current page, debounced at 150ms. */
  onYFractionChange?: (yFraction: number) => void;
  /**
 * per-page open-QC-flag counts drive the
 * FlagBadge overlaid on each page. Keyed by `volume_pages.id`;
 * zero or missing hides the badge.
 */
  openFlagsByPage?: Record<string, number>;
  /**
 * invoked when the cataloguer clicks the per-page flag-raise
 * button. The parent opens `FlagQcDialog` pre-filled with the supplied
 * page identity. Undefined hides the button entirely (read-only viewer).
 */
  onFlagClick?: (args: { pageId: string; pagePosition: number }) => void;
  /**
 * invoked when the user clicks the FlagBadge.
 * The parent opens the per-page QCFlagCardExpandable popover.
 */
  onFlagBadgeClick?: (pageId: string) => void;
  /**
 * drawing-mode state. When set to "point" or
 * "box", page-image clicks / drags produce region pins instead of
 * boundary placements. Defaults to "off" for back-compat.
 */
  pinMode?: PinMode;
  /**
 * fired when the user drops a region pin. The
 * parent resolves the owning entry via `findCurrentEntry` and sets its `draftRegion` state.
 */
  onRegionPlace?: (args: {
 pageId: string;
 region: { x: number; y: number; w: number; h: number };
  }) => void;
  /**
 * the uncommitted draft pin rendered in amber-
 * dashed style above every other page overlay while the user
 * composes a comment. Cleared by the parent on submit
 * success OR Escape.
 */
  draftPin?: {
 pageId: string;
 region: { x: number; y: number; w: number; h: number };
  } | null;
  /**
 * committed region-anchored comments keyed by
 * page id, rendered via `RegionPinOverlay` per page.
 */
  regionsByPage?: Record<
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
  /**
 * `commentId` of a pin that should flash with
 * the highlight ring (typically driven by RegionChip click in the
 * outline panel,).
 */
  highlightedCommentId?: string | null;
  /**
 * fired when the user clicks a committed region
 * pin. Typically drives a URL-param change (?comments=region:<id>).
 */
  onRegionPinClick?: (commentId: string) => void;
  /**
 * called when the user presses Escape while a
 * draft pin is present, so the parent can clear its `draftRegion`
 * state (O-01).
 */
  onDraftCancel?: () => void;
  /**
 * viewer is in the per-pin move mode.
 * Forwarded to RegionPinOverlay — the overlay handles per-pin
 * author-gated draggability and fires `onPinMove` on release.
 */
  moveMode?: boolean;
  /** Current user's id, threaded to RegionPinOverlay for move-mode gating. */
  currentUserId?: string | null;
  /** Fires on drag-release with the new (clamped) region coords. */
  onPinMove?: (
 commentId: string,
 region: { x: number; y: number; w: number; h: number },
  ) => void;
  /** Tooltip on non-author pins in move mode (parent supplies i18n). */
  notAuthorTooltip?: string;
};

export type IIIFViewerHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  scrollToPage: (index: number) => void;
  scrollToPosition: (pageIndex: number, yFraction: number) => void;
  getZoomPercent: () => number;
};

function loadScript(src: string): Promise<void> {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
 const script = document.createElement("script");
 script.src = src;
 script.onload = () => resolve();
 script.onerror = () => {
 // Remove the failed tag: the existing-element check above would
 // otherwise resolve immediately on retry without OSD present.
 script.remove();
 reject(new Error(`Failed to load script: ${src}`));
 };
 document.head.appendChild(script);
  });
}

type PageLayout = { top: number; displayHeight: number; scale: number };

function computeLayouts(pages: PageData[], containerWidth: number, zoom: number): PageLayout[] {
  let offset = 0;
  return pages.map((page) => {
 const scale = (containerWidth * zoom) / page.width;
 const displayHeight = page.height * scale;
 const top = offset;
 offset += displayHeight + PAGE_GAP;
 return { top, displayHeight, scale };
  });
}

export const IIIFViewer = forwardRef<IIIFViewerHandle, IIIFViewerProps>(
  function IIIFViewer(
 {
 pages,
 onPageChange,
 boundaries,
 onPlaceBoundary,
 onDeleteBoundary,
 onMoveBoundary,
 reviewerModifiedIds,
 onYFractionChange,
 openFlagsByPage,
 onFlagClick,
 onFlagBadgeClick,
 pinMode = "off",
 onRegionPlace,
 draftPin,
 regionsByPage,
 highlightedCommentId,
 onRegionPinClick,
 onDraftCancel,
 moveMode,
 currentUserId,
 onPinMove,
 notAuthorTooltip,
 },
 ref,
  ) {
 const { t } = useTranslation(["qc_flags", "viewer"]);
 const scrollRef = useRef<HTMLDivElement>(null);
 const [zoom, setZoom] = useState(DEFAULT_ZOOM);
 const [visibleRange, setVisibleRange] = useState({ start: 0, end: 5 });
 const [containerWidth, setContainerWidth] = useState(800);
 const [osdReady, setOsdReady] = useState(false);
 const [osdError, setOsdError] = useState(false);
 const osdInstancesRef = useRef<Map<number, any>>(new Map());
 const lastPageIndexRef = useRef(0);
 const onPageChangeRef = useRef(onPageChange);
 onPageChangeRef.current = onPageChange;
 const onYFractionChangeRef = useRef(onYFractionChange);
 onYFractionChangeRef.current = onYFractionChange;
 const yFractionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

 // Hover preview state: y-pixel position in absolute coordinates (null = not hovering)
 const [hoverPreviewTop, setHoverPreviewTop] = useState<number | null>(null);

 // Drag state for boundary drag-to-move
 const [dragState, setDragState] = useState<{
 entryId: string | null;
 ghostTop: number | null;
 isInvalid: boolean;
 }>({ entryId: null, ghostTop: null, isInvalid: false });

 // Auto-scroll during drag
 const { startAutoScroll, stopAutoScroll } = useAutoScroll(scrollRef);

 // Store boundary callbacks in refs to avoid recreating scroll handler
 const onPlaceBoundaryRef = useRef(onPlaceBoundary);
 onPlaceBoundaryRef.current = onPlaceBoundary;
 const onDeleteBoundaryRef = useRef(onDeleteBoundary);
 onDeleteBoundaryRef.current = onDeleteBoundary;
 const onMoveBoundaryRef = useRef(onMoveBoundary);
 onMoveBoundaryRef.current = onMoveBoundary;

 // refs for the drawing-mode callbacks so the
 // click handler doesn't need to rebuild when they change.
 const onRegionPlaceRef = useRef(onRegionPlace);
 onRegionPlaceRef.current = onRegionPlace;
 const pinModeRef = useRef<PinMode>(pinMode);
 pinModeRef.current = pinMode;
 const onDraftCancelRef = useRef(onDraftCancel);
 onDraftCancelRef.current = onDraftCancel;

 // box-drawing transient state. `boxStart`
 // stores the pointerdown point in normalised page coords; `boxEnd`
 // tracks the pointermove. Both are page-indexed so the preview can
 // render on the correct page. Cleared on pointerup / cancel.
 const [boxDraft, setBoxDraft] = useState<{
 pageIndex: number;
 start: { x: number; y: number };
 end: { x: number; y: number };
 } | null>(null);

 // Build boundary lookup: startPage -> Entry[] for multiple entries per page
 const boundaryMap = useMemo(() => {
 const map = new Map<number, Entry[]>();
 if (!boundaries) return map;
 for (const entry of boundaries) {
 if (!map.has(entry.startPage)) map.set(entry.startPage, []);
 map.get(entry.startPage)!.push(entry);
 }
 // Sort entries within each page by startY
 for (const entries of map.values()) {
 entries.sort((a, b) => a.startY - b.startY);
 }
 return map;
 }, [boundaries]);

 // Build sorted sibling position labels (position + 1)
 const sequenceLabels = useMemo(() => {
 const labels = new Map<string, string>();
 if (!boundaries) return labels;
 // Group by parentId for sibling numbering
 const groups = new Map<string | null, Entry[]>();
 for (const entry of boundaries) {
 const key = entry.parentId;
 if (!groups.has(key)) groups.set(key, []);
 groups.get(key)!.push(entry);
 }
 for (const siblings of groups.values()) {
 siblings.sort((a, b) => a.position - b.position);
 for (const entry of siblings) {
 labels.set(entry.id, String(entry.position + 1));
 }
 }
 return labels;
 }, [boundaries]);

 // Memoize page layouts -- only recalculates when pages, width, or zoom change
 const layouts = useMemo(
 () => computeLayouts(pages, containerWidth, zoom),
 [pages, containerWidth, zoom]
 );

 // Load OpenSeadragon; a failed load surfaces the retry banner
 // instead of leaving a silent strip of placeholder boxes.
 const loadOsd = useCallback(() => {
 setOsdError(false);
 loadScript("/vendor/openseadragon.min.js")
 .then(() => setOsdReady(true))
 .catch((err) => {
 console.error(err);
 setOsdError(true);
 });
 }, []);
 useEffect(() => {
 loadOsd();
 }, [loadOsd]);

 // Observe container width
 useEffect(() => {
 const el = scrollRef.current;
 if (!el) return;
 const observer = new ResizeObserver((entries) => {
 for (const entry of entries) {
 setContainerWidth(entry.contentRect.width);
 }
 });
 observer.observe(el);
 return () => observer.disconnect();
 }, []);

 const totalHeight = useMemo(() => {
 if (layouts.length === 0) return 0;
 const last = layouts[layouts.length - 1];
 return last.top + last.displayHeight;
 }, [layouts]);

 // Store layouts in a ref so scroll handler doesn't need to be recreated
 const layoutsRef = useRef(layouts);
 layoutsRef.current = layouts;

 // Scroll handler -- uses refs to avoid dependency changes
 useEffect(() => {
 const el = scrollRef.current;
 if (!el) return;

 function onScroll() {
 const currentLayouts = layoutsRef.current;
 if (currentLayouts.length === 0) return;

 const scrollTop = el!.scrollTop;
 const viewportHeight = el!.clientHeight;
 const scrollBottom = scrollTop + viewportHeight;

 let start = 0;
 let end = 0;

 for (let i = 0; i < currentLayouts.length; i++) {
 const { top, displayHeight } = currentLayouts[i];
 if (top + displayHeight >= scrollTop) {
 start = i;
 break;
 }
 }

 for (let i = start; i < currentLayouts.length; i++) {
 end = i;
 if (currentLayouts[i].top > scrollBottom) break;
 }

 const bufferedStart = Math.max(0, start - BUFFER_PAGES);
 const bufferedEnd = Math.min(currentLayouts.length - 1, end + BUFFER_PAGES);

 setVisibleRange((prev) => {
 if (prev.start === bufferedStart && prev.end === bufferedEnd) return prev;
 return { start: bufferedStart, end: bufferedEnd };
 });

 // Determine "current" page -- the one most visible in viewport
 let bestIndex = start;
 let bestOverlap = 0;
 for (let i = start; i <= end && i < currentLayouts.length; i++) {
 const { top, displayHeight } = currentLayouts[i];
 const overlapTop = Math.max(scrollTop, top);
 const overlapBottom = Math.min(scrollBottom, top + displayHeight);
 const overlap = Math.max(0, overlapBottom - overlapTop);
 if (overlap > bestOverlap) {
 bestOverlap = overlap;
 bestIndex = i;
 }
 }

 if (bestIndex !== lastPageIndexRef.current) {
 lastPageIndexRef.current = bestIndex;
 onPageChangeRef.current?.(bestIndex);
 }

 // Report Y-fraction within the current page (debounced at 150ms)
 const bestLayout = currentLayouts[bestIndex];
 if (bestLayout && bestLayout.displayHeight > 0) {
 const yFraction = Math.max(0, Math.min(1, (scrollTop - bestLayout.top) / bestLayout.displayHeight));
 if (yFractionTimerRef.current) clearTimeout(yFractionTimerRef.current);
 yFractionTimerRef.current = setTimeout(() => {
 onYFractionChangeRef.current?.(yFraction);
 }, 150);
 }
 }

 el.addEventListener("scroll", onScroll, { passive: true });
 // Initial calculation
 onScroll();
 return () => el.removeEventListener("scroll", onScroll);
 }, []); // Stable -- uses refs for all changing data

 // Re-trigger visible range calculation when layouts change (zoom/resize)
 useEffect(() => {
 const el = scrollRef.current;
 if (!el) return;
 // Dispatch a synthetic scroll to recalculate visible range
 el.dispatchEvent(new Event("scroll"));
 }, [layouts]);

 // Expose imperative handle
 useImperativeHandle(ref, () => ({
 zoomIn: () => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP)),
 zoomOut: () => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP)),
 scrollToPage: (index: number) => {
 const currentLayouts = layoutsRef.current;
 if (index >= 0 && index < currentLayouts.length && scrollRef.current) {
 scrollRef.current.scrollTo({ top: currentLayouts[index].top, behavior: "smooth" });
 }
 },
 scrollToPosition: (pageIndex: number, yFraction: number) => {
 const currentLayouts = layoutsRef.current;
 if (pageIndex >= 0 && pageIndex < currentLayouts.length && scrollRef.current) {
 const layout = currentLayouts[pageIndex];
 // Centre the target y on screen rather than top-aligning it.
 // Top-aligning made a region at yFraction ≈ 0.5 sit at the top
 // of the viewport, pushing the next page into the dominant
 // visual slot and giving the "jumped to the wrong page" feel.
 const viewportHeight = scrollRef.current.clientHeight;
 const target = layout.top + yFraction * layout.displayHeight;
 const targetTop = Math.max(0, target - viewportHeight / 2);
 scrollRef.current.scrollTo({ top: targetTop, behavior: "smooth" });
 }
 },
 getZoomPercent: () => Math.round(zoom * 100),
 }));

 // Cleanup OSD instances that are out of range
 useEffect(() => {
 const instances = osdInstancesRef.current;
 for (const [idx, viewer] of instances.entries()) {
 if (idx < visibleRange.start || idx > visibleRange.end) {
 viewer.destroy();
 instances.delete(idx);
 }
 }
 }, [visibleRange]);

 // Cleanup all OSD instances and timers on unmount
 useEffect(() => {
 return () => {
 for (const viewer of osdInstancesRef.current.values()) {
 viewer.destroy();
 }
 osdInstancesRef.current.clear();
 if (yFractionTimerRef.current) clearTimeout(yFractionTimerRef.current);
 };
 }, []);

 /**
 * O-01: document-level Escape handler cancels
 * an in-progress draft pin by invoking `onDraftCancel`. Also
 * cancels an in-progress box drag (pointermove between start and
 * up) so the user has a keyboard escape from a rogue drag.
 */
 useEffect(() => {
 function handleKeyDown(e: KeyboardEvent) {
 if (e.key !== "Escape") return;
 if (boxDraft) {
 setBoxDraft(null);
 return;
 }
 onDraftCancelRef.current?.();
 }
 document.addEventListener("keydown", handleKeyDown);
 return () => document.removeEventListener("keydown", handleKeyDown);
 }, [boxDraft]);

 // Click-to-place handler for page image overlays
 const handlePageOverlayClick = useCallback(
 (e: React.MouseEvent, pageIndex: number) => {
 // drawing-mode branch comes BEFORE
 // the boundary-place branch. When pinMode is "point", treat
 // the click as a pin drop and return; "box" mode ignores raw
 // clicks (the full gesture is pointerdown/move/up). This
 // ordering is load-bearing -- the acceptance criteria grep
 // confirms the pinMode guard appears earlier in the file than
 // the boundary-place call below.
 const currentPinMode = pinModeRef.current;
 if (currentPinMode !== "off") {
 if (currentPinMode === "point" && onRegionPlaceRef.current) {
 const rect = e.currentTarget.getBoundingClientRect();
 const xNorm = (e.clientX - rect.left) / rect.width;
 const yNorm = (e.clientY - rect.top) / rect.height;
 const routed = routePageClick(currentPinMode, { xNorm, yNorm });
 if (routed.kind === "region") {
 onRegionPlaceRef.current({
 pageId: pages[pageIndex].id,
 region: routed.region,
 });
 }
 }
 return;
 }

 if (!onPlaceBoundaryRef.current || !scrollRef.current) return;
 const layout = layoutsRef.current[pageIndex];
 if (!layout) return;

 const containerTop = scrollRef.current.getBoundingClientRect().top;
 const result = pointerToPagePosition(
 e.clientY,
 scrollRef.current.scrollTop,
 containerTop,
 layoutsRef.current,
 pages
 );

 if (result) {
 onPlaceBoundaryRef.current(result.pageNumber, result.yFraction);
 }
 },
 [pages]
 );

 // box-mode pointer handlers on the page
 // overlay. pointerdown captures the starting normalised point;
 // pointermove updates the live preview; pointerup fires
 // onRegionPlace with the final box, then clears the state.
 const handlePageOverlayPointerDown = useCallback(
 (e: React.PointerEvent, pageIndex: number) => {
 if (pinModeRef.current !== "box") return;
 const rect = e.currentTarget.getBoundingClientRect();
 const xNorm = (e.clientX - rect.left) / rect.width;
 const yNorm = (e.clientY - rect.top) / rect.height;
 e.currentTarget.setPointerCapture?.(e.pointerId);
 setBoxDraft({
 pageIndex,
 start: { x: xNorm, y: yNorm },
 end: { x: xNorm, y: yNorm },
 });
 },
 [],
 );

 const handlePageOverlayPointerMove = useCallback(
 (e: React.PointerEvent, pageIndex: number) => {
 if (pinModeRef.current !== "box") return;
 const rect = e.currentTarget.getBoundingClientRect();
 const xNorm = (e.clientX - rect.left) / rect.width;
 const yNorm = (e.clientY - rect.top) / rect.height;
 setBoxDraft((prev) =>
 prev && prev.pageIndex === pageIndex
 ? { ...prev, end: { x: xNorm, y: yNorm } }
 : prev,
 );
 },
 [],
 );

 const handlePageOverlayPointerUp = useCallback(
 (e: React.PointerEvent, pageIndex: number) => {
 if (pinModeRef.current !== "box") return;
 e.currentTarget.releasePointerCapture?.(e.pointerId);
 const current = boxDraft;
 if (!current || current.pageIndex !== pageIndex) {
 setBoxDraft(null);
 return;
 }
 const region = computeBoxRegion(current.start, current.end);
 setBoxDraft(null);
 if (region && onRegionPlaceRef.current) {
 onRegionPlaceRef.current({
 pageId: pages[pageIndex].id,
 region,
 });
 }
 },
 [boxDraft, pages],
 );

 // Hover preview handler for page image overlays
 const handlePageOverlayMouseMove = useCallback(
 (e: React.MouseEvent) => {
 if (!scrollRef.current) return;
 const containerTop = scrollRef.current.getBoundingClientRect().top;
 const absoluteY = e.clientY - containerTop + scrollRef.current.scrollTop;
 setHoverPreviewTop(absoluteY);
 },
 []
 );

 const handlePageOverlayMouseLeave = useCallback(() => {
 setHoverPreviewTop(null);
 }, []);

 // --- Drag-to-move handlers ---

 /**
 * Resolve a clientY to a page position, including gap areas.
 * If pointer is in a gap, targets the next page at y=0.
 */
 const resolveDropPosition = useCallback(
 (clientY: number): PagePosition | null => {
 if (!scrollRef.current) return null;
 const containerTop = scrollRef.current.getBoundingClientRect().top;
 const currentLayouts = layoutsRef.current;

 // First try: is the pointer on a page?
 const pagePos = pointerToPagePosition(
 clientY,
 scrollRef.current.scrollTop,
 containerTop,
 currentLayouts,
 pages
 );
 if (pagePos) return pagePos;

 // Pointer is in a gap -- find which gap
 const absoluteY = clientY - containerTop + scrollRef.current.scrollTop;
 for (let i = 0; i < currentLayouts.length - 1; i++) {
 const gapStart = currentLayouts[i].top + currentLayouts[i].displayHeight;
 const gapEnd = currentLayouts[i + 1].top;
 if (absoluteY >= gapStart && absoluteY < gapEnd) {
 return { pageNumber: pages[i + 1].position, yFraction: 0 };
 }
 }

 return null;
 },
 [pages]
 );

 /**
 * Validate whether a drag target position is valid for the given entry.
 * Checks: min gap, parent containment, parent-outside-children.
 */
 const isDragPositionValid = useCallback(
 (entryId: string, targetPage: number, targetY: number): boolean => {
 if (!boundaries) return true;
 const entry = boundaries.find(e => e.id === entryId);
 if (!entry) return false;

 // Min gap check: any other entry on the same page too close?
 for (const e of boundaries) {
 if (e.id === entryId) continue;
 if (e.startPage === targetPage && Math.abs(e.startY - targetY) < MIN_Y_GAP) {
 return false;
 }
 }

 // Child containment: if entry has a parent, must stay within parent range
 if (entry.parentId !== null) {
 const parent = boundaries.find(e => e.id === entry.parentId);
 if (parent) {
 // Child must be >= parent's (page, y)
 if (targetPage < parent.startPage) return false;
 if (targetPage === parent.startPage && targetY < parent.startY) return false;
 }
 }

 // Parent check: if entry has children, cannot move past its own children
 const children = boundaries.filter(e => e.parentId === entryId);
 if (children.length > 0) {
 const firstChild = children.reduce((min, c) => {
 if (c.startPage < min.startPage) return c;
 if (c.startPage === min.startPage && c.startY < min.startY) return c;
 return min;
 });
 // Parent must be <= first child's (page, y)
 if (targetPage > firstChild.startPage) return false;
 if (targetPage === firstChild.startPage && targetY > firstChild.startY) return false;
 }

 return true;
 },
 [boundaries]
 );

 const handleBoundaryDragStart = useCallback((entryId: string) => {
 setDragState({ entryId, ghostTop: null, isInvalid: false });
 setHoverPreviewTop(null); // hide hover preview during drag
 }, []);

 const handleBoundaryDragMove = useCallback(
 (clientY: number) => {
 if (!scrollRef.current) return;

 // Auto-scroll near edges
 startAutoScroll(clientY);

 const target = resolveDropPosition(clientY);
 if (!target) {
 // Outside all pages and gaps
 const containerTop = scrollRef.current.getBoundingClientRect().top;
 const absoluteY = clientY - containerTop + scrollRef.current.scrollTop;
 setDragState(prev => ({ ...prev, ghostTop: absoluteY, isInvalid: true }));
 return;
 }

 // Compute ghost pixel position
 const currentLayouts = layoutsRef.current;
 const pageIndex = pages.findIndex(p => p.position === target.pageNumber);
 if (pageIndex < 0) return;
 const layout = currentLayouts[pageIndex];

 let ghostTop: number;
 if (target.yFraction === 0 && pageIndex > 0) {
 ghostTop = layout.top - PAGE_GAP / 2;
 } else {
 ghostTop = layout.top + target.yFraction * layout.displayHeight;
 }

 const isInvalid = dragState.entryId
 ? !isDragPositionValid(dragState.entryId, target.pageNumber, target.yFraction)
 : true;

 setDragState(prev => ({ ...prev, ghostTop, isInvalid }));
 },
 [pages, startAutoScroll, resolveDropPosition, isDragPositionValid, dragState.entryId]
 );

 const handleBoundaryDragEnd = useCallback(
 (entryId: string, clientY: number) => {
 stopAutoScroll();

 const target = resolveDropPosition(clientY);
 if (target && isDragPositionValid(entryId, target.pageNumber, target.yFraction)) {
 onMoveBoundaryRef.current?.(entryId, target.pageNumber, target.yFraction);
 }
 // Reset drag state (snap back if invalid)
 setDragState({ entryId: null, ghostTop: null, isInvalid: false });
 },
 [resolveDropPosition, isDragPositionValid, stopAutoScroll]
 );

 return (
 <div className="relative flex h-full w-full">
 {osdError && (
 <div
 role="alert"
 className="absolute inset-x-0 top-0 z-30 flex items-center justify-center gap-3 border-b border-madder bg-madder-wash px-4 py-2 text-sm text-madder-deep"
 >
 <span>{t("viewer:load_error.message")}</span>
 <button
 type="button"
 onClick={loadOsd}
 className="rounded-md border border-madder px-3 py-1 font-medium text-madder-deep hover:bg-madder-tint focus:outline-none focus-visible:ring-2 focus-visible:ring-madder"
 >
 {t("viewer:load_error.retry")}
 </button>
 </div>
 )}
 {/* Page label gutter */}
 <div
 ref={scrollRef}
 className="h-full flex-1 overflow-y-auto bg-stone-100"
 style={{ scrollbarGutter: "stable" }}
 >
 <div style={{ height: totalHeight, position: "relative" }}>
 {/* Drag ghost overlay */}
 {dragState.entryId && dragState.ghostTop !== null && (
 <DragOverlay
 visible={true}
 top={dragState.ghostTop}
 width={containerWidth}
 isInvalid={dragState.isInvalid}
 />
 )}
 {/* Hover preview dashed line (hidden during drag) */}
 {hoverPreviewTop !== null && !dragState.entryId && (
 <div
 style={{
 position: "absolute",
 top: hoverPreviewTop,
 left: 0,
 width: containerWidth,
 height: 0,
 zIndex: 15,
 pointerEvents: "none",
 }}
 >
 <div className="absolute left-16 right-0 top-0 border-t-2 border-dashed border-teal-300 opacity-60" />
 </div>
 )}
 {layouts.map((layout, index) => {
 const isVisible =
 index >= visibleRange.start && index <= visibleRange.end;
 const page = pages[index];
 // Get all entries starting on this page
 const pageEntries = boundaryMap.get(page.position) || [];
 // The gap after this page (before next page)
 const nextPage = pages[index + 1];
 // Check if any y=0 boundary exists at the next page (page-gap boundary)
 const nextPageEntries = nextPage ? (boundaryMap.get(nextPage.position) || []) : [];
 const hasGapBoundary = nextPageEntries.some(e => e.startY === 0);
 const gapCenterY = layout.top + layout.displayHeight + PAGE_GAP / 2;

 // build the per-page RegionPin array
 // for this page. Includes the draft pin if it belongs to
 // this page so the user sees the amber-dashed preview
 // while composing the comment.
 const committedPins: RegionPin[] =
 regionsByPage?.[page.id]?.map((r) => ({
 commentId: r.commentId,
 x: r.x,
 y: r.y,
 w: r.w,
 h: r.h,
 authorId: r.authorId,
 })) ?? [];
 const allPins: RegionPin[] = [...committedPins];
 if (draftPin && draftPin.pageId === page.id) {
 allPins.push({
 commentId: "__draft__",
 x: draftPin.region.x,
 y: draftPin.region.y,
 w: draftPin.region.w,
 h: draftPin.region.h,
 draft: true,
 });
 }
 // Box-drag live preview (only on the page being dragged).
 if (
 pinMode === "box" &&
 boxDraft &&
 boxDraft.pageIndex === index
 ) {
 const preview = computeBoxRegion(boxDraft.start, boxDraft.end);
 if (preview) {
 allPins.push({
 commentId: "__box_preview__",
 ...preview,
 draft: true,
 });
 }
 }

 const flagCount = openFlagsByPage?.[page.id] ?? 0;

 return (
 <div key={page.position}>
 {/* Boundary markers for all entries on this page */}
 {pageEntries.map((entry) => {
 const isFirstEntry = entry.position === 0 && entry.parentId === null;
 let markerTop: number;

 if (entry.startY === 0 && index > 0) {
 // y=0 entries on pages after the first: position in the gap
 markerTop = layout.top - PAGE_GAP / 2;
 } else if (entry.startY === 0 && index === 0) {
 // First page, y=0: position at top of page
 markerTop = layout.top;
 } else {
 // Within-page: position at the y-fraction of the page
 markerTop = layout.top + entry.startY * layout.displayHeight;
 }

 return (
 <BoundaryMarker
 key={entry.id}
 entry={entry}
 sequenceLabel={sequenceLabels.get(entry.id) || "?"}
 top={markerTop}
 width={containerWidth}
 onDelete={(entryId) => onDeleteBoundaryRef.current?.(entryId)}
 isFirstEntry={isFirstEntry}
 onDragStart={handleBoundaryDragStart}
 onDragMove={handleBoundaryDragMove}
 onDragEnd={handleBoundaryDragEnd}
 isDragFaded={dragState.entryId === entry.id}
 variant={reviewerModifiedIds?.has(entry.id) ? "reviewer" : "cataloguer"}
 />
 );
 })}
 {/* Page slot */}
 <div
 style={{
 position: "absolute",
 top: layout.top,
 height: layout.displayHeight,
 width: "100%",
 }}
 >
 <div className="flex h-full justify-center">
 {/* Label gutter + FlagBadge slot */}
 <div className="flex w-12 shrink-0 flex-col items-end gap-2 pr-1 pt-2">
 <span className="text-base font-medium text-stone-500">
 {page.label || page.position}
 </span>
 {onFlagClick && (
 <button
 type="button"
 aria-label={t(
 "qc_flags:badge.raise_button_aria",
 { position: page.position }
 )}
 onClick={(e) => {
 e.stopPropagation();
 onFlagClick({
 pageId: page.id,
 pagePosition: page.position,
 });
 }}
 className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-stone-500 shadow-sm ring-1 ring-stone-200 hover:bg-white hover:text-indigo"
 >
 <Flag
 size={20}
 strokeWidth={2}
 aria-hidden="true"
 />
 </button>
 )}
 {/* per-page FlagBadge.
 Replaces the 12px red dot. Hidden
 at zero by the FlagBadge render predicate. */}
 <FlagBadge
 count={flagCount}
 onClick={() => {
 if (onFlagBadgeClick) {
 onFlagBadgeClick(page.id);
 }
 }}
 aria-label={t("qc_flags:badge.per_page_aria", {
 count: flagCount,
 })}
 />
 </div>
 {/* Page image */}
 <div className="relative flex">
 <div
 style={{
 position: "relative",
 width: page.width * layout.scale,
 height: layout.displayHeight,
 }}
 >
 {isVisible && osdReady ? (
 <OSDPage
 page={page}
 width={page.width * layout.scale}
 height={layout.displayHeight}
 instancesRef={osdInstancesRef}
 index={index}
 />
 ) : (
 <div className="flex h-full w-full items-center justify-center bg-stone-200 text-xs text-stone-400">
 {page.label || page.position}
 </div>
 )}
 {/* region pin overlay
 rendered on top of the page image. The
 overlay's own `pointer-events-none` root
 keeps the boundary-click overlay reachable;
 individual pins opt into pointer events so
 they stay clickable. */}
 {allPins.length > 0 && (
 <RegionPinOverlay
 pins={allPins}
 onPinClick={onRegionPinClick}
 highlightedCommentId={highlightedCommentId}
 moveMode={moveMode}
 currentUserId={currentUserId}
 onPinMove={onPinMove}
 notAuthorTooltip={notAuthorTooltip}
 />
 )}
 {/* Click overlay lives inside the image-wrapper
 so it shares RegionPinOverlay's reference
 frame. Previously nested in the flex-1
 column: xNorm was computed against the
 column (which is wider than the centered
 image) while pins rendered at xNorm of the
 image, producing a horizontal offset to the
 right of the click. */}
 {(onPlaceBoundaryRef.current || pinMode !== "off") && (
 <div
 style={{
 position: "absolute",
 top: 0,
 left: 0,
 width: "100%",
 height: "100%",
 zIndex: 15,
 touchAction: pinMode === "box" ? "none" : undefined,
 }}
 className="cursor-crosshair"
 onClick={(e) => handlePageOverlayClick(e, index)}
 onPointerDown={(e) =>
 handlePageOverlayPointerDown(e, index)
 }
 onPointerMove={(e) => {
 handlePageOverlayPointerMove(e, index);
 handlePageOverlayMouseMove(e);
 }}
 onPointerUp={(e) =>
 handlePageOverlayPointerUp(e, index)
 }
 onMouseLeave={handlePageOverlayMouseLeave}
 />
 )}
 </div>
 </div>
 </div>
 </div>
 {/* Gap between pages: PageGap (clickable) or nothing if y=0 boundary exists at next page */}
 {nextPage && !hasGapBoundary && onPlaceBoundaryRef.current && pinMode === "off" && (
 <PageGap
 pageNumber={nextPage.position}
 onPlace={(startPage, startY) => onPlaceBoundaryRef.current?.(startPage, startY)}
 top={gapCenterY}
 width={containerWidth}
 />
 )}
 </div>
 );
 })}
 </div>
 </div>
 </div>
 );
  }
);

// Individual page rendered with OpenSeadragon
function OSDPage({
  page,
  width,
  height,
  instancesRef,
  index,
}: {
  page: PageData;
  width: number;
  height: number;
  instancesRef: React.MutableRefObject<Map<number, any>>;
  index: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
 const el = containerRef.current;
 if (!el || !(window as any).OpenSeadragon) return;

 // Don't re-create if already exists
 if (instancesRef.current.has(index)) return;

 const viewer = new (window as any).OpenSeadragon({
 element: el,
 tileSources: `${page.imageUrl}/info.json`,
 showNavigationControl: false,
 animationTime: 0.3,
 immediateRender: true,
 minZoomImageRatio: 1,
 maxZoomPixelRatio: 4,
 visibilityRatio: 1,
 constrainDuringPan: true,
 gestureSettingsMouse: {
 scrollToZoom: false,
 clickToZoom: false,
 dblClickToZoom: true,
 dragToPan: true,
 },
 gestureSettingsTouch: {
 pinchToZoom: true,
 dragToPan: true,
 },
 crossOriginPolicy: "Anonymous",
 });

 // Let wheel events reach the page so it scrolls normally. OSD's
 // canvas-scroll handler cancels the native wheel event by default
 // even with scrollToZoom off, so we must both skip OSD's own zoom
 // action and un-cancel the event via the documented event contract.
 viewer.addHandler(
 "canvas-scroll",
 (event: { preventDefaultAction: boolean; preventDefault: boolean }) => {
 event.preventDefaultAction = true;
 event.preventDefault = false;
 },
 );

 instancesRef.current.set(index, viewer);

 return () => {
 // Don't destroy here -- let the parent manage lifecycle
 };
  }, [page.imageUrl, index, instancesRef]);

  return (
 <div
 ref={containerRef}
 style={{ width, height }}
 className="bg-white shadow-sm"
 />
  );
}

