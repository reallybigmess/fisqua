/**
 * Entry Nav
 *
 * This component is the small horizontal navigation strip the description
 * editor pins above the form, letting the cataloguer step from one entry
 * to the next inside a volume without leaving the editor. It carries a
 * pair of previous / next chevrons, a positional readout (`3 / 27`), the
 * current entry's reference code and title, and a status pill driven by
 * the shared `DESCRIPTION_STATUS_STYLES` / `DESCRIPTION_STATUS_LABELS`
 * map — so the colour and label vocabulary matches every other surface
 * that shows description statuses (assignments, dashboards, outline).
 * The component is purely an affordance; the parent route handles the
 * actual navigation by mutating the URL, so the back / forward buttons
 * in the browser remain in step. Disabling the chevrons at the edges of
 * the volume keeps the cataloguer from triggering no-op transitions
 * that would clear unsaved changes for nothing.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";
import {
  DESCRIPTION_STATUS_STYLES,
  DESCRIPTION_STATUS_LABELS,
  type DescriptionStatus,
} from "../../lib/description-workflow";

type EntryNavProps = {
  currentIndex: number;
  totalEntries: number;
  currentEntry: {
    title: string | null;
    referenceCode?: string;
    descriptionStatus: DescriptionStatus;
  };
  onPrev: () => void;
  onNext: () => void;
  prevDisabled: boolean;
  nextDisabled: boolean;
};

function ChevronLeftIcon() {
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
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
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
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

export function EntryNav({
  currentIndex,
  totalEntries,
  currentEntry,
  onPrev,
  onNext,
  prevDisabled,
  nextDisabled,
}: EntryNavProps) {
  const { t } = useTranslation("description");

  const statusStyle =
    DESCRIPTION_STATUS_STYLES[currentEntry.descriptionStatus];
  const statusLabelKey =
    DESCRIPTION_STATUS_LABELS[currentEntry.descriptionStatus];

  return (
    <div className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2">
      {/* Reference code */}
      {currentEntry.referenceCode && (
        <span className="font-mono text-sm text-stone-500">
          {currentEntry.referenceCode}
        </span>
      )}

      {/* Position + navigation */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={prevDisabled}
          className="flex h-7 w-7 items-center justify-center rounded border border-stone-200 text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t("navigation.anterior")}
        >
          <ChevronLeftIcon />
        </button>
        <span className="font-sans text-sm text-stone-500">
          {currentIndex + 1} {t("navigation.de")} {totalEntries}
        </span>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          className="flex h-7 w-7 items-center justify-center rounded border border-stone-200 text-stone-700 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={t("navigation.siguiente")}
        >
          <ChevronRightIcon />
        </button>
      </div>

      {/* Status badge */}
      <span
        className={`rounded-full px-2.5 py-0.5 font-sans text-xs font-semibold ${statusStyle.bg} ${statusStyle.text}`}
      >
        {t(statusLabelKey)}
      </span>
    </div>
  );
}
