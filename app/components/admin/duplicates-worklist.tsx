/**
 * Admin — Possible-duplicates worklist (shared surface)
 *
 * The record-type-agnostic worklist page body (spec §4, design handoff
 * surface 3): a count line, a vertical stack of candidate pair cards —
 * each with the two records, match-signal chips, and the two actions —
 * plus the required-reason dismissal modal, the post-dismissal banner,
 * and the empty state. Nothing here mutates records: "Compare & merge"
 * navigates to the merge workbench pre-loaded with the pair, and
 * "Not a duplicate" POSTs a `separate` ledger operation through the
 * host route's action.
 *
 * No Undo affordance on the dismissed banner: the 0057 CHECK
 * constraint admits merge/split/delete/resolve/separate only — there
 * is no counter-operation type to write, and the ledger is append-only
 * (deleting the separate row is not an option). Recorded as a known
 * gap; a wrong dismissal currently needs a future counter-operation
 * type.
 *
 * @version v0.4.2
 */

import { useState, useEffect } from "react";
import { NavLink, useFetcher, useNavigate } from "react-router";
import {
  GitCompare,
  GitMerge,
  Sparkles,
  CheckCircle2,
  CheckCheck,
} from "lucide-react";
import type { CandidatePair, MatchSignal } from "~/lib/authority-duplicates.server";

export interface PairMeta {
  /** "code · dates · {n} links" line under each record name. */
  metaA: string;
  metaB: string;
}

export function DuplicatesWorklist({
  eyebrow,
  basePath,
  pairs,
  totalPairs,
  truncated,
  meta,
  signalLabels,
  t,
}: {
  eyebrow: string;
  /** e.g. `/admin/entities` — forms merge-workbench and action URLs. */
  basePath: string;
  pairs: CandidatePair[];
  /** Full candidate count before the render cap. */
  totalPairs: number;
  /** True when the computation itself was capped — total is a lower bound. */
  truncated: boolean;
  /** Per-pair meta lines, indexed like `pairs`. */
  meta: PairMeta[];
  /** Signal → chip label (record-type-specific external-id wording). */
  signalLabels: Record<MatchSignal, string>;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const [promptPair, setPromptPair] = useState<CandidatePair | null>(null);
  const [reason, setReason] = useState("");
  const [dismissed, setDismissed] = useState(false);

  // Close the modal and show the banner once the dismissal lands; the
  // route revalidates and the pair drops out of `pairs`.
  useEffect(() => {
    if (fetcher.state === "idle" && (fetcher.data as any)?.ok) {
      setPromptPair(null);
      setReason("");
      setDismissed(true);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-7">
      {/* Page head */}
      <p className="text-11 font-semibold uppercase tracking-[0.12em] text-stone-500">
        {eyebrow}
      </p>
      <h1 className="mt-1 font-serif text-[2rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {t("dupHeading")}
      </h1>
      <p className="mt-2 max-w-[60ch] font-serif text-base leading-[1.6] text-indigo-soft">
        {t("dupIntro")}
      </p>

      {/* Record-type switcher — one nav entry serves both worklists
          (tab-bar idiom, underline tabs) */}
      <nav className="mt-4 flex border-b border-stone-200">
        {[
          { to: "/admin/entities/duplicates", label: t("dupTabEntities") },
          { to: "/admin/places/duplicates", label: t("dupTabPlaces") },
        ].map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `px-4 py-3 text-sm transition-colors duration-150 ${
                isActive
                  ? "border-b-2 border-indigo font-semibold text-stone-700"
                  : "font-normal text-stone-500 hover:text-stone-700"
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Dismissed banner */}
      {dismissed && (
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-verdigris-soft bg-verdigris-tint px-4 py-3">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-verdigris-deep" strokeWidth={1.5} />
          <p className="text-13 text-verdigris-deep">{t("dupDismissedBanner")}</p>
        </div>
      )}

      {pairs.length === 0 ? (
        /* Empty state */
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-stone-200 px-6 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-md bg-verdigris-tint">
            <CheckCheck className="h-5 w-5 text-verdigris-deep" strokeWidth={1.5} />
          </span>
          <p className="font-serif text-xl text-indigo">{t("dupEmptyHeading")}</p>
          <p className="measure-36 text-13 text-stone-500">{t("dupEmptyBody")}</p>
        </div>
      ) : (
        <>
          {/* Count line — the FULL candidate count; a trailing "+" when
              the computation itself was capped, and an explicit
              showing-of note when the render cap hides pairs */}
          <p className="mt-6 text-13 nums text-stone-500">
            <span className="font-semibold text-indigo">
              {totalPairs}
              {truncated ? "+" : ""}
            </span>{" "}
            {t("dupCountLine")}
            {(pairs.length < totalPairs || truncated) && (
              <span className="text-stone-400">
                {" · "}
                {t("dupShowing", {
                  shown: pairs.length,
                  total: `${totalPairs}${truncated ? "+" : ""}`,
                })}
              </span>
            )}
          </p>

          {/* Pair cards */}
          <div className="mt-3 flex flex-col gap-3">
            {pairs.map((pair, i) => (
              <div
                key={`${pair.a.id}|${pair.b.id}`}
                className="rounded-[10px] border border-stone-200 p-4 transition-shadow hover:shadow-sm"
              >
                <div className="grid grid-cols-[1fr_40px_1fr] items-center">
                  <div>
                    <p className="font-serif text-[1.0625rem] text-indigo">
                      {pair.a.name}
                    </p>
                    <p className="font-mono text-13 nums text-stone-500">
                      {meta[i]?.metaA}
                    </p>
                  </div>
                  <div className="flex justify-center">
                    <GitCompare className="h-5 w-5 text-stone-300" strokeWidth={1.5} />
                  </div>
                  <div>
                    <p className="font-serif text-[1.0625rem] text-indigo">
                      {pair.b.name}
                    </p>
                    <p className="font-mono text-13 nums text-stone-500">
                      {meta[i]?.metaB}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-3">
                  {/* Match-signal chips */}
                  <div className="flex flex-wrap gap-1.5">
                    {pair.signals.map((s) => (
                      <span
                        key={s}
                        className="inline-flex items-center gap-1 rounded-full bg-indigo-tint px-2 py-0.5 text-11 text-indigo"
                      >
                        <Sparkles className="h-3 w-3" strokeWidth={1.5} />
                        {signalLabels[s]}
                      </span>
                    ))}
                  </div>
                  {/* Actions */}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPromptPair(pair);
                        setReason("");
                      }}
                      className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-13 font-semibold text-stone-700 hover:bg-stone-50"
                    >
                      {t("dupNotDuplicate")}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        navigate(
                          `${basePath}/${pair.a.id}/merge?survivor=${pair.b.id}`,
                        )
                      }
                      className="inline-flex items-center gap-2 rounded-md bg-indigo px-3 py-1.5 text-13 font-semibold text-parchment hover:bg-indigo-deep"
                    >
                      <GitMerge className="h-4 w-4" strokeWidth={1.5} />
                      {t("dupCompareMerge")}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Required-reason dismissal modal */}
      {promptPair && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,32,58,0.45)]"
          onClick={() => setPromptPair(null)}
        >
          <div
            role="dialog"
            aria-labelledby="dup-dismiss-title"
            className="w-full max-w-[460px] rounded-xl bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="dup-dismiss-title"
              className="font-serif text-xl font-semibold text-indigo"
            >
              {t("dupModalTitle")}
            </h2>
            <p className="mt-2 text-13 text-stone-500">
              {t("dupModalBody", {
                a: promptPair.a.name,
                b: promptPair.b.name,
              })}
            </p>
            <label
              htmlFor="dup-dismiss-reason"
              className="mt-4 block text-11 font-semibold uppercase tracking-wide text-stone-500"
            >
              {t("reasonLabel")}{" "}
              <span className="text-madder-deep">{t("reasonRequired")}</span>
            </label>
            <textarea
              id="dup-dismiss-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              className="mt-1 h-[76px] w-full resize-none rounded-md border border-stone-300 px-3 py-2 text-13 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPromptPair(null)}
                className="rounded-md border border-stone-300 bg-white px-4 py-2 text-13 font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("dupModalCancel")}
              </button>
              <button
                type="button"
                disabled={reason.trim().length === 0 || fetcher.state !== "idle"}
                onClick={() =>
                  fetcher.submit(
                    {
                      _action: "separate",
                      sourceId: promptPair.a.id,
                      targetId: promptPair.b.id,
                      reason,
                    },
                    { method: "post" },
                  )
                }
                className={`rounded-md bg-madder px-4 py-2 text-13 font-semibold text-parchment ${
                  reason.trim().length === 0 || fetcher.state !== "idle"
                    ? "cursor-not-allowed opacity-35"
                    : "hover:bg-madder-deep"
                }`}
              >
                {t("dupNotDuplicate")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
