/**
 * Backfill — Module 2: merge-graph chain walker
 *
 * This module deals with the fact that ~16-20% of merge/split result
 * endpoints were themselves absorbed by a LATER merge before
 * `entities_all.json` was written, so an operation's recorded target is
 * not always a surviving (joinable) entity. It reads the per-pass audit
 * files, normalises their several shapes into one directed edge type
 * (`absorbed_entity_id → target_entity_id`), and resolves any endpoint to
 * its surviving head by walking those edges to a fixed point.
 *
 * The per-pass files disagree on field names — the module owns one
 * adapter per known shape:
 *   - `{absorbed_entity_id, target_entity_id, absorbed_name, target_name}`
 *     (ortho / single-word / gap / near-miss / cross-repo-sonnet)
 *   - `{primary_entity_id, absorbed_entity_id}` (cross_repo_audit and the
 *     `merge_decisions` list inside the two institution summary dicts)
 *   - `{primary_id, absorbed_ids[]}` (abbrev_variant) → one edge each
 *   - `{primary_id, absorbed_id}` (final_variant)
 * `audit_log.json` is the authoritative operation superset, but its MERGE
 * decisions are cluster-level (a surviving head + mention `group_ids`)
 * and carry NO absorbed entity_id — so the entity-to-entity merge edges
 * live only in these per-pass files. That is measured, not assumed: 0 of
 * the ~4,071 absorbed ids appear in `entities_all.json` (all collapsed),
 * while ~89% of targets do (the rest need this walk).
 *
 * `resolveHead` follows `absorbed → target` while the current id is still
 * an absorbed endpoint somewhere in the graph, guarding against cycles.
 * The terminal id is the surviving head the join can resolve to a
 * production UUID. Edge metadata (names, source, reasoning) is retained
 * so the row builder can enrich `detail` without re-reading the files.
 *
 * @version v0.4.2
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { HeadResolution, MergeEdge } from "./types";

/** The per-pass audit files that carry entity-to-entity merge edges. */
const MERGE_AUDIT_FILES = [
  "ortho_variant_merge_audit.json",
  "single_word_merge_audit.json",
  "gap_merge_audit.json",
  "near_miss_undated_audit.json",
  "cross_repo_sonnet_audit.json",
  "cross_repo_audit.json",
  "abbrev_variant_audit.json",
  "final_variant_merge_audit.json",
  "institution_agent_audit.json",
  "institution_cross_repo_audit.json",
] as const;

function edgesFromRecords(records: unknown[], pass: string): MergeEdge[] {
  const edges: MergeEdge[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const source = (r.source as string) ?? null;
    const reasoning =
      (r.reasoning as string) ?? (r.reason as string) ?? null;
    const rule = (r.rule as string) ?? null;

    // Shape A: absorbed_entity_id → target_entity_id.
    if (r.absorbed_entity_id && r.target_entity_id) {
      edges.push({
        absorbed_entity_id: String(r.absorbed_entity_id),
        target_entity_id: String(r.target_entity_id),
        pass,
        absorbed_name: (r.absorbed_name as string) ?? null,
        target_name: (r.target_name as string) ?? null,
        decision_source: source,
        decision_rule: rule,
        reasoning,
      });
      continue;
    }
    // Shape B: primary_entity_id ← absorbed_entity_id.
    if (r.absorbed_entity_id && r.primary_entity_id) {
      edges.push({
        absorbed_entity_id: String(r.absorbed_entity_id),
        target_entity_id: String(r.primary_entity_id),
        pass,
        absorbed_name: (r.absorbed_name as string) ?? null,
        target_name: (r.primary_name as string) ?? null,
        decision_source: source,
        decision_rule: rule,
        reasoning,
      });
      continue;
    }
    // Shape C: primary_id ← absorbed_ids[].
    if (Array.isArray(r.absorbed_ids) && r.primary_id) {
      for (const a of r.absorbed_ids as unknown[]) {
        if (a === null || a === undefined) continue;
        edges.push({
          absorbed_entity_id: String(a),
          target_entity_id: String(r.primary_id),
          pass,
          absorbed_name: null,
          target_name: (r.primary_name as string) ?? null,
          decision_source: source,
          decision_rule: rule,
          reasoning,
        });
      }
      continue;
    }
    // Shape D: primary_id ← absorbed_id.
    if (r.absorbed_id && r.primary_id) {
      edges.push({
        absorbed_entity_id: String(r.absorbed_id),
        target_entity_id: String(r.primary_id),
        pass,
        absorbed_name: (r.absorbed_name as string) ?? null,
        target_name: (r.primary_name as string) ?? null,
        decision_source: source,
        decision_rule: rule,
        reasoning,
      });
    }
  }
  return edges;
}

/**
 * Extract merge edges from a single already-parsed audit file. Handles
 * both list files and the two institution summary dicts (whose edges
 * live under a `merge_decisions` array).
 */
export function extractEdges(parsed: unknown, pass: string): MergeEdge[] {
  if (Array.isArray(parsed)) return edgesFromRecords(parsed, pass);
  if (parsed && typeof parsed === "object") {
    const md = (parsed as Record<string, unknown>).merge_decisions;
    if (Array.isArray(md)) return edgesFromRecords(md, pass);
  }
  return [];
}

/**
 * Read every known per-pass merge audit file from `outputDir` and return
 * the union of merge edges. Missing files are skipped (not every corpus
 * ran every pass).
 */
export function readMergeEdges(outputDir: string): MergeEdge[] {
  const edges: MergeEdge[] = [];
  for (const file of MERGE_AUDIT_FILES) {
    const p = path.join(outputDir, file);
    if (!fs.existsSync(p)) continue;
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    edges.push(...extractEdges(parsed, path.basename(file, ".json")));
  }
  return edges;
}

/**
 * The merge graph: a map from an absorbed endpoint to the edge that
 * folded it into its immediate target. Later duplicate edges for the
 * same absorbed id keep the first seen (deterministic by file order).
 */
export type MergeGraph = Map<string, MergeEdge>;

export function buildMergeGraph(edges: MergeEdge[]): MergeGraph {
  const graph: MergeGraph = new Map();
  for (const e of edges) {
    if (!graph.has(e.absorbed_entity_id)) graph.set(e.absorbed_entity_id, e);
  }
  return graph;
}

/**
 * Walk `id` to its surviving head by following `absorbed → target` edges
 * to a fixed point. Returns the terminal head, the inclusive path, and
 * whether any walk happened. Cycle-guarded: a revisited id stops the
 * walk and returns the last id (the caller then treats it as unresolved
 * if the head is not joinable).
 */
export function resolveHead(id: string, graph: MergeGraph): HeadResolution {
  const path: string[] = [id];
  const seen = new Set<string>([id]);
  let current = id;
  let absorbed = false;
  while (graph.has(current)) {
    const next = graph.get(current)!.target_entity_id;
    if (seen.has(next)) break; // cycle guard
    seen.add(next);
    path.push(next);
    current = next;
    absorbed = true;
  }
  return { head: current, path, absorbed };
}

// Version: v0.4.2
