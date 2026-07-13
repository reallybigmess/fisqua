/**
 * Admin — Authority Status Band
 *
 * The quiet-but-unmissable band shown at the top of an authority
 * record touched by a ledger operation. It is derived entirely from
 * the append-only `authority_operations` ledger — no new schema — and
 * links to the record(s) the operation names.
 *
 * Three variants:
 *   - `merged`: "Merged into {survivor} on {date} by {user}" — the
 *     superseded state; the host page dims and inerts the body.
 *   - `split`: "Split into {records} on {date} by {user}" — an
 *     INFORMATIONAL band on a split parent, which stays live and
 *     editable (spec §4: a split supersedes neither half).
 *   - `splitFrom`: "Split from {parent} on {date} by {user}" — the
 *     informational counterpart on the record a split created.
 *
 * The right-side affordance is the "Open ledger entry" link into the
 * record's history page when `ledgerHref` is provided (handoff surface
 * 6); otherwise the View survivor / View records link (surface 4).
 *
 * Per the design system: `indigo-wash` background, `indigo-tint` bottom
 * border, no alarm colour and no left-border accent. The named
 * record renders inline in `verdigris-deep`; the date/user tail sits
 * in `indigo-soft`. The caller resolves the `authorities` namespace
 * and passes `t` down.
 *
 * @version v0.4.2
 */

import { Link } from "react-router";
import { GitMerge, GitFork, ArrowRight } from "lucide-react";

export interface SupersedingRef {
  id: string;
  name: string;
  href: string;
}

export function StatusBand({
  variant,
  date,
  user,
  survivor,
  records,
  parent,
  ledgerHref,
  t,
}: {
  variant: "merged" | "split" | "splitFrom";
  date: string;
  user: string;
  /** Present for the merged variant. */
  survivor?: SupersedingRef;
  /** Present for the split variant (one or more new records). */
  records?: SupersedingRef[];
  /** Present for the splitFrom variant (the split parent). */
  parent?: SupersedingRef;
  /** History-page URL; when set the right link opens the ledger entry. */
  ledgerHref?: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const Icon = variant === "merged" ? GitMerge : GitFork;

  const survivorName = survivor?.name ?? "";
  const recordNames = (records ?? []).map((r) => r.name).join(", ");
  const parentName = parent?.name ?? "";
  const primaryHref =
    variant === "merged"
      ? survivor?.href
      : variant === "split"
        ? records?.[0]?.href
        : parent?.href;

  const sentence =
    variant === "merged"
      ? t("bandMerged", { survivor: survivorName, date, user })
      : variant === "split"
        ? t("bandSplit", { records: recordNames, date, user })
        : t("bandSplitFrom", { parent: parentName, date, user });

  // The sentence contains the named record(s) exactly once
  // (interpolated verbatim); bold and link them inline per the handoff
  // copy ("Merged into **[Survivor]** on {date} by {user}") by
  // splitting the rendered string on the name. If the name can't be
  // located (empty name edge case), fall back to the plain sentence.
  const boldName =
    variant === "merged"
      ? survivorName
      : variant === "split"
        ? recordNames
        : parentName;
  const nameIdx = boldName ? sentence.indexOf(boldName) : -1;

  const rightHref = ledgerHref ?? primaryHref;
  const rightLabel = ledgerHref
    ? t("bandOpenLedger")
    : variant === "merged"
      ? t("bandViewSurvivor")
      : t("bandViewRecords");

  return (
    <div className="flex items-center gap-3 border-b border-indigo-tint bg-indigo-wash px-5 py-3">
      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-indigo-tint">
        <Icon className="h-4 w-4 text-indigo" strokeWidth={1.5} />
      </span>
      <p className="flex-1 text-15 text-indigo">
        {nameIdx >= 0 ? (
          <>
            {sentence.slice(0, nameIdx)}
            {primaryHref ? (
              <Link
                to={primaryHref}
                className="font-semibold text-verdigris-deep underline hover:text-verdigris"
              >
                {boldName}
              </Link>
            ) : (
              <span className="font-semibold text-verdigris-deep">
                {boldName}
              </span>
            )}
            <span className="text-indigo-soft">
              {sentence.slice(nameIdx + boldName.length)}
            </span>
          </>
        ) : (
          sentence
        )}
      </p>
      {rightHref && (
        <Link
          to={rightHref}
          className="inline-flex items-center gap-1 text-13 font-semibold text-verdigris-deep underline hover:text-verdigris"
        >
          {rightLabel}
          <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
        </Link>
      )}
    </div>
  );
}
