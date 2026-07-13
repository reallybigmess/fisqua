/**
 * Admin — Split workbench (full-page)
 *
 * The record-type-agnostic split surface shared by entities and places
 * (spec §4, design handoff surface 2). Nothing copies silently: a
 * unified assignment table gives every field an Original / Both / New
 * choice (external-ID rows are exactly-one-side), both halves get
 * editable, distinct names, and the linked descriptions are divided by
 * rich context card. Confirm is gated until every row is assigned, the
 * two names differ, and a reason is present; the action writes the
 * reason into the ledger row's `detail.reason`.
 *
 * A description is assigned AS ONE UNIT: one control routes all of that
 * description's junction rows to the new record together, so a
 * multi-role description never straddles the two halves. The ledger
 * still counts junction rows (`movedLinks`), unchanged by the grouping.
 *
 * @version v0.4.3
 */

import { useState, useMemo } from "react";
import { Form, useNavigate } from "react-router";
import { GitFork, CircleX, Info, AlertTriangle, RefreshCw } from "lucide-react";
import { LinkedDescriptionContextCard } from "./linked-description-context-card";
import {
  WorkbenchActionBar,
  ACTION_BAR_META_ROW_CLASSES,
} from "./workbench-action-bar";
import type { LinkedDescriptionCardList } from "~/lib/authority-linked-context.server";

export interface SplitFieldRow {
  key: string;
  label: string;
  value: string | null;
  /** three = Original/Both/New; twoSided = Original/New (external IDs). */
  mode: "three" | "twoSided";
}

type Choice = "" | "original" | "both" | "new";

export function SplitWorkbench({
  eyebrow,
  record,
  recordCode,
  cards,
  showAsRecorded,
  roleLabel,
  placeRoleLabel,
  fieldRows,
  nameVariantRows,
  initialName,
  nameLabel,
  recordUpdatedAt,
  conflictModifiedAt,
  t,
}: {
  eyebrow: string;
  record: string;
  recordCode: string;
  cards: LinkedDescriptionCardList;
  showAsRecorded: boolean;
  roleLabel: (role: string) => string;
  placeRoleLabel: (role: string) => string;
  fieldRows: SplitFieldRow[];
  nameVariantRows: SplitFieldRow[];
  initialName: string;
  nameLabel: string;
  recordUpdatedAt: number | string;
  conflictModifiedAt: number | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const navigate = useNavigate();
  const allRows = useMemo(
    () => [...fieldRows, ...nameVariantRows],
    [fieldRows, nameVariantRows],
  );

  const [choices, setChoices] = useState<Record<string, Choice>>(() => {
    const init: Record<string, Choice> = {};
    for (const r of allRows) init[r.key] = "";
    return init;
  });
  const [nameA, setNameA] = useState(initialName);
  const [nameB, setNameB] = useState(initialName);
  // Description ids routed to the new record. A whole description (all
  // its junction rows) moves as one unit — never split across halves.
  const [toNew, setToNew] = useState<Set<string>>(() => new Set());
  const [reason, setReason] = useState("");

  const setChoice = (key: string, choice: Choice) =>
    setChoices((prev) => ({ ...prev, [key]: choice }));

  const toggleCard = (descriptionId: string) =>
    setToNew((prev) => {
      const next = new Set(prev);
      if (next.has(descriptionId)) next.delete(descriptionId);
      else next.add(descriptionId);
      return next;
    });

  const unassignedCount = allRows.filter((r) => choices[r.key] === "").length;
  const namesIdentical =
    nameA.trim() === nameB.trim() || nameB.trim().length === 0;
  const reasonEmpty = reason.trim().length === 0;
  const confirmDisabled = unassignedCount > 0 || namesIdentical || reasonEmpty;

  const blocker =
    unassignedCount > 0
      ? t("splitBlockerUnassigned", { count: unassignedCount })
      : namesIdentical
        ? t("splitBlockerNames")
        : reasonEmpty
          ? t("splitBlockerReason")
          : "";

  const newCardCount = toNew.size;
  const originalCardCount = Math.max(0, cards.totalCards - newCardCount);

  // The junction-row ids to route to the new record — every link on a
  // routed description card, flattened (the action moves each one).
  const linkIdsToNew = useMemo(
    () =>
      cards.cards
        .filter((c) => toNew.has(c.descriptionId))
        .flatMap((c) => c.linkIds),
    [cards.cards, toNew],
  );

  const originalSummary = t("splitDescriptionsUnit", { count: originalCardCount });
  const newSummary = t("splitDescriptionsUnit", { count: newCardCount });

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-7">
      {/* Page head */}
      <p className="text-11 font-semibold uppercase tracking-[0.12em] text-stone-500">
        {eyebrow}
      </p>
      <h1 className="mt-1 font-serif text-[2rem] font-semibold leading-[1.2] tracking-[-0.005em] text-indigo">
        {t("splitHeading")}
      </h1>
      <p className="mt-2 max-w-[60ch] font-serif text-base leading-[1.6] text-indigo-soft">
        {t("splitIntro")}
      </p>

      {/* Conflict notice */}
      {conflictModifiedAt != null && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-madder-soft bg-madder-tint px-4 py-3">
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
            <button
              type="button"
              onClick={() => navigate(0)}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-13 font-semibold text-parchment hover:bg-indigo-deep"
            >
              <RefreshCw className="h-4 w-4" strokeWidth={1.5} />
              {t("conflictReload")}
            </button>
          </div>
        </div>
      )}

      {/* Record banner */}
      <div className="mt-6 flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-indigo-tint">
          <GitFork className="h-4 w-4 text-indigo" strokeWidth={1.5} />
        </span>
        <div>
          <p className="font-serif text-lg text-indigo">{record}</p>
          <p className="font-mono text-13 nums text-stone-500">
            {recordCode} · {t("splitLinkedCount", { count: cards.totalLinks })}
          </p>
        </div>
      </div>

      {/* Assignment table */}
      <div className="mt-8 overflow-hidden rounded-lg border border-stone-200">
        <div className="grid grid-cols-[230px_1fr] bg-stone-50">
          <div className="px-4 py-2 text-11 font-semibold uppercase tracking-wide text-stone-500">
            {t("splitColField")}
          </div>
          <div className="px-4 py-2 text-11 font-semibold uppercase tracking-wide text-stone-500">
            {t("splitColGoesTo")}
          </div>
        </div>

        {/* Name row (special) */}
        <div className="grid grid-cols-[230px_1fr] border-t border-stone-200 px-4 py-3">
          <div className="text-15 font-semibold text-indigo">{nameLabel}</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-11 text-stone-500">
                {t("splitNameOriginal")}
              </label>
              <input
                type="text"
                value={nameA}
                onChange={(e) => setNameA(e.target.value)}
                className="mt-1 w-full rounded-md border border-stone-300 px-3 py-1.5 text-13 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              />
            </div>
            <div>
              <label className="text-11 text-stone-500">
                {t("splitNameNew")}
              </label>
              <input
                type="text"
                value={nameB}
                onChange={(e) => setNameB(e.target.value)}
                className={`mt-1 w-full rounded-md border px-3 py-1.5 text-13 focus:outline-none focus:ring-1 ${
                  namesIdentical
                    ? "border-madder ring-1 ring-madder"
                    : "border-stone-300 focus:border-indigo focus:ring-indigo"
                }`}
              />
              {namesIdentical && nameB.trim().length > 0 && (
                <p className="mt-1 flex items-center gap-1 text-11 text-madder-deep">
                  <CircleX className="h-3.5 w-3.5" strokeWidth={1.5} />
                  {t("splitNamesIdentical")}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Field rows */}
        {allRows.map((r) => {
          const choice = choices[r.key];
          const unassigned = choice === "";
          return (
            <div
              key={r.key}
              className={`grid grid-cols-[230px_1fr] items-center border-t border-stone-200 px-4 py-3 ${
                unassigned ? "bg-madder-wash" : "bg-white"
              }`}
            >
              <div>
                <p className="text-15 font-semibold text-indigo">{r.label}</p>
                {r.value && (
                  <p className="font-mono text-13 text-stone-500">{r.value}</p>
                )}
                {unassigned && (
                  <p className="text-11 font-semibold text-madder-deep">
                    {t("splitUnassigned")}
                  </p>
                )}
              </div>
              <div className="flex gap-1.5">
                <SegButton
                  active={choice === "original"}
                  onClick={() => setChoice(r.key, "original")}
                  label={t("splitOriginal")}
                />
                {r.mode === "three" && (
                  <SegButton
                    active={choice === "both"}
                    onClick={() => setChoice(r.key, "both")}
                    label={t("splitBoth")}
                  />
                )}
                <SegButton
                  active={choice === "new"}
                  onClick={() => setChoice(r.key, "new")}
                  label={t("splitNew")}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Divide linked descriptions */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif text-xl text-indigo">
            {t("splitDivideHeading")}
          </h2>
          <p className="text-13 nums text-stone-500">
            {t("ctxShowing", {
              shown: cards.cards.length,
              cards: cards.totalCards,
              links: cards.totalLinks,
            })}
          </p>
        </div>
        <p className="text-13 text-stone-500">{t("splitDivideNote")}</p>
        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200">
          {cards.cards.length === 0 && (
            <p className="px-4 py-6 text-center text-13 text-stone-500">
              {t("ctxNoLinks")}
            </p>
          )}
          {cards.cards.map((card) => {
            const routed = toNew.has(card.descriptionId);
            return (
              <LinkedDescriptionContextCard
                key={card.descriptionId}
                card={card}
                showAsRecorded={showAsRecorded}
                selectable
                selected={routed}
                onToggle={() => toggleCard(card.descriptionId)}
                destinationLabel={
                  routed ? t("splitDestNew") : t("splitDestOriginal")
                }
                destinationActive={routed}
                roleLabel={roleLabel}
                placeRoleLabel={placeRoleLabel}
                t={t}
              />
            );
          })}
          {cards.hiddenCards > 0 && (
            <p className="border-t border-stone-100 px-4 py-2 text-13 text-stone-400">
              {t("ctxAndMore", { count: cards.hiddenCards })}
            </p>
          )}
        </div>
      </div>

      {/* Sticky action bar — positioning contract (sticky-in-column,
          opaque bg, z-20) lives in workbench-action-bar.tsx. */}
      <WorkbenchActionBar>
        <div className="flex items-end gap-6">
          <div className="min-w-0 flex-1">
            <label
              htmlFor="split-reason"
              className="text-11 font-semibold uppercase tracking-wide text-stone-500"
            >
              {t("reasonLabel")}{" "}
              <span className="text-madder-deep">{t("reasonRequired")}</span>
            </label>
            <input
              id="split-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              className="mt-1.5 w-full rounded-md border border-stone-300 px-3 py-2 text-13 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
          <Form method="post" className="shrink-0">
            <input type="hidden" name="_action" value="split" />
            <input type="hidden" name="_updatedAt" value={String(recordUpdatedAt)} />
            <input type="hidden" name="nameA" value={nameA} />
            <input type="hidden" name="nameB" value={nameB} />
            <input type="hidden" name="reason" value={reason} />
            <input type="hidden" name="choices" value={JSON.stringify(choices)} />
            <input
              type="hidden"
              name="linkIds"
              value={JSON.stringify(linkIdsToNew)}
            />
            <button
              type="submit"
              disabled={confirmDisabled}
              className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2.5 text-13 font-semibold text-parchment ${
                confirmDisabled
                  ? "cursor-not-allowed opacity-30"
                  : "hover:bg-indigo-deep"
              }`}
            >
              <GitFork className="h-4 w-4" strokeWidth={1.5} />
              {t("splitConfirm")}
            </button>
          </Form>
        </div>
        <div className={ACTION_BAR_META_ROW_CLASSES}>
          <p className="text-13 text-stone-500">
            {t("splitSummaryOriginal", { summary: originalSummary })}
            {" · "}
            <span className="text-verdigris-deep">
              {t("splitSummaryNew", { summary: newSummary })}
            </span>
          </p>
          {blocker && (
            <p className="flex items-center gap-1 text-13 text-madder-deep">
              <Info className="h-4 w-4" strokeWidth={1.5} />
              {blocker}
            </p>
          )}
        </div>
      </WorkbenchActionBar>
    </div>
  );
}

function SegButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-[30px] rounded-md border px-3 text-13 ${
        active
          ? "border-indigo bg-indigo font-semibold text-parchment"
          : "border-stone-300 bg-white text-stone-500 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );
}
