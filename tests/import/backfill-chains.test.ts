/**
 * Tests — backfill chain walker (Module 2)
 *
 * Pins the two jobs: normalise the several per-pass audit shapes into one
 * `absorbed → target` edge, and walk any endpoint to its surviving head
 * (the fixed point of the merge graph), cycle-guarded. The multi-hop walk
 * is the mechanism that resolves the ~16-20% of endpoints absorbed by a
 * LATER merge before `entities_all.json` was written.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import { extractEdges, buildMergeGraph, resolveHead } from "../../scripts/backfill/chains";

describe("backfill/chains extractEdges", () => {
  it("reads shape A (absorbed_entity_id → target_entity_id)", () => {
    const e = extractEdges(
      [{ absorbed_entity_id: "acc-08032", target_entity_id: "acc-00548", absorbed_name: "Matheo", target_name: "Mateo", source: "deterministic_ortho_variant" }],
      "ortho",
    );
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ absorbed_entity_id: "acc-08032", target_entity_id: "acc-00548", pass: "ortho" });
  });

  it("reads shape B (primary_entity_id ← absorbed_entity_id)", () => {
    const e = extractEdges(
      [{ primary_entity_id: "acc-00127", absorbed_entity_id: "ahr-00884", source: "deterministic" }],
      "cross_repo",
    );
    expect(e[0]).toMatchObject({ absorbed_entity_id: "ahr-00884", target_entity_id: "acc-00127" });
  });

  it("reads shape C (primary_id ← absorbed_ids[]) as one edge each", () => {
    const e = extractEdges(
      [{ primary_id: "acc-08891", absorbed_ids: ["acc-08899", "acc-08945"], reasoning: "abbrev" }],
      "abbrev",
    );
    expect(e.map((x) => x.absorbed_entity_id).sort()).toEqual(["acc-08899", "acc-08945"]);
    expect(e.every((x) => x.target_entity_id === "acc-08891")).toBe(true);
  });

  it("reads the institution summary dict's merge_decisions array", () => {
    const e = extractEdges(
      { total_groups: 1, merge_decisions: [{ primary_entity_id: "acc-06814", absorbed_entity_id: "acc-06835", reasoning: "r" }] },
      "institution_agent",
    );
    expect(e[0]).toMatchObject({ absorbed_entity_id: "acc-06835", target_entity_id: "acc-06814", reasoning: "r" });
  });
});

describe("backfill/chains resolveHead", () => {
  it("returns the id itself when it is a surviving head", () => {
    const g = buildMergeGraph([]);
    expect(resolveHead("acc-1", g)).toMatchObject({ head: "acc-1", absorbed: false });
  });

  it("walks a multi-hop chain to the surviving head", () => {
    const g = buildMergeGraph([
      { absorbed_entity_id: "a", target_entity_id: "b", pass: "p1", absorbed_name: null, target_name: null, decision_source: null, decision_rule: null, reasoning: null },
      { absorbed_entity_id: "b", target_entity_id: "c", pass: "p2", absorbed_name: null, target_name: null, decision_source: null, decision_rule: null, reasoning: null },
    ]);
    const r = resolveHead("a", g);
    expect(r.head).toBe("c");
    expect(r.path).toEqual(["a", "b", "c"]);
    expect(r.absorbed).toBe(true);
  });

  it("is cycle-guarded (a → b → a stops without looping)", () => {
    const g = buildMergeGraph([
      { absorbed_entity_id: "a", target_entity_id: "b", pass: "p", absorbed_name: null, target_name: null, decision_source: null, decision_rule: null, reasoning: null },
      { absorbed_entity_id: "b", target_entity_id: "a", pass: "p", absorbed_name: null, target_name: null, decision_source: null, decision_rule: null, reasoning: null },
    ]);
    const r = resolveHead("a", g);
    expect(r.path.length).toBeLessThanOrEqual(3);
  });
});

// Version: v0.4.2
