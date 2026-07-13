/**
 * Tests — backfill content join (Module 1)
 *
 * Pins the measured recipe: exact match on `(display_name,
 * year(date_start), year(date_end))` with null matching only null,
 * classifying each pipeline entity matched / ambiguous / unmatched.
 * `yearKey` must take the first four chars of a production date string
 * and stringify a pipeline integer year to the same token.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import { classifyEntities, yearKey } from "../../scripts/backfill/join";
import type { PipelineEntity, ProductionEntity } from "../../scripts/backfill/types";

const prod: ProductionEntity[] = [
  { id: "uuid-A", display_name: "José de Mosquera Figueroa", date_start: "1733-01-01", date_end: "1778-12-31" },
  { id: "uuid-B", display_name: "Undated Person", date_start: null, date_end: null },
  { id: "uuid-C", display_name: "Twin", date_start: "1700-01-01", date_end: "1710-12-31" },
  { id: "uuid-D", display_name: "Twin", date_start: "1700-06-01", date_end: "1710-01-01" },
];

function ent(o: Partial<PipelineEntity> & { entity_id: string; display_name: string }): PipelineEntity {
  return { date_earliest: null, date_latest: null, ...o };
}

describe("backfill/join yearKey", () => {
  it("takes the first four chars of a production date string", () => {
    expect(yearKey("1733-01-01")).toBe("1733");
  });
  it("stringifies a pipeline integer year to the same token", () => {
    expect(yearKey(1733)).toBe("1733");
  });
  it("null/empty collapse to a distinct token that is not any year", () => {
    expect(yearKey(null)).toBe(yearKey(undefined));
    expect(yearKey(null)).not.toBe("1733");
  });
});

describe("backfill/join classifyEntities", () => {
  it("matches an entity 1:1 by name + years", () => {
    const r = classifyEntities(
      [ent({ entity_id: "acc-1", display_name: "José de Mosquera Figueroa", date_earliest: 1733, date_latest: 1778 })],
      prod,
    );
    expect(r.matched.get("acc-1")).toBe("uuid-A");
    expect(r.ambiguous).toHaveLength(0);
    expect(r.unmatched).toHaveLength(0);
  });

  it("matches null dates only to null dates", () => {
    const r = classifyEntities(
      [ent({ entity_id: "acc-2", display_name: "Undated Person" })],
      prod,
    );
    expect(r.matched.get("acc-2")).toBe("uuid-B");
  });

  it("flags >1 production hit as ambiguous, producing no match", () => {
    const r = classifyEntities(
      [ent({ entity_id: "acc-3", display_name: "Twin", date_earliest: 1700, date_latest: 1710 })],
      prod,
    );
    expect(r.matched.has("acc-3")).toBe(false);
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].production_ids.sort()).toEqual(["uuid-C", "uuid-D"]);
  });

  it("flags a missing production row as unmatched", () => {
    const r = classifyEntities(
      [ent({ entity_id: "acc-4", display_name: "Ghost", date_earliest: 1600, date_latest: 1601 })],
      prod,
    );
    expect(r.unmatched.map((u) => u.pipeline_entity_id)).toEqual(["acc-4"]);
  });

  it("a name-match with a mismatched year does not match", () => {
    const r = classifyEntities(
      [ent({ entity_id: "acc-5", display_name: "José de Mosquera Figueroa", date_earliest: 1733, date_latest: 1999 })],
      prod,
    );
    expect(r.matched.has("acc-5")).toBe(false);
    expect(r.unmatched).toHaveLength(1);
  });
});

// Version: v0.4.2
