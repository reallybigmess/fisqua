/**
 * Backfill — Module 3: authority_operations row builder
 *
 * This module deals with turning the pipeline's decisions into pre-SQL
 * `authority_operations` rows per authorities spec §10. Four operation
 * layers, and the exact endpoint semantics matter:
 *
 *   - `resolve` — one row per production-matched pipeline entity (how the
 *     record came to be). `source_id` = the production UUID (a
 *     self-referential resolve), `target_id` = NULL. Carries decision
 *     source/rule, verbatim reasoning where present, and the mention
 *     count. Unmatched/ambiguous entities produce NO row (they land in
 *     the report).
 *   - `merge` — one row per entity-to-entity absorption from the per-pass
 *     audit files. `source_id` = the absorbed entity's PIPELINE id (it
 *     never reached production — the no-FK column carries it), `target_id`
 *     = the production UUID of the surviving head (the immediate target
 *     walked through any later merges by the chain walker).
 *   - `split` — one row per (parent → child) pair of a TEMPORAL_SPLIT.
 *     `source_id` = the parent's PIPELINE id (recovered from the
 *     `cluster_id`, which is `TS-<parent>`; the parent was split away and
 *     is never in production), `target_id` = the child's production UUID.
 *   - `separate` — the do-not-relink rejection table §8 wants. `source_id`
 *     / `target_id` = the two entities ruled distinct.
 *
 * TWO MEASURED SHAPE FACTS force honest handling, not improvisation:
 *
 *   1. No timestamps. `audit_log.json` and every per-pass file carry no
 *      date/time/pass field on any of the 91,187 decisions, so
 *      `created_at` is the single documented Phase-13 constant
 *      (`PHASE_13_CREATED_AT_MS`), never a per-op pass date.
 *   2. SEPARATE has no entity endpoints in the audit log. 11,024 of
 *      11,034 SEPARATE decisions carry an EMPTY `entity_ids` and only
 *      cluster mention `group_ids` (e.g. `C00064-G2`). Only the 10
 *      decisions that do carry ≥2 joinable `entity_ids` become rows
 *      HERE; the group-only refusals are reconstructed from the per-repo
 *      cluster artifacts by `separate.ts` (group → mention indices →
 *      surviving entity) and land via `separatePairToRow` — the
 *      irrecoverable remainder is counted in the report, NOT invented.
 *
 * The audit_log MERGE decisions (8,450) are cluster-level (a head + mention
 * `group_ids`) and carry no absorbed entity_id, so merge rows are built
 * from the per-pass edges, and the cluster-level agent reasoning survives
 * on each surviving entity's `resolve` row (`decision_reasoning`).
 *
 * @version v0.4.2
 */

import {
  BACKFILL_ORIGIN,
  PHASE_13_CREATED_AT_MS,
  uuidv5,
} from "./ids";
import { resolveHead, type MergeGraph } from "./chains";
import type { SeparatePair } from "./separate";
import type {
  AuditDecision,
  AuthorityOperationRow,
  JoinResult,
  MatchedVia,
  MergeEdge,
  PipelineEntity,
  SkippedDecision,
} from "./types";

export interface BuildInputs {
  federationId: string;
  pipeline: PipelineEntity[];
  decisions: AuditDecision[];
  edges: MergeEdge[];
  graph: MergeGraph;
  join: JoinResult;
  /**
   * How a matched pipeline id was resolved, recorded only for entries
   * that did NOT come from the content join. Resolve rows carry the
   * value in `detail.matchedVia` so fingerprint/dump-backed provenance
   * stays distinguishable from the 99.2% content-joined bulk.
   */
  matchedVia?: Map<string, MatchedVia>;
}

export interface BuildOutput {
  rows: AuthorityOperationRow[];
  skipped: SkippedDecision[];
}

/** Strip the `TS-` prefix a TEMPORAL_SPLIT `cluster_id` carries. */
export function splitParentId(clusterId: string): string | null {
  const m = /^TS-(.+)$/.exec(clusterId);
  return m ? m[1] : null;
}

function mentionCount(ent: PipelineEntity): number {
  return Array.isArray(ent.mention_dates) ? ent.mention_dates.length : 0;
}

/**
 * Build every backfill row and the list of decisions that could not
 * become rows. Deterministic: same inputs → same PKs and same ordering
 * (resolve, then merge, then split, then separate).
 */
export function buildRows(inputs: BuildInputs): BuildOutput {
  const { federationId, pipeline, decisions, edges, graph, join, matchedVia } = inputs;
  const rows: AuthorityOperationRow[] = [];
  const skipped: SkippedDecision[] = [];
  const byId = new Map(pipeline.map((e) => [e.entity_id, e]));

  const base = {
    federation_id: federationId,
    record_type: "entity" as const,
    created_at: PHASE_13_CREATED_AT_MS,
  };

  // ---- Layer (b): resolve — one per production-matched entity. --------
  for (const ent of pipeline) {
    const productionId = join.matched.get(ent.entity_id);
    if (!productionId) continue; // unmatched/ambiguous → reported by join
    const via = matchedVia?.get(ent.entity_id);
    rows.push({
      ...base,
      id: uuidv5(`resolve:${ent.entity_id}`),
      operation: "resolve",
      source_id: productionId,
      target_id: null,
      detail: {
        origin: BACKFILL_ORIGIN,
        decisionSource: ent.decision_source ?? null,
        decisionRule: ent.decision_rule ?? null,
        ...(ent.decision_reasoning
          ? { reasoning: ent.decision_reasoning }
          : {}),
        mentionCount: mentionCount(ent),
        pipelineEntityId: ent.entity_id,
        ...(via && via !== "content" ? { matchedVia: via } : {}),
      },
    });
  }

  // ---- Layer (a1): merge — one per entity-to-entity absorption. -------
  const seenMerge = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.absorbed_entity_id}->${edge.target_entity_id}`;
    if (seenMerge.has(key)) continue;
    seenMerge.add(key);

    const { head } = resolveHead(edge.target_entity_id, graph);
    const productionTarget = join.matched.get(head);
    if (!productionTarget) {
      skipped.push({
        kind: "merge",
        reason: "merge-head-not-joinable",
        identifier: key,
        detail: { pass: edge.pass, head, absorbed: edge.absorbed_entity_id },
      });
      continue;
    }
    const headEnt = byId.get(head);
    rows.push({
      ...base,
      id: uuidv5(`merge:${edge.pass}:${edge.absorbed_entity_id}:${head}`),
      operation: "merge",
      source_id: edge.absorbed_entity_id,
      target_id: productionTarget,
      detail: {
        origin: BACKFILL_ORIGIN,
        pass: edge.pass,
        pipelineSourceId: edge.absorbed_entity_id,
        pipelineTargetId: head,
        sourceName: edge.absorbed_name,
        targetName: edge.target_name ?? headEnt?.display_name ?? null,
        decisionSource: edge.decision_source,
        decisionRule: edge.decision_rule,
        reasoning: edge.reasoning,
        snapshot: {
          absorbedEntityId: edge.absorbed_entity_id,
          absorbedName: edge.absorbed_name,
          immediateTargetId: edge.target_entity_id,
          pass: edge.pass,
        },
      },
    });
  }

  // ---- Layer (a2): split — one per (parent → child) pair. -------------
  for (const dec of decisions) {
    if (dec.action !== "TEMPORAL_SPLIT") continue;
    const parent = splitParentId(dec.cluster_id);
    if (!parent) {
      skipped.push({
        kind: "split",
        reason: "split-parent-unrecoverable",
        identifier: dec.decision_id,
      });
      continue;
    }
    for (const child of dec.entity_ids) {
      const { head } = resolveHead(child, graph);
      const productionChild = join.matched.get(head);
      if (!productionChild) {
        skipped.push({
          kind: "split",
          reason: "split-child-not-joinable",
          identifier: `${dec.decision_id}:${child}`,
          detail: { parent, child, head },
        });
        continue;
      }
      const childEnt = byId.get(head);
      rows.push({
        ...base,
        id: uuidv5(`split:${parent}:${head}`),
        operation: "split",
        source_id: parent,
        target_id: productionChild,
        detail: {
          origin: BACKFILL_ORIGIN,
          pass: "temporal-split",
          pipelineSourceId: parent,
          pipelineTargetId: head,
          sourceName: null,
          targetName: childEnt?.display_name ?? null,
          decisionSource: dec.source,
          decisionRule: dec.rule,
          reasoning: dec.reasoning,
        },
      });
    }
  }

  // ---- Layer (c): separate — do-not-relink pairs (see header fact 2). -
  for (const dec of decisions) {
    if (dec.action !== "SEPARATE") continue;
    const joinable = dec.entity_ids
      .map((id) => ({ id, prod: join.matched.get(resolveHead(id, graph).head) }))
      .filter((x): x is { id: string; prod: string } => Boolean(x.prod));
    if (joinable.length < 2) {
      skipped.push({
        kind: "separate",
        reason:
          dec.entity_ids.length === 0
            ? "separate-no-entity-endpoints"
            : "separate-endpoints-not-joinable",
        identifier: dec.decision_id,
        detail: { groupIds: dec.group_ids, entityIds: dec.entity_ids },
      });
      continue;
    }
    // One row per unordered pair ruled distinct.
    for (let i = 0; i < joinable.length; i++) {
      for (let j = i + 1; j < joinable.length; j++) {
        const a = joinable[i];
        const b = joinable[j];
        rows.push({
          ...base,
          id: uuidv5(`separate:${dec.decision_id}:${a.id}:${b.id}`),
          operation: "separate",
          source_id: a.prod,
          target_id: b.prod,
          detail: {
            origin: BACKFILL_ORIGIN,
            pipelineSourceId: a.id,
            pipelineTargetId: b.id,
            sourceName: byId.get(a.id)?.display_name ?? null,
            targetName: byId.get(b.id)?.display_name ?? null,
            decisionSource: dec.source,
            decisionRule: dec.rule,
            reasoning: dec.reasoning,
          },
        });
      }
    }
  }

  return { rows, skipped };
}

/**
 * Convert one reconstructed cluster SEPARATE pair (see `separate.ts`)
 * into a ledger row. The deterministic PK hashes the repo, cluster, and
 * the SORTED pipeline pair, so regeneration is stable and the same pair
 * asserted twice cannot land twice.
 */
export function separatePairToRow(
  pair: SeparatePair,
  federationId: string,
): AuthorityOperationRow {
  const [a, b] =
    pair.a < pair.b
      ? [
          { id: pair.a, prod: pair.productionA },
          { id: pair.b, prod: pair.productionB },
        ]
      : [
          { id: pair.b, prod: pair.productionB },
          { id: pair.a, prod: pair.productionA },
        ];
  return {
    id: uuidv5(`separate-cluster:${pair.repo}:${pair.clusterId}:${a.id}:${b.id}`),
    federation_id: federationId,
    record_type: "entity",
    operation: "separate",
    source_id: a.prod,
    target_id: b.prod,
    detail: {
      origin: BACKFILL_ORIGIN,
      pipelineSourceId: a.id,
      pipelineTargetId: b.id,
      clusterId: pair.clusterId,
      groupIds: pair.groupIds,
      decisionSource: pair.source,
      decisionRule: pair.rule,
      reasoning: pair.reasoning,
    },
    created_at: PHASE_13_CREATED_AT_MS,
  };
}

// Version: v0.4.2
