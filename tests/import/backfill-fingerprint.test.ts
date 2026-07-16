/**
 * Tests — backfill description-set fingerprint
 *
 * Pins BOTH rule sets. The lax recipe (options omitted) exists only to
 * reproduce the deferral inventory: ≥90% coverage bar, unique-best
 * wins, the four tie-break filters, tied/weak returned as such, and the
 * many-to-one consolidation behaviour. The HARDENED recipe pins the
 * adversarial-review gates: setSize ≥ 3 floor, entity-type consistency
 * as a HARD reject (an institution can never bind a person via the
 * unclaimed fall-through), and lexical name corroboration (Cali cannot
 * bind Cartagena on one shared document).
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import {
  HARDENED_FINGERPRINT,
  fingerprintEntity,
  nameCorroboration,
  normaliseEntityType,
  pipelineDescSet,
  type FingerprintIndex,
  type ProductionEntityFields,
} from "../../scripts/backfill/fingerprint";
import type { PipelineEntity } from "../../scripts/backfill/types";

function makeIndex(
  sets: Record<string, number[]>,
  fields: Record<string, Partial<ProductionEntityFields>> = {},
): FingerprintIndex {
  const entityDescSets = new Map<string, Set<number>>();
  const descToEntities = new Map<number, Set<string>>();
  for (const [id, descs] of Object.entries(sets)) {
    entityDescSets.set(id, new Set(descs));
    for (const d of descs) {
      let s = descToEntities.get(d);
      if (!s) descToEntities.set(d, (s = new Set()));
      s.add(id);
    }
  }
  const f = new Map<string, ProductionEntityFields>();
  for (const id of Object.keys(sets)) {
    f.set(id, {
      display_name: `Prod ${id}`,
      entity_type: "person",
      given_name: null,
      surname: null,
      honorific: null,
      name_variants: [],
      ...fields[id],
    });
  }
  return { entityDescSets, descToEntities, fields: f, pkToUuid: new Map() };
}

function ent(descIds: number[], o: Partial<PipelineEntity> = {}): PipelineEntity {
  return {
    entity_id: "acc-1",
    display_name: "Test",
    mention_dates: descIds.map((d) => ({ description_id: d })),
    ...o,
  };
}

describe("backfill/fingerprint basics", () => {
  it("normalises pipeline institution to production corporate", () => {
    expect(normaliseEntityType("institution")).toBe("corporate");
    expect(normaliseEntityType("person")).toBe("person");
  });

  it("extracts the description set from mention_dates", () => {
    expect([...pipelineDescSet(ent([5, 5, 7]))].sort()).toEqual([5, 7]);
  });

  it("matches a unique full-coverage candidate", () => {
    const idx = makeIndex({ "uuid-A": [1, 2, 3], "uuid-B": [9] });
    const r = fingerprintEntity(ent([1, 2, 3]), idx, new Set());
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-A", method: "unique" });
  });

  it("allows containment (consolidation): P strictly inside a bigger E", () => {
    const idx = makeIndex({ "uuid-A": [1, 2, 3, 4, 5, 6] });
    const r = fingerprintEntity(ent([1, 2, 3]), idx, new Set(["uuid-A"]));
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-A" });
  });

  it("returns weak below the 90% coverage bar — never guesses", () => {
    const idx = makeIndex({ "uuid-A": [1, 2] });
    const r = fingerprintEntity(ent([1, 2, 3, 4]), idx, new Set());
    expect(r.kind).toBe("weak");
  });

  it("returns no-candidates when nothing overlaps", () => {
    const idx = makeIndex({ "uuid-A": [9] });
    expect(fingerprintEntity(ent([1]), idx, new Set()).kind).toBe("no-candidates");
  });
});

describe("backfill/fingerprint tie-breaks", () => {
  it("exact-set beats a superset candidate on a tie", () => {
    const idx = makeIndex({ "uuid-exact": [1], "uuid-super": [1, 2, 3] });
    const r = fingerprintEntity(ent([1]), idx, new Set());
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-exact", method: "exact-set" });
  });

  it("variant cross-reference breaks a tie", () => {
    const idx = makeIndex(
      { "uuid-A": [1], "uuid-B": [1] },
      { "uuid-B": { name_variants: ["Junta Vieja"] } },
    );
    const r = fingerprintEntity(ent([1], { display_name: "Junta Vieja" }), idx, new Set());
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-B", method: "variant" });
  });

  it("entity type breaks a tie, mapping institution to corporate", () => {
    const idx = makeIndex(
      { "uuid-p": [1], "uuid-c": [1] },
      { "uuid-c": { entity_type: "corporate" } },
    );
    const r = fingerprintEntity(
      ent([1], { entity_type: "institution" }),
      idx,
      new Set(),
    );
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-c", method: "type" });
  });

  it("unclaimed status is the LAST filter", () => {
    const idx = makeIndex({ "uuid-A": [1], "uuid-B": [1] });
    const r = fingerprintEntity(ent([1]), idx, new Set(["uuid-A"]));
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-B", method: "unclaimed" });
  });

  it("stays tied when no filter separates the pool", () => {
    const idx = makeIndex({ "uuid-A": [1], "uuid-B": [1] });
    const r = fingerprintEntity(ent([1]), idx, new Set());
    expect(r.kind).toBe("tied");
    if (r.kind === "tied") expect(r.candidates.sort()).toEqual(["uuid-A", "uuid-B"]);
  });

  it("is many-to-one: two pipeline entities may match the same production entity", () => {
    const idx = makeIndex({ "uuid-A": [1, 2, 3, 4] });
    const r1 = fingerprintEntity(ent([1, 2]), idx, new Set());
    const r2 = fingerprintEntity(ent([3, 4]), idx, new Set());
    expect(r1).toMatchObject({ kind: "matched", production_id: "uuid-A" });
    expect(r2).toMatchObject({ kind: "matched", production_id: "uuid-A" });
  });
});

describe("backfill/fingerprint hardened gates", () => {
  it("rejects below the setSize floor — one shared document proves nothing", () => {
    const idx = makeIndex({ "uuid-A": [1] });
    const r = fingerprintEntity(ent([1]), idx, new Set(), HARDENED_FINGERPRINT);
    expect(r).toMatchObject({ kind: "rejected", reason: "set-too-small" });
  });

  it("HARD-rejects when no same-type candidate survives (never binds institution to person)", () => {
    // The reviewer's proven failure mode: an institution whose documents
    // carry only person candidates. Lax rules fell through to
    // `unclaimed` and bound a person; hardened rules must REJECT.
    const idx = makeIndex(
      { "uuid-person": [1, 2, 3] },
      { "uuid-person": { entity_type: "person", display_name: "Antonio Garrido" } },
    );
    const e = ent([1, 2, 3], {
      display_name: "Junta Subalterna de Diezmos del Citará",
      entity_type: "institution",
    });
    expect(fingerprintEntity(e, idx, new Set())).toMatchObject({
      kind: "matched",
      production_id: "uuid-person",
    });
    expect(fingerprintEntity(e, idx, new Set(), HARDENED_FINGERPRINT)).toMatchObject({
      kind: "rejected",
      reason: "type-mismatch",
    });
  });

  it("rejects without lexical corroboration — Cali cannot bind Cartagena", () => {
    const idx = makeIndex(
      { "uuid-cart": [1, 2, 3] },
      {
        "uuid-cart": {
          entity_type: "corporate",
          display_name: "Administración de Cartagena",
        },
      },
    );
    const e = ent([1, 2, 3], {
      display_name: "Administración de Cali",
      entity_type: "institution",
    });
    const r = fingerprintEntity(e, idx, new Set(), HARDENED_FINGERPRINT);
    expect(r).toMatchObject({ kind: "rejected", reason: "no-name-corroboration" });
  });

  it("accepts a corroborated same-type containment match with evidence attached", () => {
    const idx = makeIndex(
      { "uuid-rh": [1, 2, 3, 4, 5, 6] },
      {
        "uuid-rh": { entity_type: "corporate", display_name: "Real Hacienda" },
      },
    );
    const e = ent([1, 2, 3], {
      display_name: "Junta de Real Hacienda",
      entity_type: "institution",
    });
    const r = fingerprintEntity(e, idx, new Set(["uuid-rh"]), HARDENED_FINGERPRINT);
    expect(r).toMatchObject({ kind: "matched", production_id: "uuid-rh" });
    if (r.kind === "matched") {
      expect(r.corroboration).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("the unclaimed filter can only rank same-type corroborated candidates", () => {
    // Two corporate candidates sharing the docs and the name; only the
    // unclaimed one survives — legitimate. A person candidate in the
    // same pool never reaches this filter.
    const idx = makeIndex(
      { "uuid-a": [1, 2, 3], "uuid-b": [1, 2, 3], "uuid-p": [1, 2, 3] },
      {
        "uuid-a": { entity_type: "corporate", display_name: "Real Contaduría" },
        "uuid-b": { entity_type: "corporate", display_name: "Real Contaduría" },
        "uuid-p": { entity_type: "person", display_name: "Real Contaduría" },
      },
    );
    const e = ent([1, 2, 3], {
      display_name: "Real Contaduría",
      entity_type: "institution",
    });
    const r = fingerprintEntity(e, idx, new Set(["uuid-a"]), HARDENED_FINGERPRINT);
    expect(r).toMatchObject({
      kind: "matched",
      production_id: "uuid-b",
      method: "unclaimed",
    });
  });
});

describe("backfill/fingerprint nameCorroboration", () => {
  it("scores identical significant tokens 1.0 across diacritics", () => {
    expect(nameCorroboration(["Administración de Cali"], ["administracion de cali"])).toBe(1);
  });

  it("scores geographically distinct institutions below the 0.5 floor", () => {
    expect(
      nameCorroboration(["Administración de Cali"], ["Administración de Cartagena"]),
    ).toBeLessThan(0.5);
  });

  it("treats hagionymic prefixes as stopwords — distinct convents do not corroborate", () => {
    expect(
      nameCorroboration(["Convento de San Francisco"], ["Convento de San Agustín"]),
    ).toBeLessThan(0.5);
  });

  it("uses the best score across variants", () => {
    expect(
      nameCorroboration(["X", "Real Hacienda"], ["Real Hacienda de Popayán"]),
    ).toBeGreaterThanOrEqual(0.5);
  });
});

// Version: v0.4.2
