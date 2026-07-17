/**
 * Import identifier discipline — reference-code and parent resolution
 *
 * This module deals with the load-bearing identifier concern of the
 * imports module (spec §3): resolving each row strictly by its
 * `referenceCode`, detecting in-file duplicates, and ordering parents
 * before children by real dependency resolution — topological, multi-pass,
 * tolerant of forward references — never punctuation or hyphen-count
 * heuristics. It is a pure function of the extracted per-row identifiers;
 * it touches no database, network, or I/O. The set of reference codes
 * already present for the tenant is passed in (a D1 read the runner
 * performs and hands over), so both hierarchy patterns are handled by one
 * code path: a parent that resolves to another in-file row (a full
 * container tree from one file) and a parent that resolves to an existing
 * description (items into existing containers) are the same resolution.
 *
 * The asymmetry rule (spec §2, §3) governs everything here. An identifier
 * failure — a missing reference code, an in-file duplicate, an
 * unresolvable parent, or a cycle — BLOCKS the row into the rejects list,
 * named and counted, never fabricated. (Describing-value degradations are
 * a separate concern handled in `./transforms` and `./validate`; nothing
 * here degrades.)
 *
 * Duplicate reference codes reject EVERY colliding row — never first-wins.
 * File order is not evidence of which duplicate is correct (a typo row
 * ahead of the good row would import the typo and reject the good one), so
 * an ambiguous identifier is unresolvable, full stop — spec §3's
 * never-guess posture. This DIVERGES from the approved UX mockup's step-4
 * arithmetic (24 rows / 21 resolvable / 3 rejects assumes the first
 * duplicate survives); the divergence is deliberate and awaits Juan's
 * ratification. A row whose in-file parent is itself rejected cascades to
 * an unresolvable-parent reject, because a child cannot attach to a
 * container that will never be created.
 *
 * @version v0.6.0
 */

import { DESCRIPTION_LEVELS } from "../validation/enums";
import type { DescriptionLevel } from "../standards/types";

/** One row's identifier inputs, as the caller reads them off the CSV. */
export interface IdentifierRowInput {
  /** 1-based data-row number (excludes the header row), used in reports. */
  rowNumber: number;
  /** The row's own reference code, pre-transform-resolved by the caller. */
  referenceCode: string | null | undefined;
  /** The parent's reference code, or blank/absent for a root row. */
  parentReferenceCode?: string | null | undefined;
}

/** The named identifier-failure reasons — each blocks a row into rejects. */
export type IdentifierRejectReason =
  | "missing_reference_code"
  | "duplicate_reference_code"
  | "unresolvable_parent"
  | "parent_cycle";

export interface IdentifierReject {
  rowNumber: number;
  reason: IdentifierRejectReason;
  /** The row's reference code (null when it was the failing value). */
  referenceCode: string | null;
  /** Structured context: the first duplicate row, the missing parent, etc. */
  detail?: Record<string, unknown>;
}

/** A row that resolved, carrying its resolved parent linkage. */
export interface ResolvedRow {
  rowNumber: number;
  referenceCode: string;
  /** The resolved parent reference code, or null for a root. */
  parentReferenceCode: string | null;
  /**
   * How the parent resolved: `null` for a root, `"in_file"` for another
   * row in this file, `"existing"` for a description already in the tenant.
   */
  parentSource: null | "in_file" | "existing";
}

export interface IdentifierResolution {
  /** Resolved rows in TOPOLOGICAL order — every parent precedes its children. */
  ordered: ResolvedRow[];
  /** Blocked rows, in first-seen order, each with a named reason. */
  rejects: IdentifierReject[];
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * The description levels valid for the platform. Standard-neutral in this
 * codebase (`DESCRIPTION_LEVELS` is the shared level set the three
 * descriptive standards draw from), so a level is legal for a tenant iff
 * it is a member here — derived, never a hardcoded per-format map (spec
 * §6). A vocabulary transform's default (spec §2) resolves an unrecognised
 * source level to one of these safely.
 */
export function descriptionLevels(): readonly DescriptionLevel[] {
  return DESCRIPTION_LEVELS;
}

/** Whether `value` is a valid description level for the platform. */
export function isDescriptionLevel(value: string): value is DescriptionLevel {
  return (DESCRIPTION_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve reference codes and parent linkage for a whole file.
 *
 * Multi-pass, in file order for determinism:
 *   1. Reference-code presence and in-file duplicate detection (every
 *      colliding row rejected; the detail names the other colliding rows).
 *   2. Parent classification against the surviving in-file codes and the
 *      tenant's existing codes; an unresolvable parent rejects the row.
 *   3. Cascade — a row whose in-file parent was rejected is itself
 *      rejected (its container will never be created).
 *   4. Topological ordering (Kahn) over the in-file parent edges; any
 *      rows left in a cycle are rejected.
 */
export function resolveIdentifiers(
  rows: readonly IdentifierRowInput[],
  existingReferenceCodes: ReadonlySet<string>,
): IdentifierResolution {
  const rejects: IdentifierReject[] = [];

  // Pass 1 — presence, then duplicate detection over the whole file. A
  // duplicated code rejects EVERY row carrying it: file order is not
  // evidence of which duplicate is correct, so none survives (never-guess,
  // spec §3). Each reject's detail names the OTHER colliding row numbers.
  interface Candidate {
    rowNumber: number;
    referenceCode: string;
    parentReferenceCode: string | null;
  }
  const withCode: Candidate[] = [];
  const rowsByCode = new Map<string, number[]>();
  for (const row of rows) {
    const code = clean(row.referenceCode);
    if (code === "") {
      rejects.push({
        rowNumber: row.rowNumber,
        reason: "missing_reference_code",
        referenceCode: null,
      });
      continue;
    }
    withCode.push({
      rowNumber: row.rowNumber,
      referenceCode: code,
      parentReferenceCode: clean(row.parentReferenceCode) || null,
    });
    const list = rowsByCode.get(code) ?? [];
    list.push(row.rowNumber);
    rowsByCode.set(code, list);
  }

  const candidates: Candidate[] = [];
  for (const candidate of withCode) {
    const collidingRows = rowsByCode.get(candidate.referenceCode)!;
    if (collidingRows.length > 1) {
      rejects.push({
        rowNumber: candidate.rowNumber,
        reason: "duplicate_reference_code",
        referenceCode: candidate.referenceCode,
        detail: {
          rows: collidingRows.filter((n) => n !== candidate.rowNumber),
        },
      });
      continue;
    }
    candidates.push(candidate);
  }

  const inFileCodes = new Set(candidates.map((c) => c.referenceCode));

  // Pass 2 — classify parents; an unresolvable parent rejects the row.
  const alive = new Map<string, Candidate & { parentSource: ResolvedRow["parentSource"] }>();
  for (const candidate of candidates) {
    const parent = candidate.parentReferenceCode;
    let parentSource: ResolvedRow["parentSource"];
    if (parent === null) {
      parentSource = null;
    } else if (inFileCodes.has(parent)) {
      parentSource = "in_file";
    } else if (existingReferenceCodes.has(parent)) {
      parentSource = "existing";
    } else {
      rejects.push({
        rowNumber: candidate.rowNumber,
        reason: "unresolvable_parent",
        referenceCode: candidate.referenceCode,
        detail: { parentReferenceCode: parent },
      });
      continue;
    }
    alive.set(candidate.referenceCode, { ...candidate, parentSource });
  }

  // Pass 3 — cascade: a row whose in-file parent is absent from the alive
  // set cannot attach; reject it, and repeat until the set is stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [code, entry] of [...alive]) {
      if (entry.parentSource === "in_file" && entry.parentReferenceCode !== null) {
        if (!alive.has(entry.parentReferenceCode)) {
          rejects.push({
            rowNumber: entry.rowNumber,
            reason: "unresolvable_parent",
            referenceCode: code,
            detail: { parentRejected: entry.parentReferenceCode },
          });
          alive.delete(code);
          changed = true;
        }
      }
    }
  }

  // Pass 4 — Kahn topological order over the in-file parent edges. Every
  // surviving in-file parent is alive, so anything left unresolved after
  // Kahn sits in a cycle.
  const childrenByParent = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const [code, entry] of alive) {
    const hasInFileParent =
      entry.parentSource === "in_file" && entry.parentReferenceCode !== null;
    indegree.set(code, hasInFileParent ? 1 : 0);
    if (hasInFileParent) {
      const parent = entry.parentReferenceCode as string;
      const list = childrenByParent.get(parent) ?? [];
      list.push(code);
      childrenByParent.set(parent, list);
    }
  }

  // Seed the queue with roots (and existing-parent rows), preserving file
  // order so the emitted order is stable and reproducible.
  const queue: string[] = [];
  for (const entry of candidates) {
    if (alive.has(entry.referenceCode) && indegree.get(entry.referenceCode) === 0) {
      queue.push(entry.referenceCode);
    }
  }
  const ordered: ResolvedRow[] = [];
  const emitted = new Set<string>();
  while (queue.length > 0) {
    const code = queue.shift() as string;
    const entry = alive.get(code)!;
    ordered.push({
      rowNumber: entry.rowNumber,
      referenceCode: entry.referenceCode,
      parentReferenceCode: entry.parentReferenceCode,
      parentSource: entry.parentSource,
    });
    emitted.add(code);
    for (const child of childrenByParent.get(code) ?? []) {
      indegree.set(child, (indegree.get(child) ?? 0) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
  }

  // Anything alive but never emitted is inside a cycle — reject in file order.
  for (const entry of candidates) {
    if (alive.has(entry.referenceCode) && !emitted.has(entry.referenceCode)) {
      rejects.push({
        rowNumber: entry.rowNumber,
        reason: "parent_cycle",
        referenceCode: entry.referenceCode,
        detail: { parentReferenceCode: entry.parentReferenceCode },
      });
    }
  }

  return { ordered, rejects };
}
