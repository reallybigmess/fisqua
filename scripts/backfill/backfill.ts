#!/usr/bin/env npx tsx
/**
 * Backfill — CLI orchestrator
 *
 * This script is the entry point for the entity provenance backfill
 * (authorities spec §10). It wires the modules into three subcommands
 * and applies NOTHING to any remote database — local rehearsal only.
 *
 *   generate   content join → dump/fingerprint enrichment → chain walk →
 *              rows (resolve/merge/split/separate) → cluster SEPARATE
 *              reconstruction → Django redirect merges → chunked
 *              idempotent SQL + `mapping.json` + `run-report.json`.
 *              The enrichment steps (integrator pass, 2026-07-10) run
 *              when `--dump-dir` and `--data-dir` are supplied:
 *                - content-ambiguous entities disambiguated by the
 *                  dump's extra fields (`matched_via: "dump"`), then by
 *                  fingerprint;
 *                - content-unmatched entities resolved by the
 *                  description-set fingerprint (`matched_via:
 *                  "fingerprint"`; many-to-one by design — the Django
 *                  ingest consolidated same-institution entities);
 *                - merge-head / split-child ids missing from
 *                  entities_all recovered via intermediate mention-sets
 *                  or unique dump content, the rest classified
 *                  dropped_in_pipeline / no_pipeline_record;
 *                - refuted merges reconstructed from the per-repo
 *                  cluster artifacts into `operation: "separate"` rows;
 *                - the 5 Django entity redirect merges as
 *                  `operation: "merge"` rows with `origin:
 *                  "django-manual"` (the 198 place merges are counted,
 *                  not built — places are a later batch).
 *              BATCH SPLIT (adversarial review 2026-07-10, BLOCK): only
 *              rows whose endpoints are content/dump-resolved become
 *              SQL. Rows touching any fingerprint-contested production
 *              UUID are quarantined to `deferred-fingerprint/` (JSON,
 *              never SQL), and the hardened-recipe survivors go to
 *              `hand-review.json` for human adjudication before any
 *              fingerprint batch exists.
 *
 *   rehearse   Copy the given sqlite to --out/rehearsal.sqlite (the
 *              originals are NEVER touched), apply 0057's CREATE TABLE
 *              to the copy, seed the acting user, apply the generated
 *              SQL, then verify: per-operation row counts, no unresolved
 *              required endpoints, the acc-08032 → acc-00548 merge
 *              spot-check, the clean batch containing NO
 *              fingerprint-dependent row (marker absent, the proven-bad
 *              acc-11603 binding absent, zero contested-UUID touches),
 *              the Simón Bolívar Django redirect merge, and idempotency
 *              (a full second apply inserts 0).
 *
 *   stats      Print the run report written by `generate`.
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill.ts generate --db <sqlite> \
 *     [--out .backfill] [--source <dir>] [--dump-dir <dir>] [--data-dir <dir>]
 *   npx tsx scripts/backfill/backfill.ts rehearse --db <sqlite> [--out .backfill]
 *   npx tsx scripts/backfill/backfill.ts stats [--out .backfill]
 *
 * `--db` is the local production-shaped D1 copy. `--source` is the entity-
 * resolution output directory and `--data-dir` its sibling `data/`
 * directory; both default to the `BACKFILL_SOURCE` and `BACKFILL_DATA_DIR`
 * environment variables so no machine-specific path is baked into the
 * source. `--dump-dir` is the integrator's Django dump verification
 * directory (no default — supplied per run). No `--remote`, ever.
 *
 * @version v0.6.0
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import { BACKFILL_USER_EMAIL } from "./ids";
import { classifyEntities, readProductionEntities } from "./join";
import { buildMergeGraph, readMergeEdges, resolveHead } from "./chains";
import { buildRows, separatePairToRow } from "./rows";
import { partitionRows, writeArtefacts } from "./generate";
import {
  HARDENED_FINGERPRINT,
  fingerprintEntity,
  readFingerprintIndex,
  type FingerprintIndex,
} from "./fingerprint";
import {
  buildDumpContentIndex,
  buildRedirectMergeRows,
  disambiguateByFields,
  dumpContentMatch,
  readDumpDataset,
  type DumpDataset,
} from "./dump";
import {
  SEPARATE_REPOS,
  buildMentionMap,
  emptySeparateStats,
  readRepoArtifacts,
  reconstructSeparatePairs,
} from "./separate";
import { buildEndpointRecoverer, readIntermediateEntities } from "./recover";
import type {
  AuditDecision,
  AuthorityOperationRow,
  Bookkeeping,
  EndpointRecoveryStats,
  HandReviewEntry,
  ManualCandidate,
  MatchedVia,
  PipelineEntity,
  RunReport,
} from "./types";

const DEFAULT_SOURCE = process.env.BACKFILL_SOURCE ?? "";
const DEFAULT_DATA_DIR = process.env.BACKFILL_DATA_DIR ?? "";
const DEFAULT_OUT = ".backfill";

interface Args {
  cmd: string;
  db: string | null;
  out: string;
  source: string;
  dumpDir: string | null;
  dataDir: string;
  federation: string;
}

function parseArgs(argv: string[]): Args {
  const rest = argv.slice(2);
  const cmd = rest[0] ?? "";
  const opts: Record<string, string> = {};
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        opts[a.slice(2)] = rest[i + 1] ?? "";
        i++;
      }
    }
  }
  return {
    cmd,
    db: opts.db ?? null,
    out: opts.out ?? DEFAULT_OUT,
    source: opts.source ?? DEFAULT_SOURCE,
    dumpDir: opts["dump-dir"] ?? null,
    dataDir: opts["data-dir"] ?? DEFAULT_DATA_DIR,
    federation: opts.federation ?? NEOGRANADINA_FEDERATION_ID,
  };
}

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

/** Unordered pipeline-pair key: one separate assertion per pair. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

interface EnrichmentResult {
  via: Map<string, MatchedVia>;
  manualCandidates: ManualCandidate[];
  stillAmbiguous: string[];
  endpointRecovery: EndpointRecoveryStats;
  droppedInPipelineList: string[];
  noPipelineRecordList: string[];
  dump: DumpDataset;
  fpIndex: FingerprintIndex;
  /** Hardened-recipe survivors + rejection tallies for the report. */
  handReview: HandReviewEntry[];
  rejectedByHardening: Record<string, number>;
}

/**
 * The integrator enrichment pass. Mutates `matched` in place (adding
 * fingerprint/dump matches and endpoint aliases) and returns everything
 * the report needs. The heavy lifting lives in fingerprint.ts / dump.ts
 * / recover.ts; this function only sequences them.
 */
function enrich(
  args: Args & { dumpDir: string },
  pipeline: PipelineEntity[],
  decisions: AuditDecision[],
  matched: Map<string, string>,
  contentJoin: ReturnType<typeof classifyEntities>,
  graph: ReturnType<typeof buildMergeGraph>,
  edges: ReturnType<typeof readMergeEdges>,
): EnrichmentResult {
  const byId = new Map(pipeline.map((e) => [e.entity_id, e]));
  const via = new Map<string, MatchedVia>();
  const claimed = new Set(contentJoin.matched.values());

  console.log(`[enrich] building fingerprint index from ${args.db}`);
  const fpIndex = readFingerprintIndex(args.db!);
  console.log(`[enrich] reading dump dataset from ${args.dumpDir}`);
  const dump = readDumpDataset(args.dumpDir);
  const dumpIdx = buildDumpContentIndex(dump.entities);

  // Every lax fingerprint hypothesis is ALSO run through the hardened
  // gates; the survivors land in hand-review.json for human
  // adjudication, the rejections are tallied. Lax matches only ever
  // feed the (deferred) mapping — never row generation.
  const handReview: HandReviewEntry[] = [];
  const rejectedByHardening: Record<string, number> = {};
  const hardenedPass = (ent: PipelineEntity): void => {
    const hard = fingerprintEntity(ent, fpIndex, claimed, HARDENED_FINGERPRINT);
    if (hard.kind === "matched") {
      const f = fpIndex.fields.get(hard.production_id);
      handReview.push({
        pipeline_entity_id: ent.entity_id,
        pipeline_name: ent.display_name,
        pipeline_type: ent.entity_type ?? null,
        pipeline_variants: ent.name_variants ?? [],
        mechanism: "description-set",
        production_id: hard.production_id,
        production_name: f?.display_name ?? null,
        production_type: f?.entity_type ?? null,
        setSize: hard.setSize,
        candidateSetSize: fpIndex.entityDescSets.get(hard.production_id)?.size ?? null,
        overlap: hard.overlap,
        method: hard.method,
        ...(hard.corroboration !== undefined
          ? { corroboration: hard.corroboration }
          : {}),
        tiedCandidates: (hard.tiedWith ?? []).map((c) => ({
          production_id: c,
          display_name: fpIndex.fields.get(c)?.display_name ?? null,
          entity_type: fpIndex.fields.get(c)?.entity_type ?? null,
        })),
      });
    } else {
      const reason = hard.kind === "rejected" ? hard.reason : hard.kind;
      rejectedByHardening[reason] = (rejectedByHardening[reason] ?? 0) + 1;
    }
  };

  // --- Task 2: disambiguate content-ambiguous entities. ---------------
  const stillAmbiguous: string[] = [];
  for (const a of contentJoin.ambiguous) {
    const ent = byId.get(a.pipeline_entity_id);
    if (!ent) {
      stillAmbiguous.push(a.pipeline_entity_id);
      continue;
    }
    const pick = disambiguateByFields(
      ent as PipelineEntity & { given_name?: string | null },
      a.production_ids,
      fpIndex.fields,
    );
    if (pick) {
      matched.set(a.pipeline_entity_id, pick);
      via.set(a.pipeline_entity_id, "dump");
      continue;
    }
    const fp = fingerprintEntity(ent, fpIndex, claimed);
    if (fp.kind === "matched") {
      matched.set(a.pipeline_entity_id, fp.production_id);
      via.set(a.pipeline_entity_id, "fingerprint");
      hardenedPass(ent);
    } else {
      stillAmbiguous.push(a.pipeline_entity_id);
    }
  }

  // --- Task 1: resolve content-unmatched entities. ---------------------
  const manualCandidates: ManualCandidate[] = [];
  for (const u of contentJoin.unmatched) {
    const ent = byId.get(u.pipeline_entity_id);
    if (!ent) continue;
    // Dump content first (the ruling's test). Measured: adds nothing
    // beyond the production join because dump content == production
    // content — run anyway so the classification is tested, not assumed.
    const pks = dumpContentMatch(ent, dumpIdx);
    if (pks.length === 1) {
      const uuid = fpIndex.pkToUuid.get(pks[0]);
      if (uuid) {
        matched.set(u.pipeline_entity_id, uuid);
        via.set(u.pipeline_entity_id, "dump");
        continue;
      }
    }
    const fp = fingerprintEntity(ent, fpIndex, claimed);
    if (fp.kind === "matched") {
      matched.set(u.pipeline_entity_id, fp.production_id);
      via.set(u.pipeline_entity_id, "fingerprint");
      hardenedPass(ent);
    } else if (fp.kind === "tied") {
      manualCandidates.push({
        pipeline_entity_id: u.pipeline_entity_id,
        display_name: ent.display_name,
        entity_type: ent.entity_type ?? null,
        reason: "fingerprint-tied",
        descriptionCount: fp.setSize,
        tiedCandidates: fp.candidates.map((c) => ({
          production_id: c,
          display_name: fpIndex.fields.get(c)?.display_name ?? null,
        })),
      });
    } else {
      manualCandidates.push({
        pipeline_entity_id: u.pipeline_entity_id,
        display_name: ent.display_name,
        entity_type: ent.entity_type ?? null,
        reason:
          fp.kind === "weak" ? "weak-fingerprint" : "no-fingerprint-candidates",
        ...(fp.kind === "weak"
          ? { bestRatio: fp.bestRatio, descriptionCount: fp.setSize }
          : {}),
      });
    }
  }

  // --- Endpoint recovery: heads/children absent from entities_all. -----
  console.log(`[enrich] reading intermediate entities from ${args.dataDir}`);
  const intermediates = readIntermediateEntities(args.dataDir);
  const mentionMap = buildMentionMap(pipeline);
  const recoverer = buildEndpointRecoverer(intermediates, mentionMap, dump.entities);

  const missing = new Set<string>();
  for (const edge of edges) {
    const { head } = resolveHead(edge.target_entity_id, graph);
    if (!byId.has(head) && !matched.has(head)) missing.add(head);
  }
  for (const dec of decisions) {
    if (dec.action !== "TEMPORAL_SPLIT") continue;
    for (const child of dec.entity_ids) {
      const { head } = resolveHead(child, graph);
      if (!byId.has(head) && !matched.has(head)) missing.add(head);
    }
  }

  const endpointRecovery: EndpointRecoveryStats = {
    totalMissingIds: missing.size,
    mentionResolved: 0,
    dumpResolved: 0,
    droppedInPipeline: 0,
    noPipelineRecord: 0,
    ambiguous: 0,
  };
  const droppedInPipelineList: string[] = [];
  const noPipelineRecordList: string[] = [];
  for (const id of [...missing].sort()) {
    const r = recoverer.recover(id);
    if (r.kind === "mention-unique") {
      const prod = matched.get(r.finalId);
      if (prod) {
        matched.set(id, prod);
        via.set(id, "fingerprint");
        endpointRecovery.mentionResolved += 1;
        // Mention-set aliases are fingerprint-family evidence — they too
        // go to hand review rather than straight into row generation.
        const inter = intermediates.get(id);
        const f = fpIndex.fields.get(prod);
        handReview.push({
          pipeline_entity_id: id,
          pipeline_name: inter?.display_name ?? "(no intermediate record)",
          pipeline_type: null,
          pipeline_variants: [],
          mechanism: "mention-set",
          production_id: prod,
          production_name: f?.display_name ?? null,
          production_type: f?.entity_type ?? null,
          setSize: inter?.merge_source_ids?.length ?? 0,
          candidateSetSize: fpIndex.entityDescSets.get(prod)?.size ?? null,
          overlap: inter?.merge_source_ids?.length ?? 0,
          method: `absorbed-into-${r.finalId}`,
          tiedCandidates: [],
        });
      } else {
        endpointRecovery.ambiguous += 1;
      }
    } else if (r.kind === "dump-unique") {
      const uuid = fpIndex.pkToUuid.get(r.productionPk);
      if (uuid) {
        matched.set(id, uuid);
        via.set(id, "dump");
        endpointRecovery.dumpResolved += 1;
      } else {
        endpointRecovery.ambiguous += 1;
      }
    } else if (r.kind === "dropped_in_pipeline") {
      endpointRecovery.droppedInPipeline += 1;
      droppedInPipelineList.push(id);
    } else if (r.kind === "no_pipeline_record") {
      endpointRecovery.noPipelineRecord += 1;
      noPipelineRecordList.push(id);
    } else {
      endpointRecovery.ambiguous += 1;
    }
  }

  return {
    via,
    manualCandidates,
    stillAmbiguous,
    endpointRecovery,
    droppedInPipelineList,
    noPipelineRecordList,
    dump,
    fpIndex,
    handReview,
    rejectedByHardening,
  };
}

async function runGenerate(args: Args): Promise<void> {
  if (!args.db) throw new Error("generate requires --db <local sqlite copy>");
  const entitiesAllPath = path.join(args.source, "entities_all.json");
  const auditLogPath = path.join(args.source, "audit_log.json");

  console.log(`[generate] reading pipeline data from ${args.source}`);
  const pipeline = loadJson<PipelineEntity[]>(entitiesAllPath);
  const decisions = loadJson<AuditDecision[]>(auditLogPath);
  const edges = readMergeEdges(args.source);
  const graph = buildMergeGraph(edges);

  console.log(`[generate] reading production entities from ${args.db}`);
  const production = readProductionEntities(args.db);

  console.log(`[generate] joining ${pipeline.length} pipeline entities …`);
  const contentJoin = classifyEntities(pipeline, production);
  console.log(
    `[generate] content join: matched=${contentJoin.matched.size} ambiguous=${contentJoin.ambiguous.length} unmatched=${contentJoin.unmatched.length}`,
  );

  // Enriched mapping starts from the content join; the enrichment pass
  // (when the dump dataset is supplied) adds fingerprint/dump matches
  // and endpoint aliases in place.
  const matched = new Map(contentJoin.matched);
  let enrichment: EnrichmentResult | null = null;
  if (args.dumpDir) {
    enrichment = enrich(
      args as Args & { dumpDir: string },
      pipeline,
      decisions,
      matched,
      contentJoin,
      graph,
      edges,
    );
    console.log(
      `[generate] enriched: +${matched.size - contentJoin.matched.size} matches ` +
        `(manual=${enrichment.manualCandidates.length} stillAmbiguous=${enrichment.stillAmbiguous.length})`,
    );
  } else {
    console.log(
      "[generate] no --dump-dir: enrichment pass skipped (content join only)",
    );
  }

  const enrichedJoin = {
    matched,
    ambiguous: contentJoin.ambiguous,
    unmatched: contentJoin.unmatched,
  };
  const { rows, skipped } = buildRows({
    federationId: args.federation,
    pipeline,
    decisions,
    edges,
    graph,
    join: enrichedJoin,
    matchedVia: enrichment?.via,
  });
  console.log(`[generate] built ${rows.length} base rows (${skipped.length} skipped)`);

  const allRows: AuthorityOperationRow[] = [...rows];
  let separateStats;
  let redirects;
  if (enrichment) {
    // Cluster-based SEPARATE reconstruction. Seed the dedupe set with
    // the audit-log-built separate pairs so the same refusal cannot
    // land under two PKs.
    separateStats = emptySeparateStats();
    const pairsSeen = new Set<string>();
    for (const r of rows) {
      if (r.operation !== "separate") continue;
      const a = r.detail.pipelineSourceId;
      const b = r.detail.pipelineTargetId;
      if (typeof a === "string" && typeof b === "string") {
        pairsSeen.add(pairKey(a, b));
      }
    }
    const mentionMap = buildMentionMap(pipeline);
    for (const repo of SEPARATE_REPOS) {
      const artifacts = readRepoArtifacts(args.dataDir, repo);
      if (!artifacts) continue;
      const pairs = reconstructSeparatePairs(
        artifacts,
        mentionMap,
        matched,
        pairsSeen,
        separateStats,
      );
      for (const p of pairs) allRows.push(separatePairToRow(p, args.federation));
    }
    console.log(
      `[generate] separate reconstruction: ${separateStats.uniquePairs} pairs from ` +
        `${separateStats.decisionsYieldingRows}/${separateStats.decisionsTotal} decisions`,
    );

    // Django redirect merges (entity side only; places are a later batch).
    const redirect = buildRedirectMergeRows(
      enrichment.dump,
      enrichment.fpIndex.pkToUuid,
      args.federation,
    );
    allRows.push(...redirect.rows);
    redirects = {
      entityRowsBuilt: redirect.rows.length,
      placeMergesNotBuilt: redirect.placeMergesNotBuilt,
    };
    if (redirect.unresolved.length > 0) {
      console.log(
        `[generate] WARNING: ${redirect.unresolved.length} redirect merges did not resolve pk→UUID`,
      );
    }
    console.log(
      `[generate] redirects: ${redirect.rows.length} entity merge rows; ` +
        `${redirect.placeMergesNotBuilt} place merges left for the places batch`,
    );
  }

  // BATCH SPLIT (adversarial review): quarantine every row that touches
  // a production UUID contested by a fingerprint hypothesis. Only the
  // clean (content/dump-resolved) rows become SQL.
  let emitRows = allRows;
  let deferredRows: AuthorityOperationRow[] | undefined;
  let contested: Set<string> | undefined;
  let bookkeeping: Bookkeeping | undefined;
  let notes: string[] | undefined;
  if (enrichment) {
    contested = new Set<string>();
    for (const [pid, v] of enrichment.via) {
      if (v !== "fingerprint") continue;
      const prod = matched.get(pid);
      if (prod) contested.add(prod);
    }
    const split = partitionRows(allRows, contested);
    emitRows = split.clean;
    deferredRows = split.deferred;
    console.log(
      `[generate] batch split: ${split.clean.length} clean rows emitted, ` +
        `${split.deferred.length} fingerprint-contested rows deferred ` +
        `(${contested.size} contested production ids)`,
    );

    // Bookkeeping corrections (amendment 3): pre/post ambiguity stated
    // side by side, and multi-lineage collapses recounted over the
    // NON-fingerprint (content+dump) mapping only.
    const byProd = new Map<string, string[]>();
    for (const [pid, prod] of matched) {
      if (enrichment.via.get(pid) === "fingerprint") continue;
      const bucket = byProd.get(prod);
      if (bucket) bucket.push(pid);
      else byProd.set(prod, [pid]);
    }
    const multi = [...byProd.entries()]
      .filter(([, pids]) => pids.length > 1)
      .map(([production_id, pipeline_entity_ids]) => ({
        production_id,
        pipeline_entity_ids: pipeline_entity_ids.sort(),
      }))
      .sort((x, y) => x.production_id.localeCompare(y.production_id));
    bookkeeping = {
      ambiguousPreFingerprint: contentJoin.ambiguous.length,
      ambiguousPostFingerprint: enrichment.stillAmbiguous.length,
      multiLineageContentDump: {
        productionIds: multi.length,
        pipelineIds: multi.reduce((n, m) => n + m.pipeline_entity_ids.length, 0),
        list: multi,
      },
    };
    notes = [
      "The −200 pipeline-vs-production delta is UNRESOLVED pending fingerprint adjudication: " +
        `${contentJoin.unmatched.length} content-unmatched + ${contentJoin.ambiguous.length} content-ambiguous ` +
        "pipeline entities stand against the unclaimed production rows. The deferred fingerprint hypotheses " +
        "suggest Django-ingest consolidation (many-to-one), but no generated row asserts it.",
      "created_at is the single documented Phase-13 constant for every row: the audit files carry no " +
        "timestamps of any kind, so §10's 'pipeline pass date where recoverable' clause is moot.",
    ];
  }

  const report = await writeArtefacts({
    rows: emitRows,
    join: enrichedJoin,
    contentJoin,
    skipped,
    outDir: args.out,
    entitiesAllPath,
    auditLogPath,
    productionDb: args.db,
    dumpDir: args.dumpDir,
    dataDir: enrichment ? args.dataDir : null,
    statementsPerFile: 20,
    matchedVia: enrichment?.via,
    separateReconstruction: separateStats,
    endpointRecovery: enrichment?.endpointRecovery,
    redirects,
    manualCandidates: enrichment?.manualCandidates,
    stillAmbiguous: enrichment?.stillAmbiguous,
    droppedInPipelineList: enrichment?.droppedInPipelineList,
    noPipelineRecordList: enrichment?.noPipelineRecordList,
    deferredRows,
    contestedProductionIds: contested,
    handReview: enrichment
      ? {
          entries: enrichment.handReview,
          rejectedByHardening: enrichment.rejectedByHardening,
        }
      : undefined,
    bookkeeping,
    notes,
  });
  printReport(report);
  console.log(`[generate] artefacts written to ${path.resolve(args.out)}`);
}

function printReport(r: RunReport): void {
  console.log("---------------------------------------------");
  console.log("Run report");
  console.log(
    `  join      total=${r.join.total} matched=${r.join.matched} ambiguous=${r.join.ambiguous} unmatched=${r.join.unmatched}`,
  );
  if (r.matchedVia) {
    console.log(
      `  mapping   content=${r.matchedVia.content} fingerprint=${r.matchedVia.fingerprint} dump=${r.matchedVia.dump} manual=${r.matchedVia.manual}`,
    );
  }
  console.log(
    `  rows      resolve=${r.rowCounts.resolve} merge=${r.rowCounts.merge} split=${r.rowCounts.split} separate=${r.rowCounts.separate}`,
  );
  if (r.originCounts) {
    console.log(
      `  origins   ${Object.entries(r.originCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    );
  }
  console.log(
    `  skipped   merge=${r.skipped.merge} split=${r.skipped.split} separate=${r.skipped.separate} resolve=${r.skipped.resolve}`,
  );
  if (r.separateReconstruction) {
    const s = r.separateReconstruction;
    console.log(
      `  sep-recon decisions=${s.decisionsTotal} yielded=${s.decisionsYieldingRows} pairs=${s.uniquePairs} ` +
        `unresolvable=${s.groupsUnresolvable} noCounterpart=${s.noCounterpart} notJoinable=${s.pairsNotJoinable}`,
    );
  }
  if (r.endpointRecovery) {
    const e = r.endpointRecovery;
    console.log(
      `  endpoints missing=${e.totalMissingIds} mentionResolved=${e.mentionResolved} dumpResolved=${e.dumpResolved} ` +
        `dropped=${e.droppedInPipeline} noRecord=${e.noPipelineRecord} ambiguous=${e.ambiguous}`,
    );
  }
  if (r.redirects) {
    console.log(
      `  redirects entityRows=${r.redirects.entityRowsBuilt} placesDeferred=${r.redirects.placeMergesNotBuilt}`,
    );
  }
  if (r.deferredFingerprint) {
    const d = r.deferredFingerprint;
    console.log(
      `  deferred  total=${d.total} (resolve=${d.rowCounts.resolve} merge=${d.rowCounts.merge} ` +
        `split=${d.rowCounts.split} separate=${d.rowCounts.separate}) ` +
        `contestedIds=${d.contestedProductionIds} mappingEntries=${d.mappingEntries}`,
    );
  }
  if (r.handReview) {
    console.log(
      `  handRev   survivors=${r.handReview.count} rejected=${JSON.stringify(r.handReview.rejectedByHardening)}`,
    );
  }
  if (r.bookkeeping) {
    const b = r.bookkeeping;
    console.log(
      `  bookkeep  ambiguous pre=${b.ambiguousPreFingerprint} post=${b.ambiguousPostFingerprint} ` +
        `multiLineage(content+dump)=${b.multiLineageContentDump.productionIds} prod ids / ${b.multiLineageContentDump.pipelineIds} pipeline ids`,
    );
  }
  if (r.manualCandidates || r.stillAmbiguous) {
    console.log(
      `  residual  manual=${r.manualCandidates?.length ?? 0} stillAmbiguous=${r.stillAmbiguous?.length ?? 0} ` +
        `dropped=${r.droppedInPipelineList?.length ?? 0} noRecord=${r.noPipelineRecordList?.length ?? 0}`,
    );
  }
  console.log(
    `  sql       files=${r.sqlFiles.length} totalRows=${r.totalRows} totalBytes=${r.totalBytes} (${(r.totalBytes / 1e6).toFixed(1)} MB)`,
  );
  console.log(`  createdAt ${r.createdAtConstantMs} (Phase-13 constant)`);
  console.log("---------------------------------------------");
}

async function runRehearse(args: Args): Promise<void> {
  if (!args.db) throw new Error("rehearse requires --db <local sqlite copy>");
  const reportPath = path.join(args.out, "run-report.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`No run-report.json in ${args.out}; run 'generate' first.`);
  }
  const report = loadJson<RunReport>(reportPath);

  // Work on a COPY — never the operator's original.
  const rehearsalDb = path.join(args.out, "rehearsal.sqlite");
  await fsp.copyFile(args.db, rehearsalDb);
  console.log(`[rehearse] copied ${args.db} → ${rehearsalDb}`);

  const db = new DatabaseSync(rehearsalDb);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    // Apply 0057's CREATE TABLE/INDEX/TRIGGER to the copy.
    const migration = fs.readFileSync(
      path.resolve("drizzle/0057_authority_operations.sql"),
      "utf8",
    );
    db.exec(migration);

    // Seed the acting user so the CROSS JOIN resolves during rehearsal.
    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(BACKFILL_USER_EMAIL) as { id: string } | undefined;
    if (!existing) {
      // FK enforcement is off for the rehearsal copy, but users.tenant_id
      // is NOT NULL — a placeholder value satisfies the column constraint.
      db.exec(
        `INSERT INTO users (id, tenant_id, email, name, is_admin, is_super_admin, ` +
          `is_collab_admin, is_archive_user, is_user_manager, is_cataloguer, ` +
          `created_at, updated_at) VALUES ('backfill-rehearsal-user', ` +
          `'rehearsal-tenant', '${BACKFILL_USER_EMAIL}', 'Rehearsal', 0, 0, 0, 0, 0, 0, 0, 0);`,
      );
      console.log(`[rehearse] seeded ${BACKFILL_USER_EMAIL}`);
    }

    // Apply every generated SQL file.
    const applyAll = (): void => {
      for (const f of report.sqlFiles) {
        const sql = fs.readFileSync(path.join(args.out, f.file), "utf8");
        db.exec(sql);
      }
    };
    applyAll();

    // ---- Verification -------------------------------------------------
    const failures: string[] = [];
    const countAll = (): number =>
      (
        db.prepare("SELECT count(*) c FROM authority_operations").get() as {
          c: number;
        }
      ).c;
    const total = countAll();
    if (total !== report.totalRows) {
      failures.push(`total rows ${total} != expected ${report.totalRows}`);
    }
    for (const op of ["resolve", "merge", "split", "separate"] as const) {
      const c = (
        db
          .prepare("SELECT count(*) c FROM authority_operations WHERE operation = ?")
          .get(op) as { c: number }
      ).c;
      if (c !== report.rowCounts[op]) {
        failures.push(`${op} count ${c} != expected ${report.rowCounts[op]}`);
      }
    }
    // Required endpoints: resolve has NULL target; the rest have non-null.
    const badResolve = (
      db
        .prepare(
          "SELECT count(*) c FROM authority_operations WHERE operation='resolve' AND target_id IS NOT NULL",
        )
        .get() as { c: number }
    ).c;
    const badOther = (
      db
        .prepare(
          "SELECT count(*) c FROM authority_operations WHERE operation IN ('merge','split','separate') AND (target_id IS NULL OR source_id IS NULL OR source_id='' OR target_id='')",
        )
        .get() as { c: number }
    ).c;
    if (badResolve > 0) failures.push(`${badResolve} resolve rows have a target_id`);
    if (badOther > 0) failures.push(`${badOther} merge/split/separate rows have an unresolved endpoint`);

    // Spot-check 1: acc-08032 → acc-00548 merge with reasoning.
    const spot = db
      .prepare(
        "SELECT source_id, detail FROM authority_operations WHERE operation='merge' AND source_id = 'acc-08032'",
      )
      .all() as Array<{ source_id: string; detail: string }>;
    if (spot.length === 0) {
      failures.push("spot-check acc-08032 merge row missing");
    } else {
      const d = JSON.parse(spot[0].detail) as Record<string, unknown>;
      if (d.pipelineTargetId !== "acc-00548") {
        failures.push(
          `spot-check target ${String(d.pipelineTargetId)} != acc-00548`,
        );
      }
      if (!d.reasoning && !d.decisionSource) {
        failures.push("spot-check merge row carries no reasoning/source");
      }
    }

    // Spot-check 2 (enriched runs): the clean batch contains NO
    // fingerprint-dependent row. Three angles: (a) no row carries a
    // fingerprint matchedVia marker; (b) the reviewer's proven-bad
    // binding acc-11603 ("Junta Subalterna de Diezmos del Citará" →
    // person "Antonio Garrido") generates no row at all; (c) no row
    // touches any production UUID contested by a deferred mapping
    // hypothesis.
    if (report.deferredFingerprint) {
      const fpMarked = (
        db
          .prepare(
            `SELECT count(*) c FROM authority_operations WHERE detail LIKE '%"matchedVia":"fingerprint"%'`,
          )
          .get() as { c: number }
      ).c;
      if (fpMarked > 0) {
        failures.push(`${fpMarked} rows carry matchedVia=fingerprint in the clean batch`);
      }
      const knownBad = (
        db
          .prepare(
            `SELECT count(*) c FROM authority_operations WHERE detail LIKE '%acc-11603%'`,
          )
          .get() as { c: number }
      ).c;
      if (knownBad > 0) {
        failures.push(`known-bad binding acc-11603 generated ${knownBad} rows`);
      }
      const mapping = loadJson<Array<{ production_id: string; deferred?: boolean }>>(
        path.join(args.out, "mapping.json"),
      );
      db.exec("CREATE TEMP TABLE contested_ids (id TEXT PRIMARY KEY)");
      const ins = db.prepare("INSERT OR IGNORE INTO contested_ids (id) VALUES (?)");
      for (const m of mapping) {
        if (m.deferred) ins.run(m.production_id);
      }
      const touching = (
        db
          .prepare(
            `SELECT count(*) c FROM authority_operations ao WHERE EXISTS (SELECT 1 FROM contested_ids t WHERE t.id = ao.source_id OR t.id = ao.target_id)`,
          )
          .get() as { c: number }
      ).c;
      if (touching > 0) {
        failures.push(`${touching} rows touch fingerprint-contested production UUIDs`);
      }
    }

    // Spot-check 3 (enriched runs): the Simón Bolívar Django redirect
    // merge, endpoints = the production UUIDs of pks 875249 / 879476.
    if ((report.redirects?.entityRowsBuilt ?? 0) > 0) {
      const bol = db
        .prepare(
          `SELECT source_id, target_id, detail FROM authority_operations WHERE operation='merge' AND detail LIKE '%"djangoLoserPk":875249%'`,
        )
        .get() as { source_id: string; target_id: string; detail: string } | undefined;
      if (!bol) {
        failures.push("spot-check Simón Bolívar redirect merge row missing");
      } else {
        const d = JSON.parse(bol.detail) as Record<string, unknown>;
        if (d.origin !== "django-manual" || d.targetName !== "Simón Bolívar") {
          failures.push("spot-check Bolívar row origin/name mismatch");
        }
        const loser = db
          .prepare(`SELECT id FROM entities WHERE legacy_ids LIKE '%"id":875249%'`)
          .get() as { id: string } | undefined;
        const winner = db
          .prepare(`SELECT id FROM entities WHERE legacy_ids LIKE '%"id":879476%'`)
          .get() as { id: string } | undefined;
        if (loser?.id !== bol.source_id || winner?.id !== bol.target_id) {
          failures.push("spot-check Bolívar endpoints do not match legacy pk lookup");
        }
      }
    }

    // Idempotency: a full second apply must insert nothing.
    applyAll();
    const totalAfterReapply = countAll();
    if (totalAfterReapply !== total) {
      failures.push(
        `idempotency: second apply changed row count ${total} → ${totalAfterReapply}`,
      );
    }

    console.log("---------------------------------------------");
    console.log(`[rehearse] applied ${report.sqlFiles.length} SQL files (twice)`);
    console.log(`[rehearse] authority_operations rows: ${total}`);
    if (failures.length === 0) {
      console.log("[rehearse] VERIFICATION PASSED");
      console.log("  spot-check: acc-08032 → acc-00548 merge with reasoning");
      if (report.deferredFingerprint) {
        console.log(
          "  spot-check: clean batch is fingerprint-free (no matchedVia marker, acc-11603 absent, 0 contested-UUID touches)",
        );
      }
      if ((report.redirects?.entityRowsBuilt ?? 0) > 0) {
        console.log("  spot-check: Simón Bolívar django-manual merge present");
      }
      console.log("  idempotency: second apply inserted 0 rows");
    } else {
      console.log("[rehearse] VERIFICATION FAILED:");
      for (const f of failures) console.log(`  - ${f}`);
    }
    console.log("---------------------------------------------");
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function runStats(args: Args): void {
  const reportPath = path.join(args.out, "run-report.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`No run-report.json in ${args.out}; run 'generate' first.`);
  }
  printReport(loadJson<RunReport>(reportPath));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.cmd) {
    case "generate":
      await runGenerate(args);
      break;
    case "rehearse":
      await runRehearse(args);
      break;
    case "stats":
      runStats(args);
      break;
    default:
      console.log(
        "Usage: backfill.ts <generate|rehearse|stats> --db <sqlite> [--out .backfill] [--source <dir>] [--dump-dir <dir>] [--data-dir <dir>]",
      );
      process.exitCode = args.cmd ? 1 : 0;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}

// Version: v0.4.2
