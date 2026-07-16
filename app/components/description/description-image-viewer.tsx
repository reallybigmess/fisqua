/**
 * Description Image Viewer
 *
 * This component is the image pane that sits beside the description
 * form in the per-entry description editor. It renders only the IIIF
 * pages that belong to the current entry — derived from the entry's
 * `startPage` / `endPage` range — so the cataloguer is never asked to
 * scroll past pages from neighbouring entries while they describe.
 * The viewer carries its own zoom controls (a pair of zoom-in / zoom-out
 * buttons plus a fit-to-width affordance) but no panning UI; the
 * surrounding scroll container handles overflow. The first page in the
 * current entry's range gets a ref so the viewer can scroll to that
 * page whenever the entry changes, which means switching entries always
 * lands the cataloguer at the start of the new entry rather than at
 * whatever scroll offset the previous entry left behind. Visual
 * decoration is intentionally light — no pin overlays, no flag dialogs
 * inline; those live in sibling components — so this file stays
 * focused on getting the right pages in front of the cataloguer at the
 * right scale.
 *
 * @version v0.4.2
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

type Page = {
  position: number;
  imageUrl: string;
  label: string | null;
  width: number;
  height: number;
};

type DescriptionImageViewerProps = {
  pages: Page[];
  currentEntryStartPage: number;
  currentEntryEndPage: number | null;
  manifestUrl?: string;
  // Plumbed from the description editor route so a per-page flag UI
  // can hook the existing QC flag dialog. The component does not yet
  // render a flag control of its own; the prop is accepted so the
  // route compiles and is forwarded once the UI lands.
  onFlagPage?: (pageId: string, pagePosition: number) => void;
};

function ZoomOutIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function DescriptionImageViewer({
  pages,
  currentEntryStartPage,
  currentEntryEndPage,
  onFlagPage: _onFlagPage,
}: DescriptionImageViewerProps) {
  const { t } = useTranslation("description");
  const [zoom, setZoom] = useState(100);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const firstCurrentRef = useRef<HTMLDivElement>(null);

  const effectiveEndPage = currentEntryEndPage ?? currentEntryStartPage;

  const isCurrentPage = useCallback(
    (position: number) => {
      return position >= currentEntryStartPage && position <= effectiveEndPage;
    },
    [currentEntryStartPage, effectiveEndPage]
  );

  // Auto-scroll to first page of current entry on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      firstCurrentRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [currentEntryStartPage]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(200, z + 25));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(25, z - 25));
  }, []);

  return (
    <div ref={panelRef} className="flex h-full flex-col bg-stone-100">
      {/* Zoom bar */}
      <div className="flex h-[48px] shrink-0 items-center gap-1 border-b border-stone-200 bg-white px-3">
        <button
          type="button"
          onClick={handleZoomOut}
          className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100"
          aria-label="Zoom out"
        >
          <ZoomOutIcon />
        </button>
        <span className="min-w-[3.5rem] text-center font-sans text-sm text-stone-500">
          {zoom}%
        </span>
        <button
          type="button"
          onClick={handleZoomIn}
          className="flex h-8 w-8 items-center justify-center rounded text-stone-500 hover:bg-stone-100"
          aria-label="Zoom in"
        >
          <ZoomInIcon />
        </button>
      </div>

      {/* Scrollable page display */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-8">
        <div
          className="mx-auto space-y-4"
          style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center" }}
        >
          {pages.filter((page) => isCurrentPage(page.position)).map((page) => (
              <div
                key={page.position}
                ref={page.position === currentEntryStartPage ? firstCurrentRef : undefined}
                className="flex gap-4"
              >
                {/* Label column */}
                <div className="w-4 shrink-0 pt-1 font-sans text-sm font-semibold text-indigo">
                  <span className="writing-mode-vertical whitespace-nowrap">
                    {page.position}
                  </span>
                </div>

                {/* Page image */}
                <div className="overflow-hidden rounded-lg border-2 border-indigo">
                  <img
                    src={`${page.imageUrl}/full/max/0/default.jpg`}
                    alt={page.label || `Page ${page.position}`}
                    className="max-w-full"
                    loading="lazy"
                  />
                </div>
              </div>
          ))}
        </div>
      </div>
    </div>
  );
}
