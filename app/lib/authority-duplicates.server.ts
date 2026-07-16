/**
 * Authority duplicates — deterministic candidate computation
 *
 * The possible-duplicates worklist (spec §4) computes its candidate
 * pairs deterministically in the loader — no background jobs, no
 * persisted candidate table. This module owns that computation:
 *
 *   - `normaliseName` — the collision key: lowercase, Unicode
 *     accent-stripped (NFD + combining-mark removal), punctuation
 *     removed, whitespace collapsed. No SQL equivalent exists in
 *     SQLite (no `unaccent`), so the worklist loader pulls the
 *     federation's active records and buckets them here.
 *   - `computeDuplicateCandidates` — buckets records by normalised
 *     name, emits one candidate per unordered pair within a bucket,
 *     attaches match signals (normalised name always; date overlap
 *     and shared external id when present), ranks by signal count,
 *     and excludes any pair with a `separate` ledger operation
 *     between them in either direction — the durable do-not-relink
 *     dismissal store (spec §4, the Sowing / UPDB rejection pattern).
 *   - `getDuplicateBadgeCounts` — the CHEAP approximation behind the
 *     sidebar badge, computed only while the current request is inside
 *     the authorities section (the `_auth` layout gates it): exact
 *     lowercase-name collision pairs per record type (a single GROUP
 *     BY scan, no accent normalisation), minus dismissed pairs whose
 *     two records still collide. It deliberately trades exactness for
 *     cost — the accent-normalised worklist can find MORE pairs than
 *     the badge counts. The worklist page shows the exact number.
 *
 * @version v0.4.2
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";

export interface CandidateRecord {
  id: string;
  name: string;
  code: string | null;
  /** ISO-ish date strings; entities only (places pass null). */
  dateStart?: string | null;
  dateEnd?: string | null;
  /** Display string for the card meta line (dates of existence). */
  dates?: string | null;
  /** Shared-external-id signal input (wikidata for entities, tgn for places). */
  externalId?: string | null;
}

export type MatchSignal = "name" | "dates" | "externalId";

export interface CandidatePair {
  a: CandidateRecord;
  b: CandidateRecord;
  signals: MatchSignal[];
}

/**
 * Normalise a display name into the collision key: lowercase, NFD
 * accent-stripped, punctuation replaced by spaces, whitespace
 * collapsed. "González, Juan" and "gonzalez juan" collide.
 */
export function normaliseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Leading four-digit year of a date string, or null. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const m = date.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * True when both records carry at least one parseable year and their
 * [start..end] year ranges intersect (an open end extends to the
 * other bound).
 */
export function datesOverlap(a: CandidateRecord, b: CandidateRecord): boolean {
  const aStart = yearOf(a.dateStart);
  const aEnd = yearOf(a.dateEnd);
  const bStart = yearOf(b.dateStart);
  const bEnd = yearOf(b.dateEnd);
  if (aStart == null && aEnd == null) return false;
  if (bStart == null && bEnd == null) return false;
  const aLo = aStart ?? aEnd!;
  const aHi = aEnd ?? aStart!;
  const bLo = bStart ?? bEnd!;
  const bHi = bEnd ?? bStart!;
  return aLo <= bHi && bLo <= aHi;
}

/** Order-insensitive pair key for the separate-dismissal lookup. */
export function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

export interface CandidateResult {
  pairs: CandidatePair[];
  /**
   * True when any bucket hit a cap — the pair list (and its length)
   * is then a LOWER BOUND, not an exact census. The UI renders the
   * total with a trailing "+" so the cap never masquerades as exact.
   */
  truncated: boolean;
}

/**
 * Records per bucket the quadratic pair loop will scan. Archival
 * corpora reliably contain placeholder names ("sin identificar" ×
 * hundreds); an uncapped bucket of n records emits n(n−1)/2 pair
 * objects — 1,000 placeholders would be ~500K allocations inside a
 * Worker request. Buckets beyond this size are scanned only across
 * their first slice and flagged truncated.
 */
const MAX_BUCKET_RECORDS = 50;

/** Pairs emitted per bucket before the bucket is cut off (flagged). */
const MAX_PAIRS_PER_BUCKET = 10;

/**
 * Compute ranked duplicate candidates. `separatePairs` is the set of
 * `pairKey`s with a `separate` ledger operation between them — those
 * pairs never resurface. Callers pass only active (non-merged-away)
 * records. Output per bucket is bounded (see the cap constants); the
 * `truncated` flag reports when anything was skipped.
 */
export function computeDuplicateCandidates(
  records: CandidateRecord[],
  separatePairs: Set<string>,
): CandidateResult {
  const buckets = new Map<string, CandidateRecord[]>();
  for (const r of records) {
    const key = normaliseName(r.name);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }

  const pairs: CandidatePair[] = [];
  let truncated = false;
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;

    let scan = bucket;
    if (bucket.length > MAX_BUCKET_RECORDS) {
      scan = bucket.slice(0, MAX_BUCKET_RECORDS);
      truncated = true;
    }

    let emitted = 0;
    outer: for (let i = 0; i < scan.length; i++) {
      for (let j = i + 1; j < scan.length; j++) {
        const a = scan[i];
        const b = scan[j];
        if (separatePairs.has(pairKey(a.id, b.id))) continue;
        if (emitted >= MAX_PAIRS_PER_BUCKET) {
          truncated = true;
          break outer;
        }
        const signals: MatchSignal[] = ["name"];
        if (datesOverlap(a, b)) signals.push("dates");
        if (a.externalId && b.externalId && a.externalId === b.externalId) {
          signals.push("externalId");
        }
        pairs.push({ a, b, signals });
        emitted += 1;
      }
    }
  }

  // Rank by match strength (signal count), then by name for a stable
  // deterministic order.
  pairs.sort(
    (x, y) =>
      y.signals.length - x.signals.length ||
      x.a.name.localeCompare(y.a.name) ||
      x.a.id.localeCompare(y.a.id),
  );
  return { pairs, truncated };
}

/**
 * Fetch the set of `pairKey`s dismissed as not-duplicates: every
 * `separate` ledger operation for the record type in this federation,
 * both directions collapsed to the unordered key.
 */
export async function getSeparatePairs(
  db: DrizzleD1Database<any>,
  federationId: string,
  recordType: "entity" | "place",
): Promise<Set<string>> {
  const { and, eq } = await import("drizzle-orm");
  const { authorityOperations } = await import("../db/schema");
  const rows = await db
    .select({
      sourceId: authorityOperations.sourceId,
      targetId: authorityOperations.targetId,
    })
    .from(authorityOperations)
    .where(
      and(
        eq(authorityOperations.federationId, federationId),
        eq(authorityOperations.recordType, recordType),
        eq(authorityOperations.operation, "separate"),
      ),
    )
    .all();
  const set = new Set<string>();
  for (const r of rows) {
    if (r.targetId) set.add(pairKey(r.sourceId, r.targetId));
  }
  return set;
}

/**
 * Cheap sidebar-badge counts: exact lowercase-name collision pairs
 * per record type, minus dismissed pairs whose records still collide.
 * One GROUP BY scan + one indexed join per type — an approximation
 * (no accent normalisation), never the worklist's exact number.
 */
export async function getDuplicateBadgeCounts(
  db: DrizzleD1Database<any>,
  federationId: string,
): Promise<{ entities: number; places: number }> {
  const { sql } = await import("drizzle-orm");

  async function countFor(
    table: "entities" | "places",
    recordType: "entity" | "place",
  ): Promise<number> {
    const groups = (await db.all(sql`
      SELECT COUNT(*) AS c
      FROM ${sql.raw(table)}
      WHERE federation_id = ${federationId} AND merged_into IS NULL
      GROUP BY lower(display_name)
      HAVING c > 1
    `)) as Array<{ c: number }>;
    let pairs = 0;
    for (const g of groups) pairs += (g.c * (g.c - 1)) / 2;
    if (pairs === 0) return 0;

    const dismissed = (await db.all(sql`
      SELECT COUNT(DISTINCT CASE
        WHEN ao.source_id < ao.target_id
          THEN ao.source_id || '|' || ao.target_id
        ELSE ao.target_id || '|' || ao.source_id
      END) AS c
      FROM authority_operations ao
      JOIN ${sql.raw(table)} a ON a.id = ao.source_id
      JOIN ${sql.raw(table)} b ON b.id = ao.target_id
      WHERE ao.federation_id = ${federationId}
        AND ao.record_type = ${recordType}
        AND ao.operation = 'separate'
        AND a.merged_into IS NULL AND b.merged_into IS NULL
        AND lower(a.display_name) = lower(b.display_name)
    `)) as Array<{ c: number }>;
    return Math.max(0, pairs - (dismissed[0]?.c ?? 0));
  }

  const [entityCount, placeCount] = await Promise.all([
    countFor("entities", "entity"),
    countFor("places", "place"),
  ]);
  return { entities: entityCount, places: placeCount };
}
