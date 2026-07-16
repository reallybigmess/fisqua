/**
 * Backfill — shared shapes
 *
 * This module deals with the TypeScript contracts the four backfill
 * modules pass between them: the pipeline entity as read from
 * `entities_all.json`, the audit-log decision as read from
 * `audit_log.json`, the resolved merge-graph edge the chain walker
 * emits, the pre-SQL `authority_operations` row the row builder emits,
 * and the machine-readable run report the generator writes alongside the
 * SQL. Kept dependency-free (no zod, no wrangler) so the whole backfill
 * runs under the Node vitest pool that already hosts the `scripts/` tests
 * (`vitest.import.config.ts`).
 *
 * `matched_via` on the mapping entries is the seam the integrator fills:
 * this pass only ever writes `"content"`; the fingerprint fallback, the
 * B2 Django-dump verification, and manual resolution are out of scope
 * here (a parallel agent prepares the dump dataset), so the union is
 * declared wide but only one arm is produced.
 *
 * @version v0.4.2
 */

/** One entity as it appears in `entities_all.json`. */
export interface PipelineEntity {
  entity_id: string;
  repo?: string;
  display_name: string;
  entity_type?: string | null;
  name_variants?: string[] | null;
  date_earliest?: number | null;
  date_latest?: number | null;
  decision_source?: string | null;
  decision_rule?: string | null;
  decision_reasoning?: string | null;
  merge_source_ids?: number[] | null;
  mention_dates?: Array<{ mention_index?: number; description_id?: number; date?: string | null }> | null;
}

/** One decision as it appears in `audit_log.json`. */
export interface AuditDecision {
  decision_id: string;
  repo: string;
  cluster_id: string;
  action: "MERGE" | "TEMPORAL_SPLIT" | "SEPARATE" | "SINGLETON" | "PARTIAL";
  source: string | null;
  rule: string | null;
  group_ids: string[];
  entity_ids: string[];
  reasoning: string | null;
}

/** A production entity row read from the D1-shaped sqlite copy. */
export interface ProductionEntity {
  id: string;
  display_name: string;
  date_start: string | null;
  date_end: string | null;
}

/** How a pipeline entity_id maps to a production UUID. */
export type MatchedVia = "content" | "fingerprint" | "dump" | "manual";

export interface MappingEntry {
  pipeline_entity_id: string;
  production_id: string;
  matched_via: MatchedVia;
  /**
   * Fingerprint entries are hypotheses pending hand review, not
   * resolutions (adversarial review 2026-07-10, verdict BLOCK). No row
   * generation consumes a deferred entry.
   */
  deferred?: boolean;
}

/** Result of the content join (Module 1). */
export interface JoinResult {
  /** pipeline entity_id → production UUID, for 1:1 content matches only. */
  matched: Map<string, string>;
  /** pipeline entity_ids that hit >1 production row (unresolvable here). */
  ambiguous: Array<{
    pipeline_entity_id: string;
    display_name: string;
    year_start: string | null;
    year_end: string | null;
    production_ids: string[];
  }>;
  /** pipeline entity_ids with no production row. */
  unmatched: Array<{
    pipeline_entity_id: string;
    display_name: string;
    year_start: string | null;
    year_end: string | null;
  }>;
}

/** One directed edge of the merge graph: `absorbed` folded into `target`. */
export interface MergeEdge {
  absorbed_entity_id: string;
  target_entity_id: string;
  pass: string;
  absorbed_name: string | null;
  target_name: string | null;
  decision_source: string | null;
  decision_rule: string | null;
  reasoning: string | null;
}

/** Outcome of walking an endpoint to its surviving head. */
export interface HeadResolution {
  head: string;
  /** ids visited from the start endpoint to the head, inclusive. */
  path: string[];
  /** true when the start endpoint was itself absorbed (walked at least once). */
  absorbed: boolean;
}

export type Operation = "merge" | "split" | "separate" | "resolve";

/** A pre-SQL `authority_operations` row (values still un-escaped). */
export interface AuthorityOperationRow {
  id: string;
  federation_id: string;
  record_type: "entity" | "place" | "vocabulary_term";
  operation: Operation;
  /** production UUID or pipeline id, per operation (see rows.ts header). */
  source_id: string;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: number;
}

/** A decision that could not become a row, kept for the integrator. */
export interface SkippedDecision {
  kind: "merge" | "split" | "separate" | "resolve";
  reason: string;
  identifier: string;
  detail?: Record<string, unknown>;
}

/** One entity the integrator must resolve by hand, with full context. */
export interface ManualCandidate {
  pipeline_entity_id: string;
  display_name: string | null;
  entity_type: string | null;
  reason: string;
  bestRatio?: number;
  descriptionCount?: number;
  tiedCandidates?: Array<{ production_id: string; display_name: string | null }>;
}

/** Outcome counters for the cluster-based SEPARATE reconstruction. */
export interface SeparateStats {
  decisionsTotal: number;
  decisionsYieldingRows: number;
  clusterMissing: number;
  badGroupRef: number;
  groupsUnresolvable: number;
  noCounterpart: number;
  pairsNotJoinable: number;
  uniquePairs: number;
}

/** Outcome counters for operation-endpoint recovery (ids absent from entities_all). */
export interface EndpointRecoveryStats {
  totalMissingIds: number;
  mentionResolved: number;
  dumpResolved: number;
  droppedInPipeline: number;
  noPipelineRecord: number;
  ambiguous: number;
}

/** One hardened-fingerprint survivor awaiting human adjudication. */
export interface HandReviewEntry {
  pipeline_entity_id: string;
  pipeline_name: string;
  pipeline_type: string | null;
  pipeline_variants: string[];
  mechanism: "description-set" | "mention-set" | "dump-content";
  production_id: string;
  production_name: string | null;
  production_type: string | null;
  setSize: number;
  candidateSetSize: number | null;
  overlap: number;
  method: string;
  corroboration?: number;
  tiedCandidates: Array<{
    production_id: string;
    display_name: string | null;
    entity_type: string | null;
  }>;
}

/** Deferred-fingerprint accounting (rows quarantined from the clean batch). */
export interface DeferredFingerprint {
  rowCounts: Record<Operation, number>;
  total: number;
  /** Production UUIDs contested by at least one fingerprint hypothesis. */
  contestedProductionIds: number;
  mappingEntries: number;
}

/** Post-review bookkeeping corrections (amendment 3). */
export interface Bookkeeping {
  ambiguousPreFingerprint: number;
  ambiguousPostFingerprint: number;
  /** Multi-lineage collapses among CONTENT+DUMP entries only. */
  multiLineageContentDump: {
    productionIds: number;
    pipelineIds: number;
    list: Array<{ production_id: string; pipeline_entity_ids: string[] }>;
  };
}

/** The machine-readable run report (Module 4). */
export interface RunReport {
  generatedFrom: {
    entitiesAll: string;
    auditLog: string;
    productionDb: string | null;
    dumpDir?: string | null;
    dataDir?: string | null;
  };
  createdAtConstantMs: number;
  join: {
    total: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
  };
  matchedVia?: Record<MatchedVia, number>;
  rowCounts: Record<Operation, number>;
  originCounts?: Record<string, number>;
  skipped: {
    merge: number;
    split: number;
    separate: number;
    resolve: number;
  };
  separateReconstruction?: SeparateStats;
  endpointRecovery?: EndpointRecoveryStats;
  redirects?: { entityRowsBuilt: number; placeMergesNotBuilt: number };
  deferredFingerprint?: DeferredFingerprint;
  handReview?: {
    file: string;
    count: number;
    rejectedByHardening: Record<string, number>;
  };
  bookkeeping?: Bookkeeping;
  notes?: string[];
  sqlFiles: Array<{ file: string; bytes: number; statements: number }>;
  totalRows: number;
  totalBytes: number;
  ambiguousList: JoinResult["ambiguous"];
  unmatchedList: JoinResult["unmatched"];
  manualCandidates?: ManualCandidate[];
  stillAmbiguous?: string[];
  droppedInPipelineList?: string[];
  noPipelineRecordList?: string[];
  skippedList: SkippedDecision[];
}

// Version: v0.4.2
