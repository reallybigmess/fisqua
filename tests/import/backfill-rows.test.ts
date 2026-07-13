/**
 * Tests — backfill row builder (Module 3)
 *
 * Pins the §10 endpoint semantics for all four layers, plus the two
 * measured shape facts the design has to bend to:
 *   - `resolve` rows are self-referential (source = production UUID,
 *     target = NULL) and stamped with the Phase-13 constant.
 *   - `merge` source_id is the ABSORBED PIPELINE id (never a production
 *     UUID), target_id the surviving head's production UUID, reasoning in
 *     detail — the acc-08032 → acc-00548 spot-check.
 *   - `split` source_id is the parent recovered from `TS-<parent>`.
 *   - SEPARATE with no entity endpoints produces NO row and is reported
 *     as blocked, not invented.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import { buildRows, splitParentId } from "../../scripts/backfill/rows";
import { buildMergeGraph } from "../../scripts/backfill/chains";
import { uuidv5, PHASE_13_CREATED_AT_MS } from "../../scripts/backfill/ids";
import type { AuditDecision, JoinResult, MergeEdge, PipelineEntity } from "../../scripts/backfill/types";

const FED = "b4462493-6170-44f8-ae07-24666606d1f1";

const pipeline: PipelineEntity[] = [
  { entity_id: "acc-00548", display_name: "Mateo de Mata Ponce de León", date_earliest: 1679, date_latest: 1696, decision_source: "deterministic", decision_rule: null, decision_reasoning: null, mention_dates: [{}, {}] },
  { entity_id: "acc-00002", display_name: "José de Mosquera Figueroa", date_earliest: 1733, date_latest: 1778, decision_source: "agent", decision_rule: null, decision_reasoning: "agent merged variants", mention_dates: [{}] },
  { entity_id: "acc-99999", display_name: "Unmatched", date_earliest: null, date_latest: null, decision_source: "singleton", decision_rule: null, decision_reasoning: null, mention_dates: [] },
];

const join: JoinResult = {
  matched: new Map([
    ["acc-00548", "uuid-548"],
    ["acc-00002", "uuid-002"],
  ]),
  ambiguous: [],
  unmatched: [{ pipeline_entity_id: "acc-99999", display_name: "Unmatched", year_start: null, year_end: null }],
};

const edges: MergeEdge[] = [
  { absorbed_entity_id: "acc-08032", target_entity_id: "acc-00548", pass: "ortho_variant_merge_audit", absorbed_name: "Matheo de Matta Ponce de León", target_name: "Mateo de Mata Ponce de León", decision_source: "deterministic_ortho_variant", decision_rule: null, reasoning: "orthographic variant" },
];

const decisions: AuditDecision[] = [
  { decision_id: "acc-TS-acc-00001-TEMPORAL_SPLIT", repo: "acc", cluster_id: "TS-acc-00001", action: "TEMPORAL_SPLIT", source: "temporal", rule: null, group_ids: ["TG0"], entity_ids: ["acc-00548"], reasoning: "split reasoning" },
  { decision_id: "acc-C1-SEPARATE", repo: "acc", cluster_id: "C1", action: "SEPARATE", source: "agent", rule: null, group_ids: ["C1-G2"], entity_ids: [], reasoning: "distinct person" },
  { decision_id: "acc-C2-SEPARATE", repo: "acc", cluster_id: "C2", action: "SEPARATE", source: "agent", rule: null, group_ids: ["C2-G0", "C2-G1"], entity_ids: ["acc-00548", "acc-00002"], reasoning: "not the same" },
];

function build() {
  return buildRows({ federationId: FED, pipeline, decisions, edges, graph: buildMergeGraph(edges), join });
}

describe("backfill/rows splitParentId", () => {
  it("strips the TS- prefix", () => {
    expect(splitParentId("TS-acc-00001")).toBe("acc-00001");
    expect(splitParentId("C00863")).toBeNull();
  });
});

describe("backfill/rows buildRows", () => {
  it("emits a self-referential resolve row per matched entity", () => {
    const { rows } = build();
    const resolves = rows.filter((r) => r.operation === "resolve");
    expect(resolves).toHaveLength(2); // acc-99999 unmatched → no row
    const r548 = resolves.find((r) => r.source_id === "uuid-548")!;
    expect(r548.target_id).toBeNull();
    expect(r548.created_at).toBe(PHASE_13_CREATED_AT_MS);
    expect(r548.detail).toMatchObject({ origin: "pipeline-backfill", pipelineEntityId: "acc-00548", mentionCount: 2 });
  });

  it("emits a merge row with absorbed pipeline id as source and reasoning in detail (spot-check)", () => {
    const { rows } = build();
    const merges = rows.filter((r) => r.operation === "merge");
    expect(merges).toHaveLength(1);
    const m = merges[0];
    expect(m.source_id).toBe("acc-08032"); // absorbed pipeline id, NOT a UUID
    expect(m.target_id).toBe("uuid-548"); // surviving head's production UUID
    expect(m.detail).toMatchObject({ pipelineTargetId: "acc-00548", reasoning: "orthographic variant", sourceName: "Matheo de Matta Ponce de León" });
    expect(m.id).toBe(uuidv5("merge:ortho_variant_merge_audit:acc-08032:acc-00548"));
  });

  it("emits a split row whose source is the TS- parent", () => {
    const { rows } = build();
    const splits = rows.filter((r) => r.operation === "split");
    expect(splits).toHaveLength(1);
    expect(splits[0].source_id).toBe("acc-00001");
    expect(splits[0].target_id).toBe("uuid-548");
  });

  it("emits a separate row for a decision carrying joinable endpoints", () => {
    const { rows } = build();
    const seps = rows.filter((r) => r.operation === "separate");
    expect(seps).toHaveLength(1);
    expect([seps[0].source_id, seps[0].target_id].sort()).toEqual(["uuid-002", "uuid-548"]);
  });

  it("does NOT invent rows for endpoint-less SEPARATE; reports them as blocked", () => {
    const { skipped } = build();
    const blocked = skipped.filter((s) => s.reason === "separate-no-entity-endpoints");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].identifier).toBe("acc-C1-SEPARATE");
  });

  it("is deterministic: same inputs → identical row ids", () => {
    const a = build().rows.map((r) => r.id);
    const b = build().rows.map((r) => r.id);
    expect(a).toEqual(b);
  });
});

// Version: v0.4.2
