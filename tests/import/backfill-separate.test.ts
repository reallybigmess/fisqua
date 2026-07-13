/**
 * Tests — backfill SEPARATE reconstruction
 *
 * Pins the validated chain (decision group_ids → cluster group mention
 * indices → surviving entity via merge_source_ids → production UUID)
 * and its honest failure accounting: unresolvable decision groups,
 * missing counterparts, and unjoinable pairs are counted, never
 * approximated. Also pins pair semantics (decision groups × rest of
 * cluster), global dedupe, and the deterministic sorted-pair row shape.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import {
  buildMentionMap,
  emptySeparateStats,
  reconstructSeparatePairs,
  type RepoArtifacts,
} from "../../scripts/backfill/separate";
import { separatePairToRow } from "../../scripts/backfill/rows";
import { uuidv5, PHASE_13_CREATED_AT_MS } from "../../scripts/backfill/ids";
import type { PipelineEntity } from "../../scripts/backfill/types";

const pipeline: PipelineEntity[] = [
  { entity_id: "acc-10", repo: "acc", display_name: "A", merge_source_ids: [1, 2] },
  { entity_id: "acc-20", repo: "acc", display_name: "B", merge_source_ids: [3] },
  { entity_id: "acc-30", repo: "acc", display_name: "C", merge_source_ids: [4] },
];
const mentionMap = buildMentionMap(pipeline);
const mapping = new Map<string, string>([
  ["acc-10", "uuid-10"],
  ["acc-20", "uuid-20"],
  ["acc-30", "uuid-30"],
]);

function artifacts(overrides: Partial<RepoArtifacts> = {}): RepoArtifacts {
  return {
    repo: "acc",
    clusters: [
      {
        cluster_id: "C1",
        repo: "acc",
        groups: [
          { entity_name: "A", mention_indices: [1, 2] },
          { entity_name: "B", mention_indices: [3] },
          { entity_name: "C", mention_indices: [4] },
        ],
      },
    ],
    decisions: [
      { cluster_id: "C1", group_ids: ["C1-G0"], reasoning: "distinct", source: "agent", rule: null },
    ],
    ...overrides,
  };
}

describe("backfill/separate buildMentionMap", () => {
  it("keys mentions by (repo, index)", () => {
    expect(mentionMap.get("acc:1")).toBe("acc-10");
    expect(mentionMap.get("acc:4")).toBe("acc-30");
    expect(mentionMap.get("ahr:1")).toBeUndefined();
  });
});

describe("backfill/separate reconstructSeparatePairs", () => {
  it("pairs the decision's entity against every other group's entity", () => {
    const stats = emptySeparateStats();
    const pairs = reconstructSeparatePairs(artifacts(), mentionMap, mapping, new Set(), stats);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => `${p.a}|${p.b}`).sort()).toEqual([
      "acc-10|acc-20",
      "acc-10|acc-30",
    ]);
    expect(pairs[0]).toMatchObject({ productionA: "uuid-10", reasoning: "distinct" });
    expect(stats.decisionsYieldingRows).toBe(1);
    expect(stats.uniquePairs).toBe(2);
  });

  it("dedupes pairs already seen (shared set across decisions/repos)", () => {
    const stats = emptySeparateStats();
    const seen = new Set<string>(["acc-10|acc-20"]);
    const pairs = reconstructSeparatePairs(artifacts(), mentionMap, mapping, seen, stats);
    expect(pairs.map((p) => `${p.a}|${p.b}`)).toEqual(["acc-10|acc-30"]);
  });

  it("counts unresolvable decision groups (mentions dropped) without inventing", () => {
    const stats = emptySeparateStats();
    const art = artifacts({
      clusters: [
        {
          cluster_id: "C1",
          repo: "acc",
          groups: [
            { entity_name: "Gone", mention_indices: [99] },
            { entity_name: "B", mention_indices: [3] },
          ],
        },
      ],
    });
    const pairs = reconstructSeparatePairs(art, mentionMap, mapping, new Set(), stats);
    expect(pairs).toHaveLength(0);
    expect(stats.groupsUnresolvable).toBe(1);
  });

  it("counts decisions with no counterpart in the cluster", () => {
    const stats = emptySeparateStats();
    const art = artifacts({
      clusters: [
        {
          cluster_id: "C1",
          repo: "acc",
          groups: [{ entity_name: "A", mention_indices: [1, 2] }],
        },
      ],
    });
    reconstructSeparatePairs(art, mentionMap, mapping, new Set(), stats);
    expect(stats.noCounterpart).toBe(1);
  });

  it("counts pairs whose endpoints lack a production UUID", () => {
    const stats = emptySeparateStats();
    const partial = new Map([["acc-10", "uuid-10"]]);
    reconstructSeparatePairs(artifacts(), mentionMap, partial, new Set(), stats);
    expect(stats.pairsNotJoinable).toBe(1);
    expect(stats.uniquePairs).toBe(0);
  });

  it("counts bad group references", () => {
    const stats = emptySeparateStats();
    const art = artifacts({
      decisions: [
        { cluster_id: "C1", group_ids: ["C1-G9"], reasoning: null, source: null, rule: null },
      ],
    });
    reconstructSeparatePairs(art, mentionMap, mapping, new Set(), stats);
    expect(stats.badGroupRef).toBe(1);
  });
});

describe("backfill/separate separatePairToRow", () => {
  const pair = {
    a: "acc-20",
    b: "acc-10",
    productionA: "uuid-20",
    productionB: "uuid-10",
    repo: "acc",
    clusterId: "C1",
    groupIds: ["C1-G0"],
    reasoning: "distinct",
    source: "agent",
    rule: null,
  };

  it("sorts endpoints and hashes a deterministic PK", () => {
    const row = separatePairToRow(pair, "fed");
    expect(row.source_id).toBe("uuid-10");
    expect(row.target_id).toBe("uuid-20");
    expect(row.id).toBe(uuidv5("separate-cluster:acc:C1:acc-10:acc-20"));
    expect(row.created_at).toBe(PHASE_13_CREATED_AT_MS);
    expect(row.detail).toMatchObject({
      origin: "pipeline-backfill",
      pipelineSourceId: "acc-10",
      pipelineTargetId: "acc-20",
      reasoning: "distinct",
    });
  });
});

// Version: v0.4.2
