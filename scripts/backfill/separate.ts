/**
 * Backfill — SEPARATE reconstruction from per-repo cluster artifacts
 *
 * This module deals with the refuted-merge layer (§10 ruling 2c) that
 * `audit_log.json` alone cannot deliver: 11,024 of the 11,034 SEPARATE
 * decisions carry EMPTY `entity_ids` — only cluster mention group
 * references (`C00064-G2`). The entity endpoints are recoverable from
 * the pipeline repo's per-repo artifacts, and the chain was validated
 * empirically (2026-07-10):
 *
 *   decision.group_ids → `data/{repo}/clusters.json` cluster.groups[i]
 *   → group.mention_indices → the final entity whose `merge_source_ids`
 *   contains those mentions (entities_all) → production UUID (mapping).
 *
 * Semantics: a SEPARATE decision on groups G of cluster C asserts G's
 * entities are NOT the same as the entities of C's other groups. The
 * do-not-relink rows are therefore the cross pairs (entity of G ×
 * entity of C\G), deduplicated globally by unordered pipeline-id pair.
 * The decision's verbatim reasoning rides in `detail`.
 *
 * Honest failure accounting (measured ~64% of decisions yield rows):
 *   - `clusterMissing` / `badGroupRef` — artifact inconsistencies;
 *   - `groupsUnresolvable` — the decision's own groups' mentions map to
 *     no surviving entity (dropped in the quality walk-down);
 *   - `noCounterpart` — the rest of the cluster resolves to nothing;
 *   - `pairsNotJoinable` — endpoints resolved but at least one side has
 *     no production UUID.
 * None of these are approximated; they are counted and reported.
 *
 * @version v0.4.2
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineEntity, SeparateStats } from "./types";

/** The repos with per-repo cluster/decision artifacts. */
export const SEPARATE_REPOS = ["acc", "ahjci", "ahr", "ahrb", "pe-bn"] as const;

export interface ClusterGroup {
  entity_name?: string;
  mention_indices?: number[];
}

export interface Cluster {
  cluster_id: string;
  repo: string;
  groups: ClusterGroup[];
}

export interface SeparateDecision {
  cluster_id: string;
  group_ids: string[];
  reasoning: string | null;
  source: string | null;
  rule: string | null;
}

/** One reconstructed do-not-relink pair (pipeline final-entity ids). */
export interface SeparatePair {
  a: string;
  b: string;
  productionA: string;
  productionB: string;
  repo: string;
  clusterId: string;
  groupIds: string[];
  reasoning: string | null;
  source: string | null;
  rule: string | null;
}

/** `(repo, mention_index)` → surviving final entity id. */
export type MentionMap = Map<string, string>;

export function buildMentionMap(pipeline: PipelineEntity[]): MentionMap {
  const m: MentionMap = new Map();
  for (const e of pipeline) {
    const repo = e.repo ?? "";
    for (const idx of e.merge_source_ids ?? []) {
      m.set(`${repo}:${idx}`, e.entity_id);
    }
  }
  return m;
}

export interface RepoArtifacts {
  repo: string;
  clusters: Cluster[];
  decisions: SeparateDecision[];
}

/** Read one repo's clusters + separate decisions; missing repo → null. */
export function readRepoArtifacts(dataDir: string, repo: string): RepoArtifacts | null {
  const clustersPath = path.join(dataDir, repo, "clusters.json");
  const decisionsPath = path.join(dataDir, repo, "decisions", "decisions_separate.json");
  if (!fs.existsSync(clustersPath) || !fs.existsSync(decisionsPath)) return null;
  return {
    repo,
    clusters: JSON.parse(fs.readFileSync(clustersPath, "utf8")) as Cluster[],
    decisions: JSON.parse(fs.readFileSync(decisionsPath, "utf8")) as SeparateDecision[],
  };
}

const GROUP_INDEX_RE = /-G(\d+)$/;

/**
 * Reconstruct do-not-relink pairs for one repo. Pure given the inputs.
 * `mapping` = pipeline final-entity id → production UUID (content +
 * fingerprint + dump). `pairsSeen` dedupes across repos/decisions and is
 * mutated by the caller's shared set.
 */
export function reconstructSeparatePairs(
  artifacts: RepoArtifacts,
  mentionMap: MentionMap,
  mapping: Map<string, string>,
  pairsSeen: Set<string>,
  stats: SeparateStats,
): SeparatePair[] {
  const byCluster = new Map(artifacts.clusters.map((c) => [c.cluster_id, c]));
  const pairs: SeparatePair[] = [];

  for (const dec of artifacts.decisions) {
    stats.decisionsTotal += 1;
    const cluster = byCluster.get(dec.cluster_id);
    if (!cluster) {
      stats.clusterMissing += 1;
      continue;
    }

    // Resolve every group of the cluster to its surviving entity set.
    const groupEntities: Array<Set<string>> = cluster.groups.map((g) => {
      const s = new Set<string>();
      for (const mi of g.mention_indices ?? []) {
        const e = mentionMap.get(`${artifacts.repo}:${mi}`);
        if (e) s.add(e);
      }
      return s;
    });

    // Which group indices does this decision assert as distinct?
    const decisionIdx = new Set<number>();
    let badRef = false;
    for (const gid of dec.group_ids) {
      const m = GROUP_INDEX_RE.exec(gid);
      const i = m ? Number(m[1]) : NaN;
      if (!m || i >= groupEntities.length) {
        badRef = true;
        break;
      }
      decisionIdx.add(i);
    }
    if (badRef) {
      stats.badGroupRef += 1;
      continue;
    }

    const mine = new Set<string>();
    for (const i of decisionIdx) for (const e of groupEntities[i]) mine.add(e);
    const others = new Set<string>();
    for (let i = 0; i < groupEntities.length; i++) {
      if (decisionIdx.has(i)) continue;
      for (const e of groupEntities[i]) if (!mine.has(e)) others.add(e);
    }

    if (mine.size === 0) {
      stats.groupsUnresolvable += 1;
      continue;
    }
    if (others.size === 0) {
      stats.noCounterpart += 1;
      continue;
    }

    let yielded = 0;
    for (const a of [...mine].sort()) {
      const pa = mapping.get(a);
      if (!pa) continue;
      for (const b of [...others].sort()) {
        const pb = mapping.get(b);
        if (!pb || pa === pb) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (pairsSeen.has(key)) continue;
        pairsSeen.add(key);
        pairs.push({
          a,
          b,
          productionA: pa,
          productionB: pb,
          repo: artifacts.repo,
          clusterId: dec.cluster_id,
          groupIds: dec.group_ids,
          reasoning: dec.reasoning,
          source: dec.source,
          rule: dec.rule,
        });
        yielded += 1;
      }
    }
    if (yielded > 0) {
      stats.decisionsYieldingRows += 1;
      stats.uniquePairs += yielded;
    } else {
      stats.pairsNotJoinable += 1;
    }
  }
  return pairs;
}

export function emptySeparateStats(): SeparateStats {
  return {
    decisionsTotal: 0,
    decisionsYieldingRows: 0,
    clusterMissing: 0,
    badGroupRef: 0,
    groupsUnresolvable: 0,
    noCounterpart: 0,
    pairsNotJoinable: 0,
    uniquePairs: 0,
  };
}

// Version: v0.4.2
