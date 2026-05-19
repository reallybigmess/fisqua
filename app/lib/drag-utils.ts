/**
 * Segmentation Viewer Drag Utilities
 *
 * This module deals with the pointer-input plumbing that the
 * segmentation viewer needs to distinguish a tap from a drag, to
 * convert a screen coordinate into a `(pageNumber, yFraction)` pair
 * that survives IIIF zoom variants, and to keep auto-scrolling the
 * page when a drag reaches the viewport edge. The viewer composes
 * boundary edits, region pins, and within-page click-to-place on top
 * of these primitives, so the same drag-vs-click threshold and the
 * same edge-zone behaviour apply everywhere a user can grab something
 * in the canvas.
 *
 * `useDragOrClick` is the central hook: it tracks a press, watches
 * for movement beyond `DRAG_THRESHOLD`, fires the appropriate
 * callback (`onDragStart`/`onDragMove`/`onDragEnd` vs `onClick`), and
 * cleans up its own listeners on unmount. The helper functions
 * around it convert pointer coordinates against a list of page
 * layouts so callers can stay in the document's normalised
 * `yFraction` space rather than dealing with pixel offsets at the
 * current zoom level.
 *
 * @version v0.3.0
 */
import { useRef, useCallback } from "react";

// --- Types ---

type PageLayout = { top: number; displayHeight: number; scale: number };
type PageData = { position: number; width: number; height: number };

export type PagePosition = { pageNumber: number; yFraction: number };

type DragOrClickOptions = {
  onDragStart?: (start: { x: number; y: number }) => void;
  onDragMove?: (pos: { x: number; y: number }) => void;
  onDragEnd?: (pos: { x: number; y: number }) => void;
  onClick?: (e: React.PointerEvent) => void;
};

// --- Constants ---

const DRAG_THRESHOLD = 5; // pixels of movement to initiate drag

// Auto-scroll constants
const EDGE_ZONE = 60; // pixels from viewport edge
const SCROLL_SPEED = 8; // pixels per frame

// --- Utilities ---

/**
 * Convert a pointer's clientY to a page position (page number + y-fraction).
 * Returns null if the pointer is in a gap between pages or outside all pages.
 *
 * @param clientY - The pointer's clientY from the event
 * @param scrollTop - The scroll container's scrollTop
 * @param containerTop - The scroll container's getBoundingClientRect().top
 * @param layouts - Array of page layouts from computeLayouts
 * @param pages - Array of page data (for position numbers)
 */
export function pointerToPagePosition(
  clientY: number,
  scrollTop: number,
  containerTop: number,
  layouts: PageLayout[],
  pages: PageData[]
): PagePosition | null {
  const absoluteY = clientY - containerTop + scrollTop;

  for (let i = 0; i < layouts.length; i++) {
    const { top, displayHeight } = layouts[i];
    if (absoluteY >= top && absoluteY < top + displayHeight) {
      const yWithinPage = absoluteY - top;
      const yFraction = yWithinPage / displayHeight;
      return {
        pageNumber: pages[i].position, // 1-based
        yFraction: Math.max(0, Math.min(1, yFraction)),
      };
    }
  }

  return null; // pointer is in a gap or outside pages
}

/**
 * Hook for distinguishing click from drag on the same element.
 * Uses movement threshold (5px) rather than hold duration for better UX.
 * Uses setPointerCapture so moves outside the element still track.
 */
export function useDragOrClick({
  onDragStart,
  onDragMove,
  onDragEnd,
  onClick,
}: DragOrClickOptions) {
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      startPosRef.current = { x: e.clientX, y: e.clientY };
      isDraggingRef.current = false;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    []
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!startPosRef.current) return;
      const dx = e.clientX - startPosRef.current.x;
      const dy = e.clientY - startPosRef.current.y;
      if (!isDraggingRef.current && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        isDraggingRef.current = true;
        onDragStart?.(startPosRef.current);
      }
      if (isDraggingRef.current) {
        onDragMove?.({ x: e.clientX, y: e.clientY });
      }
    },
    [onDragStart, onDragMove]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (isDraggingRef.current) {
        onDragEnd?.({ x: e.clientX, y: e.clientY });
      } else if (startPosRef.current) {
        onClick?.(e);
      }
      startPosRef.current = null;
      isDraggingRef.current = false;
    },
    [onDragEnd, onClick]
  );

  return { handlePointerDown, handlePointerMove, handlePointerUp };
}

/**
 * Hook for auto-scrolling when dragging near viewport edges.
 * Call startAutoScroll(clientY) on each drag move, stopAutoScroll() on drag end.
 */
export function useAutoScroll(scrollRef: React.RefObject<HTMLElement | null>) {
  const frameRef = useRef<number | null>(null);

  const startAutoScroll = useCallback(
    (clientY: number) => {
      const el = scrollRef.current;
      if (!el) return;

      if (frameRef.current) cancelAnimationFrame(frameRef.current);

      const rect = el.getBoundingClientRect();
      const distFromTop = clientY - rect.top;
      const distFromBottom = rect.bottom - clientY;

      let speed = 0;
      if (distFromTop < EDGE_ZONE) {
        speed = -SCROLL_SPEED * (1 - distFromTop / EDGE_ZONE);
      } else if (distFromBottom < EDGE_ZONE) {
        speed = SCROLL_SPEED * (1 - distFromBottom / EDGE_ZONE);
      }

      if (speed !== 0) {
        const tick = () => {
          el.scrollTop += speed;
          frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
      }
    },
    [scrollRef]
  );

  const stopAutoScroll = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  return { startAutoScroll, stopAutoScroll };
}
