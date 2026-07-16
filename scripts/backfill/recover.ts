/**
 * Backfill — operation-endpoint recovery and classification
 *
 * This module deals with the merge-head and split-child ids that appear
 * in the audit files but are ABSENT from `entities_all.json` (they never
 * reached the final output). Measured 2026-07-10: 216 distinct missing
 * merge heads + 1,027 missing split children. Two recovery paths, then
 * honest classification of the rest:
 *
 *   - mention-set resolution: `data/{repo}/entities.json` holds the
 *     intermediate-stage record for many of these ids (display_name,
 *     dates, `merge_source_ids`). If the id's mentions all live in
 *     exactly ONE surviving final entity, the endpoint resolves to that
 *     entity (it was absorbed/renumbered into it) — measured 16 unique
 *     recoveries;
 *   - dump content match: an intermediate record whose
 *     `(display_name, year, year)` uniquely matches a Django dump row
 *     resolves straight to that production entity — measured 3;
 *   - `dropped_in_pipeline`: intermediate record exists but its mentions
 *     map to NO surviving entity — the record was removed in the
 *     quality-phase walk-down (92,043 → 78,476) and never reached
 *     Django. Correct outcome: the operation cannot be backfilled;
 *   - `no_pipeline_record`: the id appears only in the audit log; no
 *     content exists anywhere in the provided artifacts to resolve or
 *     even describe it.
 *
 * @version v0.4.2
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MentionMap } from "./separate";
import { SEPARATE_REPOS } from "./separate";
import { buildDumpContentIndex, dumpContentMatch, type DumpEntity } from "./dump";

/** One record of `data/{repo}/entities.json` (intermediate stage). */
export interface IntermediateEntity {
  entity_id: string;
  repo: string;
  display_name: string;
  date_earliest?: number | null;
  date_latest?: number | null;
  merge_source_ids?: number[] | null;
}

/** Read every repo's intermediate entities, keyed by entity_id. */
export function readIntermediateEntities(dataDir: string): Map<string, IntermediateEntity> {
  const out = new Map<string, IntermediateEntity>();
  for (const repo of SEPARATE_REPOS) {
    const p = path.join(dataDir, repo, "entities.json");
    if (!fs.existsSync(p)) continue;
    for (const e of JSON.parse(fs.readFileSync(p, "utf8")) as IntermediateEntity[]) {
      out.set(e.entity_id, e);
    }
  }
  return out;
}

export type EndpointRecovery =
  | { kind: "mention-unique"; finalId: string }
  | { kind: "dump-unique"; productionPk: number }
  | { kind: "dropped_in_pipeline" }
  | { kind: "no_pipeline_record" }
  | { kind: "ambiguous"; finalIds: string[] };

export interface EndpointRecoverer {
  recover(id: string): EndpointRecovery;
}

/**
 * Build a recoverer over the intermediate records, the mention map, and
 * the dump content index. Pure per call; deterministic.
 */
export function buildEndpointRecoverer(
  intermediates: Map<string, IntermediateEntity>,
  mentionMap: MentionMap,
  dumpEntities: Map<number, DumpEntity>,
): EndpointRecoverer {
  const dumpIdx = buildDumpContentIndex(dumpEntities);
  return {
    recover(id: string): EndpointRecovery {
      const e = intermediates.get(id);
      if (!e) return { kind: "no_pipeline_record" };

      const finals = new Set<string>();
      for (const mi of e.merge_source_ids ?? []) {
        const f = mentionMap.get(`${e.repo}:${mi}`);
        if (f) finals.add(f);
      }
      if (finals.size === 1) {
        return { kind: "mention-unique", finalId: [...finals][0] };
      }
      if (finals.size > 1) {
        return { kind: "ambiguous", finalIds: [...finals].sort() };
      }

      // Mentions dropped entirely — last chance: unique dump content match.
      const pks = dumpContentMatch(e, dumpIdx);
      if (pks.length === 1) {
        return { kind: "dump-unique", productionPk: pks[0] };
      }
      return { kind: "dropped_in_pipeline" };
    },
  };
}

// Version: v0.4.2
