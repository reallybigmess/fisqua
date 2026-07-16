/**
 * Section TOC
 *
 * This component is the slim vertical rail that runs alongside the
 * description form, one dot per ISAD(G) section. Each dot reflects the
 * section's completion state — filled verdigris for sections that
 * already carry data, hollow stone-bordered for those still empty —
 * and the active dot grows slightly with a ring so the cataloguer's
 * current focus is unambiguous at a glance. Hovering a dot reveals the
 * full section label in a tooltip; clicking it raises `onSectionClick`
 * with the section's id, which the parent uses to scroll the form to
 * that anchor. The rail is intentionally narrow (twelve units wide) so
 * it reads as a navigational accent rather than a competing column,
 * which matters because the description editor already balances the
 * IIIF viewer, the form, and the entry nav across the same screen.
 *
 * @version v0.4.2
 */

import { useState, useCallback } from "react";

type TocSection = {
  id: string;
  isComplete: boolean;
  label: string;
};

type SectionTOCProps = {
  sections: TocSection[];
  onSectionClick: (sectionId: string) => void;
  activeSectionId?: string;
};

export function SectionTOC({
  sections,
  onSectionClick,
  activeSectionId,
}: SectionTOCProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="flex w-12 shrink-0 flex-col items-center gap-3 border-l border-stone-200 bg-stone-50 py-4">
      {sections.map((section) => {
        const isActive = activeSectionId === section.id;
        return (
          <div key={section.id} className="relative">
            <button
              type="button"
              className={`rounded-full ${
                section.isComplete
                  ? "bg-verdigris"
                  : "border border-stone-200 bg-transparent"
              } ${
                isActive
                  ? "h-3 w-3 ring-2 ring-verdigris ring-offset-1"
                  : "h-2.5 w-2.5"
              }`}
              onClick={() => onSectionClick(section.id)}
              onMouseEnter={() => setHoveredId(section.id)}
              onMouseLeave={() => setHoveredId(null)}
              aria-label={section.label}
            />
            {hoveredId === section.id && (
              <div className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded bg-stone-700 px-2 py-1 font-sans text-xs text-white">
                {section.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
