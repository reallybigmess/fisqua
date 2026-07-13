/**
 * Cataloguer Description Tab
 *
 * This component is the description-side of the cataloguer's dashboard.
 * It surfaces the description entries currently assigned to the
 * cataloguer grouped by their workflow status — Necesita atención
 * (sent_back, carrying reviewer feedback), En curso (in_progress, kept
 * grouped by their parent volume so context is preserved), Listo para
 * comenzar (assigned but untouched), and Completados (described,
 * reviewed, or approved). The grouping mirrors the cataloguer dashboard
 * tab on the segmentation side so the two registers feel like siblings.
 *
 * @version v0.4.2
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { DescriptionStatusBadge } from "../workflow/status-badge";

export type DescriptionEntryCardData = {
  id: string;
  title: string | null;
  translatedTitle: string | null;
  referenceCode: string;
  volumeTitle: string;
  volumeId: string;
  projectId: string;
  startPage: number;
  endPage: number | null;
  descriptionStatus: string;
  reviewerFeedback: string | null;
  /** Booleans for the 4 completion dots */
  hasIdentificacion: boolean;
  hasFisica: boolean;
  hasContenido: boolean;
  hasNotas: boolean;
};

type CataloguerDescriptionTabProps = {
  entries: DescriptionEntryCardData[];
};

/** Completion dot for description sections */
function CompletionDot({ filled }: { filled: boolean }) {
  if (filled) {
    return (
      <svg className="h-4 w-4 text-verdigris" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    );
  }
  return (
    <svg className="h-4 w-4 text-stone-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function EntryCard({ entry }: { entry: DescriptionEntryCardData }) {
  const { t } = useTranslation("description");
  const displayTitle = entry.title || entry.translatedTitle || t("assignment.item");
  const pageRange = entry.endPage
    ? `pp. ${entry.startPage}-${entry.endPage}`
    : `p. ${entry.startPage}`;

  return (
    <Link
      to={`/projects/${entry.projectId}/describe/${entry.id}`}
      className="block rounded-lg border border-stone-200 p-4 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-base font-semibold text-stone-900">
            {displayTitle}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-stone-500">{entry.referenceCode}</p>
        </div>
        <DescriptionStatusBadge status={entry.descriptionStatus} />
      </div>

      <p className="mt-1 text-sm text-stone-500">
        {entry.volumeTitle} — {pageRange}
      </p>

      {/* Completion dots */}
      <div className="mt-2 flex items-center gap-1">
        <CompletionDot filled={entry.hasIdentificacion} />
        <CompletionDot filled={entry.hasFisica} />
        <CompletionDot filled={entry.hasContenido} />
        <CompletionDot filled={entry.hasNotas} />
      </div>
    </Link>
  );
}

function SentBackCard({ entry }: { entry: DescriptionEntryCardData }) {
  const { t } = useTranslation("description");
  const displayTitle = entry.title || entry.translatedTitle || t("assignment.item");
  const pageRange = entry.endPage
    ? `pp. ${entry.startPage}-${entry.endPage}`
    : `p. ${entry.startPage}`;

  return (
    <Link
      to={`/projects/${entry.projectId}/describe/${entry.id}`}
      className="block rounded-md bg-indigo-tint p-4 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-serif text-base font-semibold text-stone-900">
            {displayTitle}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-stone-500">{entry.referenceCode}</p>
        </div>
        <DescriptionStatusBadge status={entry.descriptionStatus} />
      </div>

      <p className="mt-1 text-sm text-stone-500">
        {entry.volumeTitle} — {pageRange}
      </p>

      {entry.reviewerFeedback && (
        <div className="mt-2">
          <div className="flex items-center gap-1.5">
            <svg className="h-4 w-4 text-indigo-deep" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-13 font-semibold text-indigo-deep">
              {t("dashboard.reviewer_feedback_label")}
            </span>
          </div>
          <p className="mt-1 font-serif text-15 italic text-stone-700">
            {entry.reviewerFeedback}
          </p>
        </div>
      )}
    </Link>
  );
}

export function CataloguerDescriptionTab({ entries }: CataloguerDescriptionTabProps) {
  const { t } = useTranslation(["dashboard", "description"]);

  if (entries.length === 0) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
            <svg className="h-7 w-7 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <h3 className="mt-4 font-serif text-lg font-semibold text-indigo">
            {t("dashboard:empty.no_description_entries_title")}
          </h3>
          <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
            {t("dashboard:empty.no_description_entries_body")}
          </p>
        </div>
      </div>
    );
  }

  // Group by status
  const sentBack = entries.filter((e) => e.descriptionStatus === "sent_back");
  const inProgress = entries.filter((e) => e.descriptionStatus === "in_progress");
  const assigned = entries.filter((e) => e.descriptionStatus === "assigned");
  const completed = entries.filter(
    (e) => e.descriptionStatus === "described" ||
           e.descriptionStatus === "reviewed" ||
           e.descriptionStatus === "approved"
  );

  // Group in-progress entries by volume
  const inProgressByVolume = new Map<string, { volumeTitle: string; referenceCode: string; entries: DescriptionEntryCardData[] }>();
  for (const entry of inProgress) {
    const existing = inProgressByVolume.get(entry.volumeId);
    if (existing) {
      existing.entries.push(entry);
    } else {
      inProgressByVolume.set(entry.volumeId, {
        volumeTitle: entry.volumeTitle,
        referenceCode: entry.referenceCode.split("/").slice(0, -1).join("/") || entry.referenceCode,
        entries: [entry],
      });
    }
  }

  return (
    <div className="space-y-8">
      {/* Necesita atencion */}
      {sentBack.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("dashboard:group.needs_attention")}
            <span className="ml-2 text-xs font-normal">({sentBack.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sentBack.map((entry) => (
              <SentBackCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}

      {/* En curso -- grouped by volume */}
      {inProgress.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("dashboard:group.in_progress")}
            <span className="ml-2 text-xs font-normal">({inProgress.length})</span>
          </h2>
          <div className="mt-3 space-y-4">
            {[...inProgressByVolume.entries()].map(([volumeId, group]) => (
              <div key={volumeId}>
                <div className="flex items-center gap-2 text-stone-500">
                  <span className="font-serif text-15 font-semibold">
                    {group.volumeTitle}
                  </span>
                  <span className="font-mono text-xs">{group.referenceCode}</span>
                </div>
                <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {group.entries.map((entry) => (
                    <EntryCard key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Listo para comenzar */}
      {assigned.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("dashboard:group.ready_to_start")}
            <span className="ml-2 text-xs font-normal">({assigned.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assigned.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}

      {/* Completados */}
      {completed.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("dashboard:group.completed")}
            <span className="ml-2 text-xs font-normal">({completed.length})</span>
          </h2>
          <div className="mt-3 grid gap-3 opacity-75 sm:grid-cols-2 lg:grid-cols-3">
            {completed.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
