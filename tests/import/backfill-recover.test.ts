/**
 * Tests — backfill endpoint recovery
 *
 * Pins the classification of operation-endpoint ids absent from
 * entities_all: mention-set resolution to a unique surviving entity,
 * unique-dump-content fallback, and the two honest terminal classes
 * (`dropped_in_pipeline` when the intermediate record's mentions map to
 * no survivor and no dump row matches; `no_pipeline_record` when no
 * artifact carries the id at all). Ambiguity is returned, not resolved.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import {
  buildEndpointRecoverer,
  type IntermediateEntity,
} from "../../scripts/backfill/recover";
import { buildMentionMap } from "../../scripts/backfill/separate";
import type { DumpEntity } from "../../scripts/backfill/dump";
import type { PipelineEntity } from "../../scripts/backfill/types";

const pipeline: PipelineEntity[] = [
  { entity_id: "acc-10", repo: "acc", display_name: "Survivor", merge_source_ids: [1, 2, 3] },
  { entity_id: "acc-20", repo: "acc", display_name: "Other", merge_source_ids: [4] },
];
const mentionMap = buildMentionMap(pipeline);

const intermediates = new Map<string, IntermediateEntity>([
  ["acc-90", { entity_id: "acc-90", repo: "acc", display_name: "Absorbed", merge_source_ids: [2, 3] }],
  ["acc-91", { entity_id: "acc-91", repo: "acc", display_name: "Dropped", date_earliest: 1600, date_latest: 1601, merge_source_ids: [99] }],
  ["acc-92", { entity_id: "acc-92", repo: "acc", display_name: "Straddler", merge_source_ids: [1, 4] }],
  ["acc-93", { entity_id: "acc-93", repo: "acc", display_name: "Dump Hit", date_earliest: 1700, date_latest: 1710, merge_source_ids: [98] }],
]);

const dumpEntities = new Map<number, DumpEntity>([
  [
    500,
    {
      display_name: "Dump Hit",
      date_start: "1700-01-01",
      date_end: "1710-12-31",
      name_variants: [],
      given_name: null,
      surname: null,
      honorific: null,
      entity_type: "person",
    },
  ],
]);

const recoverer = buildEndpointRecoverer(intermediates, mentionMap, dumpEntities);

describe("backfill/recover", () => {
  it("resolves an absorbed id whose mentions live in one survivor", () => {
    expect(recoverer.recover("acc-90")).toEqual({ kind: "mention-unique", finalId: "acc-10" });
  });

  it("classifies a quality-phase drop as dropped_in_pipeline", () => {
    expect(recoverer.recover("acc-91")).toEqual({ kind: "dropped_in_pipeline" });
  });

  it("returns ambiguous when mentions straddle two survivors", () => {
    const r = recoverer.recover("acc-92");
    expect(r).toEqual({ kind: "ambiguous", finalIds: ["acc-10", "acc-20"] });
  });

  it("falls back to a unique dump content match", () => {
    expect(recoverer.recover("acc-93")).toEqual({ kind: "dump-unique", productionPk: 500 });
  });

  it("classifies an id absent from every artifact as no_pipeline_record", () => {
    expect(recoverer.recover("acc-99999")).toEqual({ kind: "no_pipeline_record" });
  });
});

// Version: v0.4.2
