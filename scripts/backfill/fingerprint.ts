/**
 * Backfill — description-set fingerprint join
 *
 * This module deals with the second join recipe (authorities spec §10,
 * secondary): a pipeline entity's `mention_dates[].description_id` are
 * Django description pks; production descriptions carry those pks in
 * `legacy_ids`; the `description_entities` junctions then fingerprint
 * every production entity by the set of Django description pks it is
 * linked to. A pipeline entity unresolvable by content (renamed in
 * Django before the dump) still matches by that description set.
 *
 * MEASURED FACT the rules encode (2026-07-10 integrator pass): the
 * Phase-13 Django ingest CONSOLIDATED same-institution pipeline entities
 * across repos (e.g. acc "Real Hacienda" + its ahr sibling fold into one
 * Django row whose description set is the union). The fingerprint is
 * therefore deliberately many-to-one: several pipeline ids may resolve
 * to the same production UUID.
 *
 * TWO RULE SETS. The adversarial review (2026-07-10, verdict BLOCK)
 * proved the lax rule set systematically unsafe on small description
 * sets: gating coverage on the pipeline set alone lets a one-document
 * entity bind to any co-occurring stranger, and a type filter that
 * SKIPS when no same-type candidate survives falls through to binding
 * institutions to persons (36 confirmed cases). Consequences:
 *
 *   - LAX (default, options omitted): the original recipe. Retained
 *     ONLY so the deferral inventory is reproducible — matches made
 *     with it are hypotheses, never row-generation inputs.
 *   - HARDENED (`HARDENED_FINGERPRINT` options): minimum set size 3;
 *     entity-type consistency as a HARD gate (zero same-type survivors
 *     REJECTS the match — cross-type candidates can never reach the
 *     `unclaimed` filter); lexical name corroboration (diacritic-folded
 *     significant-token Jaccard ≥ 0.5 between the pipeline names and
 *     the candidate's, so "Administración de Cali" cannot bind
 *     "Administración de Cartagena"). Survivors go to a hand-review
 *     file with full evidence; a human adjudicates before any
 *     fingerprint batch is generated.
 *
 * Both sets share the base: candidates ranked by |P ∩ E|, coverage
 * ≥ 90% of P required, ties narrowed by evidence filters, anything
 * unresolved returned as tied/weak/rejected — never guessed.
 *
 * @version v0.4.2
 */

import { DatabaseSync } from "node:sqlite";
import type { PipelineEntity } from "./types";

/** Production-side fields used by the tie-break filters. */
export interface ProductionEntityFields {
  display_name: string;
  entity_type: string | null;
  given_name: string | null;
  surname: string | null;
  honorific: string | null;
  name_variants: string[];
}

/** Everything the fingerprint needs, built in one read-only DB pass. */
export interface FingerprintIndex {
  /** production UUID → set of Django description pks it links to. */
  entityDescSets: Map<string, Set<number>>;
  /** Django description pk → production entity UUIDs on it. */
  descToEntities: Map<number, Set<string>>;
  /** production UUID → tie-break fields. */
  fields: Map<string, ProductionEntityFields>;
  /** Django entity pk → production UUID (via entities.legacy_ids). */
  pkToUuid: Map<number, string>;
}

export type FingerprintOutcome =
  | {
      kind: "matched";
      production_id: string;
      method: "unique" | "exact-set" | "variant" | "type" | "unclaimed";
      overlap: number;
      setSize: number;
      /** Best lexical-corroboration score (hardened runs only). */
      corroboration?: number;
      /** The other best-overlap candidates the filters eliminated. */
      tiedWith?: string[];
    }
  | { kind: "tied"; candidates: string[]; overlap: number; setSize: number }
  | { kind: "weak"; bestRatio: number; setSize: number }
  | { kind: "no-candidates" }
  | {
      kind: "rejected";
      reason: "set-too-small" | "type-mismatch" | "no-name-corroboration";
      setSize: number;
      candidates?: string[];
    };

/** Gate knobs. Omitted → the lax (inventory-only) recipe. */
export interface FingerprintGates {
  /** Reject when the pipeline description set is smaller than this. */
  minSetSize?: number;
  /** Zero same-type candidates REJECTS instead of skipping the filter. */
  hardTypeGate?: boolean;
  /** Require lexical name agreement (token Jaccard ≥ 0.5). */
  requireNameCorroboration?: boolean;
}

/** The reviewer-mandated gates for any future fingerprint batch. */
export const HARDENED_FINGERPRINT: FingerprintGates = {
  minSetSize: 3,
  hardTypeGate: true,
  requireNameCorroboration: true,
};

/** Pipeline `institution` is production `corporate`. */
export function normaliseEntityType(t: string | null | undefined): string | null {
  if (!t) return null;
  return t === "institution" ? "corporate" : t;
}

function extractDjangoPk(legacyIdsJson: string | null): number | null {
  if (!legacyIdsJson) return null;
  try {
    const arr = JSON.parse(legacyIdsJson) as Array<{ provider: string; id: number | string }>;
    for (const l of arr) {
      if (l.provider === "django-zasqua" && typeof l.id === "number") return l.id;
    }
  } catch {
    /* malformed legacy_ids never matches */
  }
  return null;
}

/**
 * Build the fingerprint index from a D1-shaped sqlite copy. Read-only:
 * three SELECTs (descriptions, junctions, entities), no writes.
 */
export function readFingerprintIndex(dbPath: string): FingerprintIndex {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const descPk = new Map<string, number>();
    for (const r of db
      .prepare("SELECT id, legacy_ids FROM descriptions")
      .all() as Array<{ id: string; legacy_ids: string | null }>) {
      const pk = extractDjangoPk(r.legacy_ids);
      if (pk !== null) descPk.set(r.id, pk);
    }

    const entityDescSets = new Map<string, Set<number>>();
    const descToEntities = new Map<number, Set<string>>();
    for (const r of db
      .prepare("SELECT description_id, entity_id FROM description_entities")
      .all() as Array<{ description_id: string; entity_id: string }>) {
      const pk = descPk.get(r.description_id);
      if (pk === undefined) continue;
      let s = entityDescSets.get(r.entity_id);
      if (!s) entityDescSets.set(r.entity_id, (s = new Set()));
      s.add(pk);
      let d = descToEntities.get(pk);
      if (!d) descToEntities.set(pk, (d = new Set()));
      d.add(r.entity_id);
    }

    const fields = new Map<string, ProductionEntityFields>();
    const pkToUuid = new Map<number, string>();
    for (const r of db
      .prepare(
        "SELECT id, display_name, entity_type, given_name, surname, honorific, name_variants, legacy_ids FROM entities",
      )
      .all() as Array<{
      id: string;
      display_name: string;
      entity_type: string | null;
      given_name: string | null;
      surname: string | null;
      honorific: string | null;
      name_variants: string | null;
      legacy_ids: string | null;
    }>) {
      let variants: string[] = [];
      try {
        const v = JSON.parse(r.name_variants ?? "[]") as unknown;
        if (Array.isArray(v)) variants = v.filter((x): x is string => typeof x === "string");
      } catch {
        /* ignore malformed variants */
      }
      fields.set(r.id, {
        display_name: r.display_name,
        entity_type: r.entity_type,
        given_name: r.given_name,
        surname: r.surname,
        honorific: r.honorific,
        name_variants: variants,
      });
      const pk = extractDjangoPk(r.legacy_ids);
      if (pk !== null) pkToUuid.set(pk, r.id);
    }

    return { entityDescSets, descToEntities, fields, pkToUuid };
  } finally {
    db.close();
  }
}

/** The description-pk set of a pipeline entity. */
export function pipelineDescSet(ent: PipelineEntity): Set<number> {
  const s = new Set<number>();
  for (const m of ent.mention_dates ?? []) {
    if (typeof m?.description_id === "number") s.add(m.description_id);
  }
  return s;
}

const MIN_RATIO = 0.9;

/**
 * Fingerprint one pipeline entity against the production index. Pure
 * given the index; deterministic. `claimed` = production UUIDs already
 * taken by the content join (used only as the LAST tie-break filter).
 */
export function fingerprintEntity(
  ent: PipelineEntity,
  index: FingerprintIndex,
  claimed: Set<string>,
  gates: FingerprintGates = {},
): FingerprintOutcome {
  const P = pipelineDescSet(ent);
  if (P.size === 0) return { kind: "no-candidates" };
  if (gates.minSetSize && P.size < gates.minSetSize) {
    return { kind: "rejected", reason: "set-too-small", setSize: P.size };
  }

  const overlap = new Map<string, number>();
  for (const d of P) {
    for (const c of index.descToEntities.get(d) ?? []) {
      overlap.set(c, (overlap.get(c) ?? 0) + 1);
    }
  }
  if (overlap.size === 0) return { kind: "no-candidates" };

  let best = 0;
  for (const o of overlap.values()) if (o > best) best = o;
  const ratio = best / P.size;
  if (ratio < MIN_RATIO) {
    return { kind: "weak", bestRatio: ratio, setSize: P.size };
  }

  const ties = [...overlap.entries()]
    .filter(([, o]) => o === best)
    .map(([c]) => c)
    .sort();

  // HARD gates (hardened recipe). Unlike the tie-break filters below, a
  // hard gate that eliminates every candidate REJECTS the match — it
  // never "skips". This is the fix for the proven person↔institution
  // bindings: cross-type candidates are removed here, so the
  // `unclaimed` filter can never reach them.
  let pool = ties;
  if (gates.hardTypeGate) {
    const wanted = normaliseEntityType(ent.entity_type);
    const sameType = pool.filter(
      (c) => wanted !== null && index.fields.get(c)?.entity_type === wanted,
    );
    if (sameType.length === 0) {
      return {
        kind: "rejected",
        reason: "type-mismatch",
        setSize: P.size,
        candidates: pool,
      };
    }
    pool = sameType;
  }
  let bestCorroboration: number | undefined;
  if (gates.requireNameCorroboration) {
    const scored = pool.map((c) => {
      const f = index.fields.get(c);
      const score = f
        ? nameCorroboration(
            [ent.display_name, ...(ent.name_variants ?? [])],
            [f.display_name, ...f.name_variants],
          )
        : 0;
      return { c, score };
    });
    const corroborated = scored.filter((s) => s.score >= MIN_CORROBORATION);
    if (corroborated.length === 0) {
      return {
        kind: "rejected",
        reason: "no-name-corroboration",
        setSize: P.size,
        candidates: pool,
      };
    }
    pool = corroborated.map((s) => s.c);
    bestCorroboration = Math.max(...corroborated.map((s) => s.score));
  }

  type MatchMethod = "unique" | "exact-set" | "variant" | "type" | "unclaimed";
  const matched = (production_id: string, method: MatchMethod): FingerprintOutcome => ({
    kind: "matched",
    production_id,
    method,
    overlap: best,
    setSize: P.size,
    ...(bestCorroboration !== undefined ? { corroboration: bestCorroboration } : {}),
    ...(ties.length > 1
      ? { tiedWith: ties.filter((t) => t !== production_id) }
      : {}),
  });

  if (pool.length === 1) {
    return matched(pool[0], "unique");
  }

  // Tie-break filters, strongest evidence first. A filter that leaves
  // exactly one survivor decides; one that leaves zero is skipped.
  const filters: Array<{
    method: "exact-set" | "variant" | "type" | "unclaimed";
    keep: (c: string) => boolean;
  }> = [
    {
      method: "exact-set",
      keep: (c) => (index.entityDescSets.get(c)?.size ?? 0) === P.size,
    },
    {
      method: "variant",
      keep: (c) => {
        const f = index.fields.get(c);
        if (!f) return false;
        return (
          f.name_variants.includes(ent.display_name) ||
          (ent.name_variants ?? []).includes(f.display_name)
        );
      },
    },
    {
      method: "type",
      keep: (c) =>
        index.fields.get(c)?.entity_type === normaliseEntityType(ent.entity_type),
    },
    {
      method: "unclaimed",
      keep: (c) => !claimed.has(c),
    },
  ];
  for (const f of filters) {
    const survivors = pool.filter(f.keep);
    if (survivors.length === 1) {
      return matched(survivors[0], f.method);
    }
    if (survivors.length > 1) pool = survivors;
  }
  return { kind: "tied", candidates: pool, overlap: best, setSize: P.size };
}

/** Corroboration floor: shared-significant-token Jaccard. */
const MIN_CORROBORATION = 0.5;

/**
 * Spanish onomastic stopwords — particles, honorifics, and hagionymic
 * prefixes that agree across DISTINCT records ("Convento de San
 * Francisco" vs "Convento de San Agustín" share `de`+`san`; only
 * `convento` may count as shared substance).
 */
const NAME_STOPWORDS = new Set([
  "de", "del", "la", "las", "el", "los", "y", "e", "a", "en",
  "san", "santa", "santo", "nuestra", "nuestro", "senora", "senor",
  "don", "dona", "fray", "sor",
]);

function nameTokens(name: string): Set<string> {
  const folded = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const out = new Set<string>();
  for (const t of folded.split(/[^a-z0-9]+/)) {
    if (t.length > 1 && !NAME_STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Best token-Jaccard between any pipeline name form and any candidate
 * name form. 1.0 = identical significant tokens; "Administración de
 * Cali" vs "Administración de Cartagena" scores 1/3 and fails the 0.5
 * floor.
 */
export function nameCorroboration(
  pipelineNames: string[],
  candidateNames: string[],
): number {
  let bestScore = 0;
  for (const p of pipelineNames) {
    const pt = nameTokens(p);
    if (pt.size === 0) continue;
    for (const c of candidateNames) {
      const ct = nameTokens(c);
      if (ct.size === 0) continue;
      let inter = 0;
      for (const t of pt) if (ct.has(t)) inter += 1;
      const union = pt.size + ct.size - inter;
      const j = union === 0 ? 0 : inter / union;
      if (j > bestScore) bestScore = j;
    }
  }
  return bestScore;
}

// Version: v0.4.2
