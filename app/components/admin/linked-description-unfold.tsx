/**
 * Admin — linked-description unfold panel (detail-page worklist)
 *
 * The leaner sibling of the merge/split context card (spec §5 worklist
 * round 3). Opening a worklist row un-truncates its own title in the row
 * itself; THIS panel adds only what the collapsed row does not already
 * show — never a second title, code, or role chip:
 *
 *   - the exact date range (mono) and extent · medium · repository;
 *   - the description's linked records grouped BY ROLE (one small-caps
 *     label per group, plain chips without role prefixes, the current
 *     record highlighted verdigris) — places for a place record; the
 *     description's entities AND places for an entity record;
 *   - the sourced snippet, tagged by tier (scope / OCR), with "Show more"
 *     / "Show all" and, when the name matches more than once in the shown
 *     text, ‹ › steppers that walk the highlights.
 *
 * Highlighting and the match count are derived client-side from the
 * delivered text (`findMatchRanges` over the shipped anchor name), so the
 * count always reflects exactly what is on screen — window, wide window,
 * or the full transcript fetched on "Show all". The full OCR transcript
 * is fetched only on that click (`&full=1`); it is never eager-shipped.
 *
 * @version v0.4.3
 */

import { useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type {
  CardPlace,
  LinkedDescriptionCardData,
} from "~/lib/authority-linked-context.server";
import { findMatchRanges } from "~/lib/snippet-highlight";

/** Group linked records by role, preserving first-appearance order. */
export function groupByRole(
  items: CardPlace[],
): { role: string; items: CardPlace[] }[] {
  const order: string[] = [];
  const byRole = new Map<string, CardPlace[]>();
  for (const item of items) {
    const existing = byRole.get(item.role);
    if (existing) existing.push(item);
    else {
      byRole.set(item.role, [item]);
      order.push(item.role);
    }
  }
  return order.map((role) => ({ role, items: byRole.get(role)! }));
}

/** Exact date range, mono — the catalogued expression verbatim, falling
 * back to the ISO start–end pair; never fabricated. */
function exactDates(card: LinkedDescriptionCardData): string | null {
  if (card.dateExpression) return card.dateExpression;
  if (card.dateStart && card.dateEnd && card.dateStart !== card.dateEnd) {
    return `${card.dateStart} – ${card.dateEnd}`;
  }
  return card.dateStart ?? card.dateEnd ?? null;
}

/** Render `text` with every match of `anchors` wrapped in <mark>; the
 * current match (in the expanded views) carries the solid-saffron style
 * and the ref that scrolls it into view. */
function renderHighlighted(
  text: string,
  anchors: string[],
  currentIdx: number | null,
  curRef: React.RefObject<HTMLElement | null>,
): { nodes: React.ReactNode; count: number } {
  const ranges = findMatchRanges(text, anchors);
  if (ranges.length === 0) return { nodes: text, count: 0 };
  const nodes: React.ReactNode[] = [];
  let pos = 0;
  ranges.forEach((r, i) => {
    if (r.start > pos) nodes.push(text.slice(pos, r.start));
    const isCur = i === currentIdx;
    nodes.push(
      <mark
        key={`m-${i}`}
        ref={isCur ? (curRef as React.RefObject<HTMLElement>) : undefined}
        className={
          isCur
            ? "rounded bg-saffron px-0.5 text-white"
            : "rounded bg-saffron-tint px-0.5 text-indigo-deep"
        }
      >
        {text.slice(r.start, r.end)}
      </mark>,
    );
    pos = r.end;
  });
  if (pos < text.length) nodes.push(text.slice(pos));
  return { nodes, count: ranges.length };
}

type Mode = "short" | "wide" | "all";

export function LinkedDescriptionUnfold({
  card,
  junctionId,
  cardBasePath,
  showEntityGroups,
  roleLabel,
  placeRoleLabel,
  t,
}: {
  card: LinkedDescriptionCardData;
  /** The row's own junction id — the `&full=1` fetch key. */
  junctionId: string;
  /** `/admin/{entities|places}/:id` — base for the on-demand OCR fetch. */
  cardBasePath: string;
  /** Entity record: also render the description's entity groups. */
  showEntityGroups: boolean;
  roleLabel: (role: string) => string;
  placeRoleLabel: (role: string) => string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { snippet } = card;
  const dates = exactDates(card);
  const extent = card.extent;

  const [mode, setMode] = useState<Mode>("short");
  const [current, setCurrent] = useState(0);
  const curRef = useRef<HTMLElement | null>(null);
  const fullFetcher = useFetcher<{ ocrFull: string }>();

  const isOcr = snippet?.source === "ocr";
  const windowText = snippet
    ? snippet.before + snippet.match + snippet.after
    : "";
  const fullOcr =
    fullFetcher.data && typeof fullFetcher.data.ocrFull === "string"
      ? fullFetcher.data.ocrFull
      : null;

  // The text shown for the current mode.
  const shownText =
    mode === "all"
      ? (fullOcr ?? snippet?.wide ?? windowText)
      : mode === "wide"
        ? (snippet?.wide ?? windowText)
        : windowText;

  const anchors = snippet?.anchors ?? [];
  const highlighted = useMemo(
    () => renderHighlighted(shownText, anchors, mode === "short" ? null : current, curRef),
    [shownText, anchors, current, mode],
  );

  const stepTo = (next: number) => {
    const count = highlighted.count;
    if (count === 0) return;
    const idx = ((next % count) + count) % count;
    setCurrent(idx);
    // Defer so the freshly-rendered mark carries the ref.
    requestAnimationFrame(() =>
      curRef.current?.scrollIntoView({ block: "nearest" }),
    );
  };

  const kb = (n: number) => (n / 1000).toFixed(1);
  const showSteppers = mode !== "short" && highlighted.count > 1;

  return (
    <div className="px-4 py-3 text-12">
      {/* Metadata strip — exact dates, extent, repository (no title/code) */}
      {(dates || extent || card.repositoryName) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-stone-500">
          {dates && <span className="font-mono text-11 nums">{dates}</span>}
          {extent && <span>{extent.replace(/\|/g, " · ")}</span>}
          {card.repositoryName && <span>{card.repositoryName}</span>}
        </div>
      )}

      {/* Entity groups (entity records only) */}
      {showEntityGroups &&
        card.entities &&
        groupByRole(card.entities).map((g) => (
          <RoleGroup
            key={`e-${g.role}`}
            label={roleLabel(g.role)}
            items={g.items}
          />
        ))}

      {/* Place groups */}
      {groupByRole(card.places).map((g) => (
        <RoleGroup
          key={`p-${g.role}`}
          label={placeRoleLabel(g.role)}
          items={g.items}
        />
      ))}

      {/* Sourced snippet */}
      {snippet && (
        <div className="mt-2.5 border-t border-dashed border-stone-200 pt-2.5">
          <div className="flex items-baseline gap-2 text-10 font-semibold uppercase tracking-wider text-stone-400">
            {isOcr ? (
              <span className="rounded bg-saffron-tint px-1.5 text-saffron-deep">
                {t("wlSnippetOcr")}
              </span>
            ) : (
              <span>{t("wlSnippetScope")}</span>
            )}
            {snippet.source === "scope-head" && (
              <span className="font-normal normal-case tracking-normal text-stone-400">
                {t("wlSnippetScopeHead")}
              </span>
            )}
            {highlighted.count > 1 && (
              <span className="font-normal normal-case tracking-normal text-stone-500">
                {t("wlMatchCount", { count: highlighted.count })}
              </span>
            )}
            {showSteppers && (
              <span className="ml-auto inline-flex items-center gap-1">
                <button
                  type="button"
                  aria-label={t("wlPrevMatch")}
                  onClick={() => stepTo(current - 1)}
                  className="rounded border border-stone-300 px-1 leading-none text-stone-600 hover:bg-stone-100"
                >
                  ‹
                </button>
                <span className="font-mono text-10 nums text-stone-500">
                  {current + 1} / {highlighted.count}
                </span>
                <button
                  type="button"
                  aria-label={t("wlNextMatch")}
                  onClick={() => stepTo(current + 1)}
                  className="rounded border border-stone-300 px-1 leading-none text-stone-600 hover:bg-stone-100"
                >
                  ›
                </button>
              </span>
            )}
          </div>

          <p
            className={`mt-1.5 font-serif text-13 leading-relaxed text-indigo ${
              mode === "all"
                ? "max-h-[300px] overflow-y-auto whitespace-pre-wrap pr-2"
                : ""
            }`}
          >
            {mode === "short" && snippet.truncatedStart && "… "}
            {isOcr && mode !== "all" && "… "}
            {highlighted.nodes}
            {mode === "short" && snippet.truncatedEnd && " …"}
            {isOcr && mode !== "all" && " …"}
          </p>

          {/* Captions + toggles */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {snippet.wide && (
              <button
                type="button"
                onClick={() => {
                  setMode(mode === "short" ? "wide" : "short");
                  setCurrent(0);
                }}
                className="text-12 font-semibold text-verdigris-deep hover:underline"
              >
                {mode === "short" ? t("wlShowMore") : t("wlShowLess")}
              </button>
            )}
            {isOcr && (
              <button
                type="button"
                onClick={() => {
                  if (mode === "all") {
                    setMode("short");
                    setCurrent(0);
                    return;
                  }
                  if (!fullOcr && fullFetcher.state === "idle") {
                    fullFetcher.load(
                      `${cardBasePath}?card=${encodeURIComponent(junctionId)}&full=1`,
                    );
                  }
                  setMode("all");
                  setCurrent(0);
                }}
                className="text-12 font-semibold text-verdigris-deep hover:underline"
              >
                {mode === "all" ? t("wlShowLess") : t("wlShowAll")}
              </button>
            )}
            {isOcr && snippet.ocrLength != null && (
              <span className="text-11 text-stone-400">
                {mode === "all" && fullFetcher.state !== "idle"
                  ? t("wlOcrLoading")
                  : mode === "all"
                    ? t("wlOcrFullCaption", { kb: kb(snippet.ocrLength) })
                    : mode === "wide"
                      ? t("wlOcrWideCaption")
                      : t("wlOcrWindowCaption", { kb: kb(snippet.ocrLength) })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One small-caps role label with its plain chips (current highlighted). */
function RoleGroup({
  label,
  items,
}: {
  label: string;
  items: CardPlace[];
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="min-w-[72px] text-10 font-semibold uppercase tracking-wider text-stone-400">
        {label}
      </span>
      {items.map((it, i) => (
        <span
          key={`${it.name}-${i}`}
          className={
            it.isCurrent
              ? "inline-flex items-center rounded-full border border-verdigris bg-verdigris-tint px-2 py-0.5 text-11 font-semibold text-verdigris-deep"
              : "inline-flex items-center rounded-full border border-stone-200 bg-white px-2 py-0.5 text-11 text-stone-600"
          }
        >
          {it.name}
        </span>
      ))}
    </div>
  );
}
