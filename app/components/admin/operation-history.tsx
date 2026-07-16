/**
 * Admin — Authority operation history (shared surface)
 *
 * The read-only per-record ledger history page body (spec §4, ruled
 * 2026-07-11; the visual round for this page has not returned, so the
 * layout follows the app's existing idiom and the workbench tokens).
 * One entry per `authority_operations` row touching the record as
 * source or target, newest first: operation icon, a human title
 * resolved by the host route (direction-aware), date + acting user,
 * the reason as a quiet quoted line when present, and a compact
 * detail summary (moved / dropped / left-behind link counts). No
 * editing, no deletion — the ledger is append-only and this page is
 * its window.
 *
 * @version v0.4.2
 */

import { Link } from "react-router";
import { GitMerge, GitFork, CircleX, Trash2, FileText } from "lucide-react";

export interface HistoryEntry {
  id: string;
  operation: "merge" | "split" | "delete" | "resolve" | "separate";
  /** Direction-aware human title, resolved by the host route. */
  title: string;
  /** Optional link target for the counterpart record named in the title. */
  counterpartHref?: string | null;
  date: string;
  user: string;
  reason?: string | null;
  /** Compact detail fragments ("3 links moved", …). */
  detailParts: string[];
}

const OPERATION_ICONS = {
  merge: GitMerge,
  split: GitFork,
  separate: CircleX,
  delete: Trash2,
  resolve: FileText,
} as const;

export function OperationHistory({
  eyebrow,
  recordName,
  recordCode,
  backTo,
  entries,
  total,
  t,
}: {
  eyebrow: string;
  recordName: string;
  recordCode: string;
  backTo: string;
  entries: HistoryEntry[];
  /** Uncapped operation count; a showing-latest note renders when it
   *  exceeds the rendered entries. */
  total: number;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      <p className="text-11 font-semibold uppercase tracking-[0.12em] text-stone-500">
        {eyebrow}
      </p>
      <h1 className="mt-1 font-serif text-[2rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {t("histHeading")}
      </h1>
      <p className="mt-2 font-serif text-base text-indigo-soft">
        {recordName}{" "}
        <span className="font-mono text-13 nums text-stone-500">
          {recordCode}
        </span>
      </p>
      <Link
        to={backTo}
        className="mt-2 inline-block text-13 font-semibold text-indigo hover:underline"
      >
        {t("histBackToRecord")}
      </Link>

      {total > entries.length && (
        <p className="mt-6 text-13 nums text-stone-500">
          {t("histShowingLatest", { shown: entries.length, total })}
        </p>
      )}

      {entries.length === 0 ? (
        <p className="mt-10 rounded-lg border border-stone-200 px-4 py-8 text-center text-13 text-stone-500">
          {t("histEmpty")}
        </p>
      ) : (
        <ol className="mt-8 flex flex-col gap-3">
          {entries.map((e) => {
            const Icon = OPERATION_ICONS[e.operation];
            return (
              <li
                key={e.id}
                className="flex gap-3 rounded-lg border border-stone-200 px-4 py-3"
              >
                <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-tint">
                  <Icon className="h-4 w-4 text-indigo" strokeWidth={1.5} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-15 font-semibold text-indigo">
                    {e.counterpartHref ? (
                      <Link
                        to={e.counterpartHref}
                        className="hover:underline"
                      >
                        {e.title}
                      </Link>
                    ) : (
                      e.title
                    )}
                  </p>
                  <p className="mt-0.5 text-11 nums text-stone-500">
                    {e.date} · {e.user}
                  </p>
                  {e.reason && (
                    <p className="mt-1.5 font-serif text-13 italic text-indigo-soft">
                      "{e.reason}"
                    </p>
                  )}
                  {e.detailParts.length > 0 && (
                    <p className="mt-1 text-11 nums text-stone-400">
                      {e.detailParts.join(" · ")}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
