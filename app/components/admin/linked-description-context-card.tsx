/**
 * Admin — Linked-description context card
 *
 * The record-type-agnostic rich card the merge and split workbenches
 * render for each linked description (spec §4 enhancement). One card =
 * one description, even when the description carries several junction
 * roles: the role chips list every role, and the whole card (all its
 * junction rows) is selected or assigned as a single unit.
 *
 * The card is presentation-only. All text extraction (the scope
 * snippet, offset-faithful highlight, place/repository lookups) happens
 * server-side in `loadLinkedDescriptionCards`; this component receives
 * the finished `LinkedDescriptionCardData` and paints it. `selectable`
 * governs the leading checkbox: the merged-away merge side and the split
 * assignment list are selectable; the survivor side is not (its links
 * always stay).
 *
 * @version v0.4.3
 */

import { Link } from "react-router";
import { MapPin, Archive } from "lucide-react";
import type { LinkedDescriptionCardData } from "~/lib/authority-linked-context.server";

/** Place roles that carry meaning worth labelling; `mentioned` is the
 * plain default and shows the place name alone. */
const STRONG_PLACE_ROLES = new Set([
  "venue",
  "subject",
  "created",
  "sent_from",
  "sent_to",
  "published",
]);

export function LinkedDescriptionContextCard({
  card,
  showAsRecorded,
  selectable = false,
  selected = false,
  onToggle,
  destinationLabel,
  destinationActive,
  roleLabel,
  placeRoleLabel,
  t,
}: {
  card: LinkedDescriptionCardData;
  /** Entity workbenches only — the places junction has no nameAsRecorded. */
  showAsRecorded: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: () => void;
  destinationLabel?: string;
  /** Whether the destination pill reads as the "active"/moved tone. */
  destinationActive?: boolean;
  roleLabel: (role: string) => string;
  placeRoleLabel: (role: string) => string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { snippet } = card;
  const dateText =
    card.dateExpression ??
    (card.dateStart || card.dateEnd
      ? [card.dateStart, card.dateEnd].filter(Boolean).join("–")
      : null);

  const showAsRecordedLine =
    showAsRecorded &&
    card.nameAsRecorded != null &&
    card.nameAsRecorded.trim().length > 0;
  const asRecordedRoleRaw =
    showAsRecordedLine &&
    card.asRecordedRoleRaw &&
    card.asRecordedRoleRaw !== card.asRecordedRole
      ? card.asRecordedRoleRaw
      : null;

  return (
    <div
      className={`flex gap-3 border-t border-stone-100 px-4 py-3 first:border-t-0 ${
        selectable && selected ? "bg-white" : selectable ? "bg-saffron-tint" : "bg-white"
      }`}
    >
      {selectable && (
        <div className="pt-0.5">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            className="h-4 w-4 accent-indigo"
          />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {/* Title + reference code */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link
            to={`/admin/descriptions/${card.descriptionId}`}
            className="font-serif text-13 text-indigo hover:underline"
          >
            {card.title}
          </Link>
          <span className="font-mono text-11 nums text-stone-500">
            {card.referenceCode}
          </span>
        </div>

        {/* Role chips — one per junction role on this description */}
        {card.roles.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {card.roles.map((r, i) => (
              <span
                key={`${r.role}-${i}`}
                className="inline-block rounded-full bg-indigo-tint px-2 py-0.5 text-11 font-medium text-indigo-deep"
              >
                {roleLabel(r.role)}
              </span>
            ))}
          </div>
        )}

        {/* Metadata strip */}
        {(dateText || card.places.length > 0 || card.extent || card.repositoryName) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-11 text-stone-500">
            {dateText && <span className="nums">{dateText}</span>}
            {card.places.map((p, i) => (
              <span
                key={`${p.name}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-stone-600"
              >
                <MapPin className="h-3 w-3 text-stone-400" strokeWidth={1.5} />
                {STRONG_PLACE_ROLES.has(p.role)
                  ? `${placeRoleLabel(p.role)}: ${p.name}`
                  : p.name}
              </span>
            ))}
            {card.extent && <span>{card.extent}</span>}
            {card.repositoryName && (
              <span
                title={card.repositoryName}
                className="inline-flex max-w-[180px] items-center gap-1 truncate"
              >
                <Archive className="h-3 w-3 flex-shrink-0 text-stone-400" strokeWidth={1.5} />
                <span className="truncate">{card.repositoryName}</span>
              </span>
            )}
          </div>
        )}

        {/* As recorded (entity workbenches only) */}
        {showAsRecordedLine && (
          <p className="mt-1.5 text-11 italic text-stone-500">
            {t("ctxAsRecorded")} «{card.nameAsRecorded}»
            {asRecordedRoleRaw && (
              <span className="not-italic"> · {asRecordedRoleRaw}</span>
            )}
          </p>
        )}

        {/* Scope snippet — the ladder may source it from OCR (spec §5),
            flagged with a small saffron tag so the source is legible. */}
        {snippet && (
          <div className="mt-1.5">
            {snippet.source === "ocr" && (
              <span className="mb-1 inline-block rounded bg-saffron-tint px-1.5 text-10 font-semibold uppercase tracking-wider text-saffron-deep">
                {t("ctxSourceOcr")}
              </span>
            )}
            <p className="text-11 leading-[1.5] text-stone-600">
              {snippet.truncatedStart && "… "}
              {snippet.before}
              {snippet.match && (
                <mark className="rounded bg-saffron-tint px-0.5 text-indigo-deep">
                  {snippet.match}
                </mark>
              )}
              {snippet.after}
              {snippet.truncatedEnd && " …"}
            </p>
          </div>
        )}
      </div>

      {/* Destination pill */}
      {destinationLabel && (
        <div className="flex-shrink-0 pt-0.5 text-right">
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-11 font-semibold ${
              destinationActive
                ? "bg-verdigris-tint text-verdigris-deep"
                : "bg-stone-100 text-stone-600"
            }`}
          >
            {destinationLabel}
          </span>
        </div>
      )}
    </div>
  );
}
