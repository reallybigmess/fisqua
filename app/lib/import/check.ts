/**
 * Import readiness check — aggregation of verdicts into problem classes
 *
 * This module deals with turning a `validate()` pass into the readiness
 * check's findings (readiness-check design §3): instead of a flat row
 * table, the same verdicts are grouped by the problem they represent so a
 * user decides once per class rather than reading backwards through a
 * cascade. It is a pure function of `validate()` output plus the resolved
 * per-row parent graph; it touches no database, store, or profile — the
 * server wrapper (`./check.server`) supplies the inputs and caches the
 * result.
 *
 * Three finding kinds (design §3.2):
 *
 *   - DECISION — a describing-standard required-field gap, aggregated per
 *     `(descriptionLevel, missing-required-field-set)`. Each such row
 *     rejects today; accepting the class imports those rows honestly
 *     sparse. A decision finding stores EVERY class key it covers
 *     (`missing_required_field:<level>:<field>`) so acceptance is precise
 *     even when co-occurring classes are merged into one card for display
 *     (design §3.3). A decision card's count and cascade equal EXACTLY the
 *     rows acceptance saves: a row also carrying a non-degradable defect
 *     (over-length value, bad level, invalid field — `otherInvalid`) is
 *     excluded, because `validate()` under acceptance still rejects it.
 *
 *   - BLOCKING — identifier discipline (duplicate/blank reference codes,
 *     unresolvable parents, cycles), plus `invalid_values`: rows carrying a
 *     non-degradable validation defect, which reject whatever is decided.
 *     No accept option; the affected rows reject and the card names them.
 *     Blocking findings never gate the dry run — they carry no class keys.
 *
 *   - INFORMATIONAL — unmapped file columns, profile columns absent from
 *     the file, and degrade-with-warning tallies (unknown vocabulary and
 *     the like). Never gates anything.
 *
 * Forward cascade is computed from the REAL parent graph (design §3.2):
 * the descendants of a finding's affected rows, counted from the resolved
 * per-row `(referenceCode, parentReferenceCode)` edges — never estimated.
 * A decision left unresolved rejects its subtree; the cascade is the size
 * of that subtree below the affected rows themselves.
 *
 * @version v0.6.0
 */

import type { DescriptionLevel } from "../standards/types";
import type { RejectReason, ValidateResult } from "./validate";

/** The problem-class key prefix for a missing required describing field. */
export function missingRequiredClassKey(
  level: string,
  field: string,
): string {
  return `missing_required_field:${level}:${field}`;
}

/** Resolved identifiers for ONE row (every row, including rejected ones). */
export interface RowIdentifier {
  rowNumber: number;
  referenceCode: string | null;
  parentReferenceCode: string | null;
}

export interface DecisionFinding {
  kind: "decision";
  /** Stable group identity: `<level>::<sorted-fields>` — the accept target. */
  key: string;
  /** Every class key this finding covers (design §3.3). */
  classKeys: string[];
  level: DescriptionLevel;
  /** The missing required TARGET field names, sorted. */
  fields: string[];
  /** Source column headers to fill, when the binding map was supplied. */
  sourceColumns?: string[];
  /** Rows directly missing these fields at this level. */
  count: number;
  /** A bounded sample of affected row numbers, for display. */
  sampleRows: number[];
  /** The single reference code, when the group is exactly one row. */
  referenceCode?: string;
  /** Descendant rows that reject if this stays unresolved (real graph). */
  cascadeCount: number;
}

/**
 * Reasons that surface as blocking findings: identifier discipline, plus
 * `invalid_values` — rows whose non-degradable defects (over-length value,
 * bad level, invalid field) reject whatever is decided, so no decision card
 * may count them among the rows acceptance saves.
 */
export type BlockingKind =
  | "duplicate_reference_code"
  | "missing_reference_code"
  | "unresolvable_parent"
  | "parent_cycle"
  | "invalid_values";

export interface BlockingFinding {
  kind: "blocking";
  key: string;
  blockingKind: BlockingKind;
  count: number;
  /** The affected row numbers (bounded for display). */
  rows: number[];
  /** The colliding / cycling reference code, when the class has one. */
  referenceCode?: string;
  /** The unresolvable parent reference code, when the class has one. */
  parentReferenceCode?: string;
  /** Descendant rows that reject with the blocked rows (real graph). */
  cascadeCount: number;
}

export interface InfoFinding {
  kind: "informational";
  key: string;
  infoKind: "unmapped_columns" | "unbound_columns" | "warning";
  /** Column names, for the column-oriented info findings. */
  columns?: string[];
  /** The transform/date warning code, for the warning info finding. */
  code?: string;
  /** Rows for a warning finding; column count for the column findings. */
  count: number;
}

export type Finding = DecisionFinding | BlockingFinding | InfoFinding;

/** A bounded sample cap so a cache entry never balloons on a huge class. */
const SAMPLE_CAP = 50;

export interface ComputeFindingsInput {
  result: ValidateResult;
  /** Resolved identifiers for EVERY row (the real parent graph source). */
  rowIdentifiers: readonly RowIdentifier[];
  /** Optional target→source header map, to name the columns a fix fills. */
  targetToSource?: Record<string, string>;
}

/**
 * Build the parent graph (parent-row → child-rows) over the resolved
 * identifiers. Edges resolve by reference code, first occurrence winning
 * when a code duplicates — a duplicated code is not a valid parent anyway,
 * so the ambiguity never affects a legitimate subtree.
 */
function buildParentGraph(
  rowIdentifiers: readonly RowIdentifier[],
): Map<number, number[]> {
  const codeToRow = new Map<string, number>();
  for (const r of rowIdentifiers) {
    if (r.referenceCode !== null && !codeToRow.has(r.referenceCode)) {
      codeToRow.set(r.referenceCode, r.rowNumber);
    }
  }
  const childrenByRow = new Map<number, number[]>();
  for (const r of rowIdentifiers) {
    if (r.parentReferenceCode === null) continue;
    const parentRow = codeToRow.get(r.parentReferenceCode);
    if (parentRow === undefined) continue;
    const list = childrenByRow.get(parentRow) ?? [];
    list.push(r.rowNumber);
    childrenByRow.set(parentRow, list);
  }
  return childrenByRow;
}

/**
 * Collect the rows strictly BELOW a seed set. An `excluded` set prunes the
 * walk: an excluded row is neither collected nor traversed through —
 * decision cascades exclude the doomed subtree (rows that reject whatever
 * is decided), so a card never claims descendants acceptance cannot save.
 */
function collectDescendants(
  childrenByRow: ReadonlyMap<number, number[]>,
  seedRows: Iterable<number>,
  excluded: ReadonlySet<number> = new Set(),
): Set<number> {
  const seeds = new Set(seedRows);
  const seen = new Set<number>();
  const queue: number[] = [...seeds];
  while (queue.length > 0) {
    const row = queue.shift() as number;
    for (const child of childrenByRow.get(row) ?? []) {
      if (seen.has(child) || seeds.has(child) || excluded.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

/**
 * Aggregate a `validate()` pass into readiness findings. Pure: the same
 * verdicts a dry run would produce, grouped by problem class, with forward
 * cascades read off the resolved parent graph.
 */
export function computeFindings(input: ComputeFindingsInput): Finding[] {
  const { result, rowIdentifiers, targetToSource } = input;
  const codeByRow = new Map<number, string | null>(
    rowIdentifiers.map((r) => [r.rowNumber, r.referenceCode]),
  );

  const graph = buildParentGraph(rowIdentifiers);

  // Rows that reject WHATEVER is decided: a non-degradable validation defect
  // (over-length, bad level, invalid field) that acceptance never relieves —
  // plus their entire subtrees, which cascade-reject with them regardless of
  // any acceptance. The doomed subtree is excluded from every decision count
  // and every decision cascade — a card's numbers must equal exactly what
  // acceptance saves — and the defective rows are surfaced separately as an
  // `invalid_values` blocking finding below (its cascade covers the subtree).
  const doomedRows = new Set(
    result.rowValidation.filter((rv) => rv.otherInvalid).map((rv) => rv.rowNumber),
  );
  const doomedSubtree = new Set([
    ...doomedRows,
    ...collectDescendants(graph, doomedRows),
  ]);
  const descendantsOf = (seeds: Iterable<number>) =>
    collectDescendants(graph, seeds).size;
  const savableDescendantsOf = (seeds: Iterable<number>) =>
    collectDescendants(graph, seeds, doomedSubtree).size;

  // ── Decision findings — grouped by (level, missing-required-field-set) ──
  // Read from the INTRINSIC per-row validation, not the verdicts: a row's own
  // required-field gap is a decision class even when its verdict is
  // `parent_rejected` (a cascade of its container's gap). The mockup's
  // "collection is missing 6 fields" and "N item rows have no extent" cards
  // coexist for exactly this reason (design §3.2).
  interface DecisionAcc {
    level: DescriptionLevel;
    fields: string[];
    rows: number[];
  }
  const decisionGroups = new Map<string, DecisionAcc>();
  for (const rv of result.rowValidation) {
    if (rv.requiredMissing.length === 0) continue;
    if (doomedSubtree.has(rv.rowNumber)) continue;
    const fields = [...new Set(rv.requiredMissing)].sort();
    const key = `${rv.level}::${fields.join(",")}`;
    const acc = decisionGroups.get(key) ?? { level: rv.level, fields, rows: [] };
    acc.rows.push(rv.rowNumber);
    decisionGroups.set(key, acc);
  }

  const decisions: DecisionFinding[] = [];
  for (const [key, acc] of decisionGroups) {
    const classKeys = acc.fields.map((f) => missingRequiredClassKey(acc.level, f));
    const sourceColumns = targetToSource
      ? acc.fields
          .map((f) => targetToSource[f])
          .filter((s): s is string => typeof s === "string" && s !== "")
      : undefined;
    decisions.push({
      kind: "decision",
      key,
      classKeys,
      level: acc.level,
      fields: acc.fields,
      ...(sourceColumns && sourceColumns.length > 0 ? { sourceColumns } : {}),
      count: acc.rows.length,
      sampleRows: acc.rows.slice(0, SAMPLE_CAP),
      ...(acc.rows.length === 1
        ? { referenceCode: codeByRow.get(acc.rows[0]) ?? undefined }
        : {}),
      // Doomed-excluded: descendants that reject regardless (their own
      // defect, or sitting under a defective row) are never claimed here.
      cascadeCount: savableDescendantsOf(acc.rows),
    });
  }
  // Biggest classes first — the most consequential decision leads.
  decisions.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // ── Blocking findings — identifier discipline, grouped per class ────────
  const blocking: BlockingFinding[] = [];
  const duplicates = new Map<string, Set<number>>();
  const unresolvableParents = new Map<string, Set<number>>();
  const missingCodeRows = new Set<number>();
  const cycleRows = new Set<number>();
  const BLOCKING_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
    "duplicate_reference_code",
    "missing_reference_code",
    "unresolvable_parent",
    "parent_cycle",
  ]);

  for (const v of result.verdicts) {
    if (v.verdict !== "reject" || v.reason === undefined) continue;
    if (!BLOCKING_REASONS.has(v.reason)) continue;
    if (v.reason === "duplicate_reference_code") {
      const code = v.referenceCode ?? "";
      const set = duplicates.get(code) ?? new Set<number>();
      set.add(v.rowNumber);
      for (const n of (v.detail?.rows as number[]) ?? []) set.add(n);
      duplicates.set(code, set);
    } else if (v.reason === "unresolvable_parent") {
      const parent =
        (v.detail?.parentReferenceCode as string) ??
        (v.detail?.parentRejected as string) ??
        "";
      const set = unresolvableParents.get(parent) ?? new Set<number>();
      set.add(v.rowNumber);
      unresolvableParents.set(parent, set);
    } else if (v.reason === "missing_reference_code") {
      missingCodeRows.add(v.rowNumber);
    } else if (v.reason === "parent_cycle") {
      cycleRows.add(v.rowNumber);
    }
  }

  for (const [code, rowSet] of duplicates) {
    const rows = [...rowSet].sort((a, b) => a - b);
    blocking.push({
      kind: "blocking",
      key: `duplicate_reference_code::${code}`,
      blockingKind: "duplicate_reference_code",
      count: rows.length,
      rows: rows.slice(0, SAMPLE_CAP),
      referenceCode: code || undefined,
      cascadeCount: descendantsOf(rows),
    });
  }
  for (const [parent, rowSet] of unresolvableParents) {
    const rows = [...rowSet].sort((a, b) => a - b);
    blocking.push({
      kind: "blocking",
      key: `unresolvable_parent::${parent}`,
      blockingKind: "unresolvable_parent",
      count: rows.length,
      rows: rows.slice(0, SAMPLE_CAP),
      parentReferenceCode: parent || undefined,
      cascadeCount: descendantsOf(rows),
    });
  }
  if (missingCodeRows.size > 0) {
    const rows = [...missingCodeRows].sort((a, b) => a - b);
    blocking.push({
      kind: "blocking",
      key: "missing_reference_code",
      blockingKind: "missing_reference_code",
      count: rows.length,
      rows: rows.slice(0, SAMPLE_CAP),
      cascadeCount: descendantsOf(rows),
    });
  }
  if (cycleRows.size > 0) {
    const rows = [...cycleRows].sort((a, b) => a - b);
    blocking.push({
      kind: "blocking",
      key: "parent_cycle",
      blockingKind: "parent_cycle",
      count: rows.length,
      rows: rows.slice(0, SAMPLE_CAP),
      cascadeCount: descendantsOf(rows),
    });
  }
  // Non-degradable defects: these rows reject whatever is decided, so they
  // are stated as their own blocking-style finding rather than silently
  // inflating a decision card. Cascade is the full blast radius — their
  // descendants reject with them regardless of any acceptance.
  if (doomedRows.size > 0) {
    const rows = [...doomedRows].sort((a, b) => a - b);
    blocking.push({
      kind: "blocking",
      key: "invalid_values",
      blockingKind: "invalid_values",
      count: rows.length,
      rows: rows.slice(0, SAMPLE_CAP),
      cascadeCount: descendantsOf(rows),
    });
  }
  blocking.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  // ── Informational findings — no action, never gates ─────────────────────
  const informational: InfoFinding[] = [];
  const unmapped = result.headerBinding.unrecognisedHeaders;
  if (unmapped.length > 0) {
    informational.push({
      kind: "informational",
      key: "unmapped_columns",
      infoKind: "unmapped_columns",
      columns: unmapped,
      count: unmapped.length,
    });
  }
  const unbound = result.headerBinding.unboundBindings;
  if (unbound.length > 0) {
    informational.push({
      kind: "informational",
      key: "unbound_columns",
      infoKind: "unbound_columns",
      columns: unbound.map((b) => b.source),
      count: unbound.length,
    });
  }
  const warnCounts = new Map<string, number>();
  for (const w of result.warnings) {
    warnCounts.set(w.code, (warnCounts.get(w.code) ?? 0) + 1);
  }
  for (const [code, count] of [...warnCounts].sort((a, b) => b[1] - a[1])) {
    informational.push({
      kind: "informational",
      key: `warning::${code}`,
      infoKind: "warning",
      code,
      count,
    });
  }

  return [...decisions, ...blocking, ...informational];
}
