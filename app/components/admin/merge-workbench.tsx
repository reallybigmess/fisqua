/**
 * Admin — Merge workbench (full-page)
 *
 * The record-type-agnostic merge surface shared by entities and places
 * (spec §4, design handoff surface 1). The route wrapper loads the
 * loser (`:id`) with its linked descriptions and — once a survivor is
 * chosen — the survivor, then renders this component. Survivor
 * selection and direction-swap are URL transitions (the loader
 * re-renders the server-side comparison); the client state here is the
 * per-card move/stay checklist, the fold-names toggle, and the required
 * reason.
 *
 * Both sides render rich linked-description context cards. The
 * merged-away side is selectable per card (all of a card's junction
 * rows move or stay as one unit); the survivor side is read-only — its
 * links always stay. Every merged-away link moves by default, including
 * links on description cards hidden past the render cap: the client
 * seeds its move set from the loader's full `allLinkIds`, so the cap is
 * a display bound, never a data-loss one.
 *
 * Confirm is gated: disabled until a survivor is set AND the reason is
 * non-empty. The action performs the soft merge (loser keeps its page
 * with `mergedInto` set) and writes the reason into the ledger row's
 * `detail.reason`.
 *
 * @version v0.4.3
 */

import { useState, useMemo, useEffect, useRef } from "react";
import { Form, useNavigate } from "react-router";
import {
  ArrowRight,
  ArrowLeftRight,
  Search,
  GitMerge,
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { LinkedDescriptionContextCard } from "./linked-description-context-card";
import {
  WorkbenchActionBar,
  ACTION_BAR_META_ROW_CLASSES,
} from "./workbench-action-bar";
import type { LinkedDescriptionCardList } from "~/lib/authority-linked-context.server";

export interface ComparisonField {
  key: string;
  label: string;
}

export interface MergeRecord {
  id: string;
  name: string;
  code: string;
  fields: Record<string, string | null>;
}

interface TypeaheadResult {
  id: string;
  displayName: string;
  code: string | null;
}

export function MergeWorkbench({
  eyebrow,
  basePath,
  searchEndpoint,
  loser,
  loserUpdatedAt,
  survivor,
  loserCards,
  survivorCards,
  showAsRecorded,
  roleLabel,
  placeRoleLabel,
  comparisonFields,
  conflictModifiedAt,
  t,
}: {
  eyebrow: string;
  basePath: string;
  searchEndpoint: string;
  loser: MergeRecord;
  loserUpdatedAt: number | string;
  survivor: MergeRecord | null;
  loserCards: LinkedDescriptionCardList;
  survivorCards: LinkedDescriptionCardList | null;
  showAsRecorded: boolean;
  roleLabel: (role: string) => string;
  placeRoleLabel: (role: string) => string;
  comparisonFields: ComparisonField[];
  conflictModifiedAt: number | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const navigate = useNavigate();

  // Move/stay tracked at LINK granularity, seeded from every one of the
  // loser's links (including links on cards hidden past the cap) so the
  // default moves them all. A card toggles all of its junction rows.
  const [moveLinkIds, setMoveLinkIds] = useState<Set<string>>(
    () => new Set(loserCards.allLinkIds),
  );

  const [addVariants, setAddVariants] = useState(false);
  const [reason, setReason] = useState("");

  // Reset selection when the loser's link set changes (survivor swap).
  useEffect(() => {
    setMoveLinkIds(new Set(loserCards.allLinkIds));
  }, [loserCards.allLinkIds]);

  const movedCount = moveLinkIds.size;
  const stayCount = Math.max(0, loserCards.totalLinks - movedCount);

  const cardMoving = (linkIds: string[]) =>
    linkIds.some((id) => moveLinkIds.has(id));

  const toggleCard = (linkIds: string[]) => {
    setMoveLinkIds((prev) => {
      const next = new Set(prev);
      if (cardMoving(linkIds)) {
        for (const id of linkIds) next.delete(id);
      } else {
        for (const id of linkIds) next.add(id);
      }
      return next;
    });
  };

  const confirmDisabled = !survivor || reason.trim().length === 0;
  const moveIdList = useMemo(() => Array.from(moveLinkIds), [moveLinkIds]);

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-7">
      {/* Page head */}
      <p className="text-11 font-semibold uppercase tracking-[0.12em] text-stone-500">
        {eyebrow}
      </p>
      <h1 className="mt-1 font-serif text-[2rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {t("mergeHeading")}
      </h1>
      <p className="mt-2 max-w-[60ch] font-serif text-base leading-[1.6] text-indigo-soft">
        {t("mergeIntro")}
      </p>

      {/* Conflict notice */}
      {conflictModifiedAt != null && (
        <div className="mt-6 rounded-lg border border-madder-soft bg-madder-tint px-4 py-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-madder-deep" strokeWidth={1.5} />
            <div className="flex-1">
              <p className="text-15 font-semibold text-madder-deep">
                {t("conflictTitle")}
              </p>
              <p className="mt-1 text-13 text-madder-deep">
                {t("conflictBody", {
                  time: new Date(conflictModifiedAt).toLocaleString(),
                })}
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => navigate(0)}
                  className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-13 font-semibold text-parchment hover:bg-indigo-deep"
                >
                  <RefreshCw className="h-4 w-4" strokeWidth={1.5} />
                  {t("conflictReload")}
                </button>
                {survivor && (
                  <MergeConfirmForm
                    loserId={loser.id}
                    survivorId={survivor.id}
                    loserUpdatedAt={loserUpdatedAt}
                    reason={reason}
                    addVariants={addVariants}
                    moveIdList={moveIdList}
                    force
                    className="inline-flex items-center gap-2 rounded-md border border-madder-soft bg-white px-4 py-2 text-13 font-semibold text-madder-deep hover:bg-madder-wash"
                    label={t("conflictProceed")}
                    disabled={reason.trim().length === 0}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Record pair */}
      <div className="mt-8 grid grid-cols-[1fr_60px_1fr] items-start gap-0">
        {/* Loser card */}
        <div className="overflow-hidden rounded-[10px] border border-stone-200">
          <div className="bg-madder-tint px-4 py-2">
            <span className="text-11 font-semibold uppercase tracking-wide text-madder-deep">
              {t("mergeThisRecord")}
            </span>
          </div>
          <div className="px-4 py-4">
            <p className="font-serif text-xl text-indigo">{loser.name}</p>
            <p className="mt-1 font-mono text-13 nums text-stone-500">
              {loser.code}
            </p>
          </div>
        </div>

        {/* Swap control */}
        <div className="flex flex-col items-center gap-1 pt-8">
          <ArrowRight className="h-5 w-5 text-stone-400" strokeWidth={1.5} />
          {survivor && (
            <>
              <button
                type="button"
                aria-label={t("mergeSwapDirection")}
                onClick={() =>
                  navigate(
                    `${basePath}/${survivor.id}/merge?survivor=${loser.id}`,
                  )
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-stone-300 bg-white text-stone-500 hover:bg-stone-50"
              >
                <ArrowLeftRight className="h-4 w-4" strokeWidth={1.5} />
              </button>
              <span className="text-10 text-stone-400">
                {t("mergeSwapDirection")}
              </span>
            </>
          )}
        </div>

        {/* Survivor card / typeahead */}
        {survivor ? (
          <div className="overflow-hidden rounded-[10px] border border-verdigris">
            <div className="flex items-center gap-1.5 bg-verdigris-tint px-4 py-2">
              <ShieldCheck className="h-3.5 w-3.5 text-verdigris-deep" strokeWidth={1.5} />
              <span className="text-11 font-semibold uppercase tracking-wide text-verdigris-deep">
                {t("mergeSurvivor")}
              </span>
            </div>
            <div className="px-4 py-4">
              <p className="font-serif text-xl text-indigo">{survivor.name}</p>
              <p className="mt-1 font-mono text-13 nums text-stone-500">
                {survivor.code}
              </p>
            </div>
          </div>
        ) : (
          <SurvivorTypeahead
            searchEndpoint={searchEndpoint}
            excludeId={loser.id}
            basePath={basePath}
            loserId={loser.id}
            t={t}
          />
        )}
      </div>

      {survivor ? (
        <>
          {/* Comparison table */}
          <div className="mt-8 overflow-hidden rounded-lg border border-stone-200">
            <div className="grid grid-cols-[180px_1fr_1fr] bg-stone-50">
              <div className="px-4 py-2 text-11 font-semibold uppercase tracking-wide text-stone-500">
                {t("mergeColField")}
              </div>
              <div className="px-4 py-2 text-11 font-semibold uppercase tracking-wide text-madder-deep">
                {t("mergeColThis")}
              </div>
              <div className="px-4 py-2 text-11 font-semibold uppercase tracking-wide text-verdigris-deep">
                {t("mergeColSurvivor")}
              </div>
            </div>
            {comparisonFields.map((f) => {
              const a = loser.fields[f.key] ?? "";
              const b = survivor.fields[f.key] ?? "";
              const differs = a !== b;
              return (
                <div
                  key={f.key}
                  className={`grid grid-cols-[180px_1fr_1fr] border-t border-stone-100 ${
                    differs ? "bg-madder-wash" : "bg-white"
                  }`}
                >
                  <div className="px-4 py-2 text-13 text-stone-500">
                    {f.label}
                  </div>
                  <div className="px-4 py-2 text-13 text-indigo">
                    {a || "—"}
                  </div>
                  <div className="px-4 py-2 text-13 text-indigo">
                    {b || "—"}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Linked descriptions — survivor side (read-only, always stay) */}
          {survivorCards && (
            <div className="mt-8">
              <div className="flex items-baseline justify-between">
                <h2 className="font-serif text-xl text-indigo">
                  {t("ctxSurvivorHeading")}
                </h2>
                <CardCountLine list={survivorCards} t={t} />
              </div>
              <p className="mt-1 text-13 text-stone-500">{t("ctxSurvivorKept")}</p>
              <CardList
                list={survivorCards}
                showAsRecorded={showAsRecorded}
                roleLabel={roleLabel}
                placeRoleLabel={placeRoleLabel}
                t={t}
              />
            </div>
          )}

          {/* Linked descriptions — merged-away side (selectable) */}
          <div className="mt-8">
            <div className="flex items-baseline justify-between">
              <h2 className="font-serif text-xl text-indigo">
                {t("ctxMergedHeading")}
              </h2>
              <CardCountLine list={loserCards} t={t} />
            </div>

            {stayCount > 0 && (
              <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#E5C878] bg-saffron-tint px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-saffron-deep" strokeWidth={1.5} />
                <p className="text-13 text-saffron-deep">
                  {t("mergeLinksWarning", { count: stayCount })}
                </p>
              </div>
            )}

            <div className="mt-3 overflow-hidden rounded-lg border border-stone-200">
              {loserCards.cards.length === 0 && (
                <p className="px-4 py-6 text-center text-13 text-stone-500">
                  {t("ctxNoLinks")}
                </p>
              )}
              {loserCards.cards.map((card) => {
                const moving = cardMoving(card.linkIds);
                return (
                  <LinkedDescriptionContextCard
                    key={card.descriptionId}
                    card={card}
                    showAsRecorded={showAsRecorded}
                    selectable
                    selected={moving}
                    onToggle={() => toggleCard(card.linkIds)}
                    destinationLabel={
                      moving ? t("mergeDestSurvivor") : t("mergeDestStays")
                    }
                    destinationActive={moving}
                    roleLabel={roleLabel}
                    placeRoleLabel={placeRoleLabel}
                    t={t}
                  />
                );
              })}
              {loserCards.hiddenCards > 0 && (
                <p className="border-t border-stone-100 px-4 py-2 text-13 text-stone-400">
                  {t("ctxAndMore", { count: loserCards.hiddenCards })}
                </p>
              )}
            </div>
          </div>

          {/* Fold names toggle */}
          <div className="mt-8 flex items-center gap-3 rounded-lg border border-stone-200 px-4 py-3">
            <button
              type="button"
              role="switch"
              aria-checked={addVariants}
              onClick={() => setAddVariants((v) => !v)}
              className={`relative h-[22px] w-10 flex-shrink-0 rounded-full transition-colors ${
                addVariants ? "bg-verdigris" : "bg-stone-300"
              }`}
            >
              <span
                className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white transition-all ${
                  addVariants ? "left-[20px]" : "left-0.5"
                }`}
              />
            </button>
            <div>
              <p className="text-15 font-semibold text-indigo">
                {t("mergeFoldNames")}
              </p>
              <p className="text-13 text-stone-500">{t("mergeFoldNamesHelper")}</p>
            </div>
          </div>
        </>
      ) : (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-stone-200 py-12">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-tint">
            <GitMerge className="h-5 w-5 text-indigo" strokeWidth={1.5} />
          </span>
          <p className="text-15 text-stone-500">{t("mergeSelectSurvivor")}</p>
        </div>
      )}

      {/* Sticky action bar — positioning contract (sticky-in-column,
          opaque bg, z-20) lives in workbench-action-bar.tsx. */}
      <WorkbenchActionBar>
        <div className="flex items-end gap-6">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="merge-reason"
              className="text-11 font-semibold uppercase tracking-wide text-stone-500"
            >
              {t("reasonLabel")}{" "}
              <span className="text-madder-deep">{t("reasonRequired")}</span>
            </label>
            <input
              id="merge-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              className="mt-1.5 w-full rounded-md border border-stone-300 px-3 py-2 text-13 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
          <div className="shrink-0">
            {survivor ? (
              <MergeConfirmForm
                loserId={loser.id}
                survivorId={survivor.id}
                loserUpdatedAt={loserUpdatedAt}
                reason={reason}
                addVariants={addVariants}
                moveIdList={moveIdList}
                className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2.5 text-13 font-semibold text-parchment ${
                  confirmDisabled
                    ? "cursor-not-allowed opacity-30"
                    : "hover:bg-indigo-deep"
                }`}
                label={t("mergeConfirm", { name: survivor.name })}
                disabled={confirmDisabled}
                icon
              />
            ) : (
              <button
                type="button"
                disabled
                className="inline-flex cursor-not-allowed items-center gap-2 rounded-md bg-indigo px-4 py-2.5 text-13 font-semibold text-parchment opacity-30"
              >
                <GitMerge className="h-4 w-4" strokeWidth={1.5} />
                {t("mergeConfirmGeneric")}
              </button>
            )}
          </div>
        </div>
        {survivor && (
          <div className={ACTION_BAR_META_ROW_CLASSES}>
            <p className="text-13 nums text-stone-500">
              {t("mergeSummary", {
                moved: movedCount,
                stay: stayCount,
              })}
            </p>
          </div>
        )}
      </WorkbenchActionBar>
    </div>
  );
}

/** Honest count line: "Showing {shown} of {cards} · {links} links". */
function CardCountLine({
  list,
  t,
}: {
  list: LinkedDescriptionCardList;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <p className="text-13 nums text-stone-500">
      {t("ctxShowing", {
        shown: list.cards.length,
        cards: list.totalCards,
        links: list.totalLinks,
      })}
    </p>
  );
}

function CardList({
  list,
  showAsRecorded,
  roleLabel,
  placeRoleLabel,
  t,
}: {
  list: LinkedDescriptionCardList;
  showAsRecorded: boolean;
  roleLabel: (role: string) => string;
  placeRoleLabel: (role: string) => string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-stone-200">
      {list.cards.length === 0 && (
        <p className="px-4 py-6 text-center text-13 text-stone-500">
          {t("ctxNoLinks")}
        </p>
      )}
      {list.cards.map((card) => (
        <LinkedDescriptionContextCard
          key={card.descriptionId}
          card={card}
          showAsRecorded={showAsRecorded}
          roleLabel={roleLabel}
          placeRoleLabel={placeRoleLabel}
          t={t}
        />
      ))}
      {list.hiddenCards > 0 && (
        <p className="border-t border-stone-100 px-4 py-2 text-13 text-stone-400">
          {t("ctxAndMore", { count: list.hiddenCards })}
        </p>
      )}
    </div>
  );
}

function MergeConfirmForm({
  loserId,
  survivorId,
  loserUpdatedAt,
  reason,
  addVariants,
  moveIdList,
  className,
  label,
  disabled,
  force,
  icon,
}: {
  loserId: string;
  survivorId: string;
  loserUpdatedAt: number | string;
  reason: string;
  addVariants: boolean;
  moveIdList: string[];
  className: string;
  label: string;
  disabled: boolean;
  force?: boolean;
  icon?: boolean;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="_action" value="merge" />
      <input type="hidden" name="loserId" value={loserId} />
      <input type="hidden" name="survivorId" value={survivorId} />
      <input type="hidden" name="_updatedAt" value={String(loserUpdatedAt)} />
      {force && <input type="hidden" name="_force" value="true" />}
      <input type="hidden" name="reason" value={reason} />
      <input type="hidden" name="addVariants" value={addVariants ? "true" : "false"} />
      <input type="hidden" name="linkIds" value={JSON.stringify(moveIdList)} />
      <button type="submit" disabled={disabled} className={className}>
        {icon && <GitMerge className="h-4 w-4" strokeWidth={1.5} />}
        {label}
      </button>
    </Form>
  );
}

function SurvivorTypeahead({
  searchEndpoint,
  excludeId,
  basePath,
  loserId,
  t,
}: {
  searchEndpoint: string;
  excludeId: string;
  basePath: string;
  loserId: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TypeaheadResult[]>([]);
  const [focused, setFocused] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          _search: "true",
          q: query.trim(),
          exclude: excludeId,
        });
        const res = await fetch(`${searchEndpoint}?${params}`);
        if (res.ok) {
          setResults((await res.json()) as TypeaheadResult[]);
        }
      } catch {
        /* silent */
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, searchEndpoint, excludeId]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" strokeWidth={1.5} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder={t("mergeSearchPlaceholder")}
          className={`w-full rounded-[10px] border py-2.5 pl-9 pr-3 text-15 focus:outline-none ${
            focused
              ? "border-indigo ring-1 ring-indigo"
              : "border-stone-300"
          }`}
        />
      </div>
      {focused && results.length > 0 && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-stone-200 bg-white shadow-md">
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                navigate(`${basePath}/${loserId}/merge?survivor=${r.id}`)
              }
              className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-verdigris-wash ${
                i === 0 ? "bg-verdigris-wash" : ""
              }`}
            >
              <span className="font-serif text-15 text-indigo">
                {r.displayName}
              </span>
              <span className="font-mono text-13 nums text-stone-500">
                {r.code ?? ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
