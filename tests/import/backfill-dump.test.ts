/**
 * Tests — backfill Django-dump dataset handling
 *
 * Pins the dump content index (production recipe, null-only-matches-
 * null), the extra-field disambiguation of content-ambiguous entities
 * (unique top scorer with ≥1 agreeing field; ties and zero-signal stay
 * ambiguous), and the redirect merge rows: production UUIDs on BOTH
 * sides via the pk → UUID map, `origin: "django-manual"`, the Phase-13
 * created_at constant, unresolvable pks reported not guessed, and the
 * place merges counted but never built.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import {
  buildDumpContentIndex,
  buildRedirectMergeRows,
  disambiguateByFields,
  dumpContentMatch,
  type DumpDataset,
  type DumpEntity,
} from "../../scripts/backfill/dump";
import { PHASE_13_CREATED_AT_MS, uuidv5 } from "../../scripts/backfill/ids";
import type { ProductionEntityFields } from "../../scripts/backfill/fingerprint";
import type { PipelineEntity } from "../../scripts/backfill/types";

const dumpEnt = (o: Partial<DumpEntity>): DumpEntity => ({
  display_name: "X",
  date_start: null,
  date_end: null,
  name_variants: [],
  given_name: null,
  surname: null,
  honorific: null,
  entity_type: "person",
  ...o,
});

describe("backfill/dump content index", () => {
  const entities = new Map<number, DumpEntity>([
    [10, dumpEnt({ display_name: "Ana", date_start: "1700-01-01", date_end: "1750-12-31" })],
    [11, dumpEnt({ display_name: "Ana" })],
  ]);
  const idx = buildDumpContentIndex(entities);

  it("matches on (name, year, year) with year truncation", () => {
    expect(dumpContentMatch({ display_name: "Ana", date_earliest: 1700, date_latest: 1750 }, idx)).toEqual([10]);
  });

  it("null years match only null years", () => {
    expect(dumpContentMatch({ display_name: "Ana" }, idx)).toEqual([11]);
    expect(dumpContentMatch({ display_name: "Ana", date_earliest: 1750, date_latest: 1750 }, idx)).toEqual([]);
  });
});

describe("backfill/dump disambiguateByFields", () => {
  const fields = new Map<string, ProductionEntityFields>([
    ["uuid-A", { display_name: "José Pérez", entity_type: "person", given_name: "José", surname: "Pérez", honorific: "Don", name_variants: [] }],
    ["uuid-B", { display_name: "José Pérez", entity_type: "person", given_name: "José María", surname: "Pérez", honorific: null, name_variants: [] }],
  ]);
  const ent = (o: Partial<PipelineEntity> & { given_name?: string | null; surname?: string | null; honorific?: string | null }) =>
    ({ entity_id: "acc-1", display_name: "José Pérez", ...o }) as PipelineEntity & {
      given_name?: string | null;
    };

  it("picks the unique candidate agreeing on extra fields", () => {
    expect(
      disambiguateByFields(ent({ given_name: "José", honorific: "Don" }), ["uuid-A", "uuid-B"], fields),
    ).toBe("uuid-A");
  });

  it("returns null when both candidates score equally (no forced picks)", () => {
    expect(
      disambiguateByFields(ent({ surname: "Pérez" }), ["uuid-A", "uuid-B"], fields),
    ).toBeNull();
  });

  it("returns null on zero signal", () => {
    expect(disambiguateByFields(ent({}), ["uuid-A", "uuid-B"], fields)).toBeNull();
  });
});

describe("backfill/dump redirect merges", () => {
  const dataset: DumpDataset = {
    entities: new Map(),
    entityMerges: [
      { loser_pk: 875249, winner_pk: 879476, loser_name: "Libertador de Colombia", winner_name: "Simón Bolívar" },
      { loser_pk: 999999, winner_pk: 879476, loser_name: "Ghost", winner_name: "Simón Bolívar" },
    ],
    placeMergeCount: 198,
  };
  const pkToUuid = new Map<number, string>([
    [875249, "uuid-loser"],
    [879476, "uuid-winner"],
  ]);

  it("builds merge rows with production UUIDs on both sides", () => {
    const r = buildRedirectMergeRows(dataset, pkToUuid, "fed");
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row.operation).toBe("merge");
    expect(row.source_id).toBe("uuid-loser");
    expect(row.target_id).toBe("uuid-winner");
    expect(row.detail).toMatchObject({
      origin: "django-manual",
      djangoLoserPk: 875249,
      targetName: "Simón Bolívar",
      reasoning: null,
    });
    expect(row.created_at).toBe(PHASE_13_CREATED_AT_MS);
    expect(row.id).toBe(uuidv5("django-merge:875249:879476"));
  });

  it("reports unresolvable pks instead of guessing", () => {
    const r = buildRedirectMergeRows(dataset, pkToUuid, "fed");
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0].loser_pk).toBe(999999);
  });

  it("counts place merges without building them", () => {
    const r = buildRedirectMergeRows(dataset, pkToUuid, "fed");
    expect(r.placeMergesNotBuilt).toBe(198);
    expect(r.rows.every((x) => x.record_type === "entity")).toBe(true);
  });
});

// Version: v0.4.2
