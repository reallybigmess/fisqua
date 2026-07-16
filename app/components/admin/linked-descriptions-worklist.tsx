/**
 * Admin — linked-descriptions worklist (shared by entity + place detail)
 *
 * The right column of the authority record page (spec §5, worklist round
 * 3, mockup 2026-07-12). The record's linked descriptions arrive as ONE
 * server-filtered page — never the whole set (Tunja: 13,237). Anatomy:
 *
 *   - Header: a small-caps section title + count badge matching the left
 *     column's card-title register, and "+ Link a description" as a
 *     compact bordered button in the title row.
 *   - Controls, revealed by progressive disclosure: search + sort appear
 *     only when the record's links exceed 5; the page-size select only
 *     above 25; the repository pills only when the links span more than
 *     one repository. Role and repository pills compose with search, and
 *     every count is a real COUNT computed under the OTHER filter
 *     (cross-honest — the loader's job).
 *   - Rows: a serif title (truncated collapsed, wrapping when open); the
 *     ROLE CHIP is the edit control (pencil inside; the whole chip opens
 *     the existing role modal); year-granular dates with the exact ISO
 *     range as the row tooltip; a second line of reference code +
 *     creator/place; and an isolated unlink button. Row chips do NOT
 *     filter — one gesture never means two things.
 *   - Unfold: a leading chevron opens the leaner sibling context panel
 *     (`LinkedDescriptionUnfold`) beneath the row, fetched on demand
 *     (`?card=<junctionId>`), one at a time, cached on re-open.
 *
 * On a superseded record the whole worklist dims and goes inert, and the
 * heading count reads redirected.
 *
 * @version v0.4.3
 */

import { useState, useEffect } from "react";
import { Link, useSearchParams, useFetcher } from "react-router";
import { Plus, Search, Pencil, X, ChevronRight } from "lucide-react";
import type { TFunction } from "i18next";
import {
  setWorklistParam,
  WORKLIST_SIZES,
  type WorklistSort,
} from "~/lib/worklist-params";
import { LinkDescriptionDialog } from "~/components/admin/link-description-dialog";
import { EditDescriptionLinkDialog } from "~/components/admin/edit-description-link-dialog";
import { LinkedDescriptionUnfold } from "~/components/admin/linked-description-unfold";
import type { LinkedDescriptionCardData } from "~/lib/authority-linked-context.server";

export interface WorklistLink {
  id: string;
  descriptionId: string;
  role: string;
  roleNote: string | null;
  sequence?: number | null;
  honorific?: string | null;
  function?: string | null;
  nameAsRecorded?: string | null;
  descriptionTitle: string;
  referenceCode: string;
  descriptionLevel: string;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  /** Denormalised display columns off the descriptions row — rendered
   * compactly on the collapsed row, never a join. */
  creatorDisplay?: string | null;
  placeDisplay?: string | null;
}

/** The row's exact date label (row TOOLTIP + no other use): the
 * catalogued expression verbatim, falling back to the ISO start–end
 * pair, never fabricated. */
export function linkDateLabel(l: {
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
}): string {
  if (l.dateExpression) return l.dateExpression;
  if (l.dateStart && l.dateEnd && l.dateStart !== l.dateEnd) {
    return `${l.dateStart} .. ${l.dateEnd}`;
  }
  if (l.dateStart) return l.dateStart;
  if (l.dateEnd) return l.dateEnd;
  return "—";
}

/** The row's visible date: year-granular ("1830", "1828–1829") for
 * scanning. Prefers the ISO start/end years; falls back to the
 * catalogued expression when there is no structured range; never
 * fabricated. */
export function linkYearLabel(l: {
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
}): string {
  const ys = l.dateStart ? l.dateStart.slice(0, 4) : null;
  const ye = l.dateEnd ? l.dateEnd.slice(0, 4) : null;
  if (ys || ye) {
    const a = (ys ?? ye)!;
    const b = (ye ?? ys)!;
    return a === b ? a : `${a}–${b}`;
  }
  if (l.dateExpression) return l.dateExpression;
  return "—";
}

/**
 * Progressive-disclosure gates, computed from the record's UNFILTERED
 * totals (spec §5.2, amended 2026-07-12): search + sort AND the role/repo
 * pills surface only above 5 links — at ≤5 the whole control row is absent
 * (the approved mockup's single-link panels), because the few rows show
 * their own roles. The page-size select surfaces only above 25 links; the
 * repository pills only when the links span more than one repository, and
 * never below the 5-link control-row threshold. Pure so the thresholds are
 * regression-tested without rendering. */
export function worklistDisclosure(
  recordTotal: number,
  repoSpan: number,
): { showSearchSort: boolean; showSizeSelect: boolean; showRepoPills: boolean } {
  const showSearchSort = recordTotal > 5;
  return {
    showSearchSort,
    showSizeSelect: recordTotal > 25,
    showRepoPills: showSearchSort && repoSpan > 1,
  };
}

export function LinkedDescriptionsWorklist({
  links,
  total,
  allCount,
  recordTotal,
  roleCounts,
  repoCounts,
  repoSpan,
  dq,
  role,
  repo,
  sort,
  size,
  page,
  isMerged,
  roles,
  recordId,
  recordType,
  showEntityFields,
  roleLabel,
  placeRoleLabel,
  t,
  ta,
}: {
  /** The current server page of links. */
  links: WorklistLink[];
  /** Honest filtered total (dq + role + repo applied) from a real COUNT. */
  total: number;
  /** Honest search+repo-scoped total across all roles (the "All" pill). */
  allCount: number;
  /** The record's UNFILTERED link total (descLinkCount) — the heading
   * count and the progressive-disclosure threshold. */
  recordTotal: number;
  /** Real GROUP BY counts per role, computed under search + repo. */
  roleCounts: { role: string; count: number }[];
  /** Real GROUP BY counts per repository (keyed by id, labelled
   * short_name → code → name), computed under search + role. */
  repoCounts: { repositoryId: string; label: string; count: number }[];
  /** Distinct repositories the record's links span (unfiltered) — the
   * pills show only when this exceeds 1. */
  repoSpan: number;
  dq: string;
  role: string | null;
  repo: string | null;
  sort: WorklistSort;
  size: number;
  page: number;
  isMerged: boolean;
  roles: readonly string[];
  recordId: string;
  recordType: "entity" | "place";
  showEntityFields: boolean;
  roleLabel: (role: string) => string;
  /** Place-role label for the context card's metadata strip (an entity
   * card can list places under their own roles). Place records pass the
   * same function as `roleLabel`. */
  placeRoleLabel: (role: string) => string;
  /** The record type's namespace (linked_descriptions, role_*, dialogs). */
  t: TFunction;
  /** The shared authorities namespace (worklist chrome strings). */
  ta: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [confirmRemoveLinkId, setConfirmRemoveLinkId] = useState<
    string | null
  >(null);
  const unlinkFetcher = useFetcher();

  // Click-to-unfold context panel. One open at a time; fetched payloads
  // are cached so re-opening a row never re-hits the loader.
  const [expandedLinkId, setExpandedLinkId] = useState<string | null>(null);
  const [cardCache, setCardCache] = useState<
    Record<string, LinkedDescriptionCardData | null>
  >({});
  const cardFetcher = useFetcher<{ card: LinkedDescriptionCardData | null }>();
  const cardBasePath =
    recordType === "place"
      ? `/admin/places/${recordId}`
      : `/admin/entities/${recordId}`;

  const toggleCard = (linkId: string) => {
    if (expandedLinkId === linkId) {
      setExpandedLinkId(null);
      return;
    }
    setExpandedLinkId(linkId);
    if (!(linkId in cardCache)) {
      cardFetcher.load(`${cardBasePath}?card=${encodeURIComponent(linkId)}`);
    }
  };

  // Land a fetched card in the cache keyed by the row it was requested
  // for (only one load is ever in flight — a new toggle replaces it).
  useEffect(() => {
    if (cardFetcher.state === "idle" && cardFetcher.data) {
      const requested = cardFetcher.data.card;
      if (expandedLinkId && !(expandedLinkId in cardCache)) {
        setCardCache((prev) => ({ ...prev, [expandedLinkId]: requested }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardFetcher.state, cardFetcher.data]);

  // Search input: the debounce-then-navigate idiom the list pages use.
  const [searchInput, setSearchInput] = useState(dq);
  const [debouncedSearch, setDebouncedSearch] = useState(dq);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    if (debouncedSearch !== dq) {
      setSearchParams(
        setWorklistParam(searchParams, "dq", debouncedSearch || null),
        { replace: true },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const setParam = (
    name: "role" | "repo" | "sort" | "size" | "dpage",
    value: string | null,
  ) => {
    setSearchParams(setWorklistParam(searchParams, name, value), {
      replace: true,
    });
  };

  const pages = Math.max(1, Math.ceil(total / size));
  const hasFilters = !!dq || !!role || !!repo;
  const editLink = editingLinkId
    ? links.find((l) => l.id === editingLinkId)
    : undefined;

  // Progressive disclosure (spec §5.2): controls surface only when they
  // can act on the record's own scale — role/repo pills gate with search
  // + sort above 5 links (worklistDisclosure).
  const { showSearchSort, showSizeSelect, showRepoPills } = worklistDisclosure(
    recordTotal,
    repoSpan,
  );

  return (
    <div className={isMerged ? "pointer-events-none opacity-55" : ""}>
      {/* Heading + link affordance (left column's card-title register) */}
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-11 font-bold uppercase tracking-[0.12em] text-stone-500">
          {t("linked_descriptions")}{" "}
          <span className="nums font-normal normal-case tracking-normal text-stone-400">
            {isMerged ? ta("bandRedirectedCount") : `(${recordTotal})`}
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setShowLinkDialog(true)}
          className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg border border-verdigris-tint bg-verdigris-wash px-3 py-1 text-12 font-semibold text-verdigris-deep hover:bg-verdigris-tint"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("add_description_link")}
        </button>
      </div>

      {/* Control row: search + sort + size (disclosed above 5 / 25) */}
      {showSearchSort && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-500" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={ta("wlSearchPlaceholder")}
              aria-label={ta("wlSearchPlaceholder")}
              className="h-[30px] w-full rounded-lg border border-stone-300 pl-8 pr-3 font-sans text-13 shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
          <select
            value={sort}
            aria-label={ta("wlSortAria")}
            onChange={(e) => setParam("sort", e.target.value)}
            className="ml-auto h-[30px] flex-shrink-0 rounded-lg border border-stone-300 bg-white px-2.5 text-12 font-semibold text-stone-600 focus:border-indigo focus:outline-none"
          >
            <option value="date">{ta("wlSortDate")}</option>
            <option value="title">{ta("wlSortTitle")}</option>
            <option value="code">{ta("wlSortCode")}</option>
          </select>
          {showSizeSelect && (
            <select
              value={String(size)}
              aria-label={ta("wlSizeAria")}
              onChange={(e) => setParam("size", e.target.value)}
              className="h-[30px] flex-shrink-0 rounded-lg border border-stone-300 bg-white px-2.5 text-12 font-semibold text-stone-600 focus:border-indigo focus:outline-none"
            >
              {WORKLIST_SIZES.map((s) => (
                <option key={s} value={String(s)}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Filter pill groups: role, then (when multi-repo) repository.
          Disclosure-gated with search + sort — absent at ≤5 links, where
          the few rows already show their roles (mockup single-link panels). */}
      {showSearchSort && (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="text-11 text-stone-400">{ta("wlFilterByRole")}</span>
        <button
          type="button"
          aria-pressed={role === null}
          onClick={() => setParam("role", null)}
          className={pillClass(role === null)}
        >
          {ta("wlAll")}
          <span className="font-mono text-11 nums text-stone-400">
            {allCount}
          </span>
        </button>
        {roleCounts.map((rc) => (
          <button
            key={rc.role}
            type="button"
            aria-pressed={role === rc.role}
            onClick={() => setParam("role", role === rc.role ? null : rc.role)}
            className={pillClass(role === rc.role)}
          >
            {roleLabel(rc.role)}
            <span className="font-mono text-11 nums text-stone-400">
              {rc.count}
            </span>
          </button>
        ))}

        {showRepoPills && (
          <>
            <span className="mx-1 inline-block h-4 w-px bg-stone-200" />
            <span className="text-11 text-stone-400">
              {ta("wlFilterByRepo")}
            </span>
            {repoCounts.map((rc) => (
              <button
                key={rc.repositoryId}
                type="button"
                aria-pressed={repo === rc.repositoryId}
                onClick={() =>
                  setParam(
                    "repo",
                    repo === rc.repositoryId ? null : rc.repositoryId,
                  )
                }
                className={repoPillClass(repo === rc.repositoryId)}
              >
                {rc.label}
                <span
                  className={`font-mono text-11 nums ${
                    repo === rc.repositoryId ? "text-verdigris-tint" : "text-stone-400"
                  }`}
                >
                  {rc.count}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
      )}

      {/* Honest count line */}
      <p className="mt-2 text-12 nums text-stone-500">
        {ta("wlShowing", { shown: links.length, total })}
      </p>

      {/* Rows */}
      {links.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">
          {hasFilters ? ta("wlNoMatches") : t("no_linked_descriptions")}
        </p>
      ) : (
        <div className="mt-2 overflow-hidden rounded-lg border border-stone-200">
          {links.map((link) =>
            confirmRemoveLinkId === link.id ? (
              <div
                key={link.id}
                className="flex items-center gap-3 border-b border-stone-100 bg-madder-wash px-4 py-3 text-sm last:border-b-0"
              >
                <span className="text-stone-700">
                  {t("remove_link_confirm")}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    unlinkFetcher.submit(
                      { _action: "unlink_description", linkId: link.id },
                      { method: "post" },
                    );
                    setConfirmRemoveLinkId(null);
                  }}
                  className="font-semibold text-madder hover:underline"
                >
                  {t("remove_link")}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemoveLinkId(null)}
                  className="text-stone-500 hover:text-stone-700"
                >
                  {t("mergeCancel")}
                </button>
              </div>
            ) : (
              <div
                key={link.id}
                className="border-b border-stone-100 last:border-b-0"
              >
                <div className="flex items-start gap-2.5 px-4 py-2.5">
                  <button
                    type="button"
                    aria-expanded={expandedLinkId === link.id}
                    aria-controls={`wl-card-${link.id}`}
                    aria-label={ta("wlToggleCard")}
                    onClick={() => toggleCard(link.id)}
                    className="mt-0.5 rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-700"
                  >
                    <ChevronRight
                      className={`h-4 w-4 transition-transform ${
                        expandedLinkId === link.id ? "rotate-90" : ""
                      }`}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/admin/descriptions/${link.descriptionId}`}
                      className={`block font-serif text-[15px] font-semibold text-indigo hover:text-verdigris-deep hover:underline ${
                        expandedLinkId === link.id ? "" : "truncate"
                      }`}
                    >
                      {link.descriptionTitle}
                    </Link>
                    <p className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-11 text-stone-500">
                      <span className="flex-shrink-0 font-mono text-stone-400">
                        {link.referenceCode}
                      </span>
                      {(link.creatorDisplay || link.placeDisplay) && (
                        <span className="min-w-0 truncate">
                          {[link.creatorDisplay, link.placeDisplay]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2.5 pt-0.5">
                    <button
                      type="button"
                      aria-label={t("edit_link")}
                      onClick={() => setEditingLinkId(link.id)}
                      className="group inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-indigo-wash py-0.5 pl-2.5 pr-1 text-11 font-semibold text-stone-500 hover:border-stone-400"
                    >
                      {roleLabel(link.role)}
                      <span className="flex h-4 w-4 items-center justify-center rounded-full text-stone-400 group-hover:bg-white group-hover:text-indigo">
                        <Pencil className="h-3 w-3" />
                      </span>
                    </button>
                    <span
                      title={linkDateLabel(link)}
                      className="min-w-[52px] whitespace-nowrap text-right font-mono text-11 nums text-stone-400"
                    >
                      {linkYearLabel(link)}
                    </span>
                    <button
                      type="button"
                      aria-label={t("remove_link")}
                      onClick={() => setConfirmRemoveLinkId(link.id)}
                      className="rounded p-1 text-stone-400 hover:bg-madder-wash hover:text-madder-deep"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                {expandedLinkId === link.id && (
                  <div
                    id={`wl-card-${link.id}`}
                    className="border-t border-stone-100 bg-stone-50"
                  >
                    {!(link.id in cardCache) &&
                    cardFetcher.state !== "idle" ? (
                      <p className="px-4 py-3 text-11 text-stone-400">
                        {ta("wlCardLoading")}
                      </p>
                    ) : cardCache[link.id] ? (
                      <LinkedDescriptionUnfold
                        card={cardCache[link.id]!}
                        junctionId={link.id}
                        cardBasePath={cardBasePath}
                        showEntityGroups={showEntityFields}
                        roleLabel={roleLabel}
                        placeRoleLabel={placeRoleLabel}
                        t={ta}
                      />
                    ) : (
                      <p className="px-4 py-3 text-11 text-stone-400">
                        {ta("wlCardError")}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ),
          )}
          {/* Pager */}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-stone-200 bg-stone-100 px-4 py-2 text-12 text-stone-600">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setParam("dpage", String(page - 1))}
                className="font-semibold hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
              >
                {ta("wlPrev")}
              </button>
              <span className="nums">{ta("wlPage", { page, pages })}</span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setParam("dpage", String(page + 1))}
                className="font-semibold hover:text-indigo disabled:cursor-not-allowed disabled:opacity-40"
              >
                {ta("wlNext")}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Link description dialog (existing) */}
      <LinkDescriptionDialog
        isOpen={showLinkDialog}
        onClose={() => setShowLinkDialog(false)}
        roles={roles}
        entityOrPlaceId={recordId}
        recordType={recordType}
        t={t}
      />

      {/* Edit description link dialog (existing) — opened by the role chip */}
      {editLink && (
        <EditDescriptionLinkDialog
          isOpen={true}
          onClose={() => setEditingLinkId(null)}
          linkId={editLink.id}
          currentValues={{
            role: editLink.role,
            roleNote: editLink.roleNote,
            sequence: editLink.sequence ?? undefined,
            honorific: editLink.honorific,
            function: editLink.function,
            nameAsRecorded: editLink.nameAsRecorded,
          }}
          roles={roles}
          showEntityFields={showEntityFields}
          t={t}
        />
      )}
    </div>
  );
}

/** Role/All pill — indigo solid when active (matches the mockup). */
function pillClass(active: boolean): string {
  return `inline-flex h-[26px] flex-shrink-0 items-center gap-1.5 rounded-full border px-3 text-12 font-semibold ${
    active
      ? "border-indigo bg-indigo text-white"
      : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
  }`;
}

/** Repository pill — mono label, verdigris-deep solid when active. */
function repoPillClass(active: boolean): string {
  return `inline-flex h-[26px] flex-shrink-0 items-center gap-1.5 rounded-full border px-3 font-mono text-11 font-medium ${
    active
      ? "border-verdigris-deep bg-verdigris-deep text-white"
      : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
  }`;
}
