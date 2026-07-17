/**
 * Stewardship journal + run-envelope write helpers
 *
 * This module owns the atomic write path into the stewardship record
 * (stewardship record spec §§2–3): the `changelog` journal rows that
 * make bulk operations reversible, and the `stewardship_runs` commit
 * envelope that carries the required operator message.
 *
 * ## Returns batch items, not promises — the ledger discipline
 *
 * `composeJournalEntry` and `composeRunInsert` return un-awaited
 * Drizzle insert builders (`BatchItem<"sqlite">`), mirroring
 * `logAuthorityOperation` in `authority-operations.server.ts`. The
 * caller does its reads first, computes the diff payload, then
 * submits `db.batch([...mutationStatements, journalRow])` so the
 * effect and its journal row commit together or not at all. This is
 * the ledger discipline, NOT the older `createChangelogEntry`
 * non-atomic pattern (a separate awaited insert) — that pattern is
 * fine for a forensic trail but not for a journal a revert depends
 * on (spec §3).
 *
 * ## Per-kind diff contract (spec §3 — constraints, not history)
 *
 * The `changelog.diff` column is TEXT holding JSON. Its shape is
 * fixed per `kind`, and callers MUST honour it because the revert
 * executor reads these rows as before-images:
 *
 *   - create: full new-row snapshot as `{ field: { old: null, new } }`.
 *             Revert deletes the row (its before-image is non-existence).
 *             Shape from `createSnapshotDiff`.
 *   - update: the ordinary computed diff `{ field: { old, new } }`,
 *             changed fields only. Revert writes the `old` values back.
 *             Shape from `computeDiff` (re-exported here — do NOT
 *             recompute it).
 *   - delete: full pre-image snapshot as `{ field: { old, new: null } }`.
 *             Revert re-inserts the row. Shape from `deleteSnapshotDiff`.
 *   - link:   the junction row's content (linked id, role, role_note,
 *             sequence, …). Revert deletes the junction row. Shape from
 *             `linkDiff`.
 *   - unlink: the removed junction row's full content. Revert re-inserts
 *             the junction row. Shape from `unlinkDiff`.
 *
 * create/update/delete carry PER-FIELD `{ old, new }` maps; link/unlink
 * carry the junction row content directly (the whole row is the unit,
 * so there is no per-field envelope). Both are JSON-serialised onto the
 * TEXT column verbatim.
 *
 * ## Helper owns the id and the clock
 *
 * `id` is a fresh `crypto.randomUUID()`; `createdAt` defaults to
 * `Date.now()` (epoch ms) unless the caller injects `now`. For a
 * run-journaled write, the revert conflict test compares the target
 * row's `updated_at` against the journal row's `created_at`, so the
 * caller should pass one shared `now` to the mutation and its journal
 * row.
 *
 * ## Immutability
 *
 * `changelog` rows are append-only at the DB level (migration 0063
 * `RAISE(ABORT)` triggers): no code path may UPDATE or DELETE a
 * journal row. `stewardship_runs` rows are minted once; only the
 * lifecycle/linkage columns are ever mutated (by the Workflow and the
 * revert stamp), and only through dedicated update paths — never here.
 *
 * @version v0.6.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BatchItem } from "drizzle-orm/batch";
import { changelog, stewardshipRuns } from "../db/schema";

// Re-export the update-diff computer so callers have a single import
// surface for journal composition. The implementation stays in
// changelog.server.ts — this is a re-export, NOT a duplicate (spec §3:
// an import's updates write the same computed diff a hand edit does).
export { computeDiff } from "./changelog.server";

/** The five journal effect kinds (changelog.kind CHECK enum). */
export type JournalKind = "create" | "update" | "delete" | "link" | "unlink";

/**
 * A JSON-serialisable diff payload. The concrete shape depends on
 * `kind` — see the per-kind diff contract in the module header. Typed
 * loosely here because create/update/delete are per-field `{ old, new }`
 * maps while link/unlink are the junction row's content.
 */
export type JournalDiff = Record<string, unknown>;

export interface JournalEntryParams {
  /** The affected record's id (a description, entity, place, junction row, …). */
  recordId: string;
  /** The record type label, as the changelog uses today (e.g. "description"). */
  recordType: string;
  /** The acting user — the hand editor, or the run's author for a run write. */
  userId: string;
  /** The effect discriminator; selects the diff contract (module header). */
  kind: JournalKind;
  /** Already-shaped per-kind diff payload (use the shapers / `computeDiff`). */
  diff: JournalDiff;
  /** Optional free-text note (the per-row commit note, if any). */
  note?: string | null;
  /**
   * The stewardship run that caused this row, or NULL/undefined for an
   * ordinary hand edit (spec §3).
   */
  runId?: string | null;
  /** Clock override (epoch ms). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Build the journal insert for one record effect. Returns the
 * un-awaited insert builder to embed in the caller's
 * `db.batch([...])` alongside the mutation it records — see the module
 * header. The caller is responsible for shaping `diff` to the per-kind
 * contract; this helper only serialises and stamps id + clock.
 */
export function composeJournalEntry(
  db: DrizzleD1Database<any>,
  params: JournalEntryParams,
): BatchItem<"sqlite"> {
  return db.insert(changelog).values({
    id: crypto.randomUUID(),
    recordId: params.recordId,
    recordType: params.recordType,
    userId: params.userId,
    note: params.note ?? null,
    diff: JSON.stringify(params.diff),
    runId: params.runId ?? null,
    kind: params.kind,
    createdAt: params.now ?? Date.now(),
  });
}

/**
 * Shape a `create` diff: the full new-row snapshot as
 * `{ field: { old: null, new: value } }` for every field of `row`.
 * The before-image is non-existence, so every `old` is null — a
 * revert of a create deletes the row.
 */
export function createSnapshotDiff(
  row: Record<string, unknown>,
): Record<string, { old: null; new: unknown }> {
  const diff: Record<string, { old: null; new: unknown }> = {};
  for (const key of Object.keys(row)) {
    diff[key] = { old: null, new: row[key] };
  }
  return diff;
}

/**
 * Shape a `delete` diff: the full pre-image snapshot as
 * `{ field: { old: value, new: null } }` for every field of `row`.
 * The after-image is non-existence, so every `new` is null — a revert
 * of a delete re-inserts the row from the captured `old` values.
 */
export function deleteSnapshotDiff(
  row: Record<string, unknown>,
): Record<string, { old: unknown; new: null }> {
  const diff: Record<string, { old: unknown; new: null }> = {};
  for (const key of Object.keys(row)) {
    diff[key] = { old: row[key], new: null };
  }
  return diff;
}

/**
 * Shape a `link` diff: the junction row's content, verbatim. A revert
 * of a link deletes the junction row, so the content is all the
 * before-image needs. The whole row is the unit — no per-field
 * envelope (spec §3).
 */
export function linkDiff(
  junctionRow: Record<string, unknown>,
): Record<string, unknown> {
  return { ...junctionRow };
}

/**
 * Shape an `unlink` diff: the removed junction row's full content. A
 * revert of an unlink re-inserts the junction row from this content.
 * Same shape as `linkDiff` — the effect direction is carried by
 * `kind`, not by the payload.
 */
export function unlinkDiff(
  junctionRow: Record<string, unknown>,
): Record<string, unknown> {
  return { ...junctionRow };
}

/** Thrown when a run is minted without a non-empty message (spec §2). */
export class StewardshipRunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StewardshipRunValidationError";
  }
}

/**
 * The run-message rule (spec §2): no bulk mutation without a stated
 * reason. Exported so a composer that builds its run insert outside
 * `composeRunInsert` (the import mint's conditional raw insert) enforces
 * the same rule before any write. The DB CHECK
 * (`length(trim(message)) > 0`) is the backstop; this is the fail-fast
 * front stop.
 */
export function assertRunMessage(message: string): void {
  if (message.trim().length === 0) {
    throw new StewardshipRunValidationError(
      "stewardship run message is required and cannot be empty or whitespace",
    );
  }
}

export interface RunInsertParams {
  /** The acting tenant — imports are tenant-scoped (spec §2). */
  tenantId: string;
  /** Federation scope, for federation-scoped operations. Optional. */
  federationId?: string | null;
  /** v1 vocabulary: an import run or a compensating revert run. */
  kind: "import" | "revert";
  /**
   * REQUIRED commit message — the run-level generalisation of the
   * hand-edit commit note (spec §2). Rejected here if empty or
   * whitespace-only, not only by the DB CHECK, so callers fail early
   * with a clear error rather than at batch time.
   */
  message: string;
  /** Optional longer rationale. */
  justification?: string | null;
  /** The run's author. */
  userId: string;
  /** On kind='revert': the target run this one compensates. */
  revertsRunId?: string | null;
  /** Import runs: which mapping profile + version produced the run. */
  profileId?: string | null;
  profileVersion?: number | null;
  /** B2 pointer to the uploaded source file (import runs). */
  sourceArtifact?: string | null;
  /** B2 pointer to the dry-run/commit report artefact (import runs). */
  reportArtifact?: string | null;
  /** Clock override (epoch ms). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Build the `stewardship_runs` insert for one run, minted as
 * `pending` (the Workflow flips it to `running` and onward). Returns
 * the generated id alongside the un-awaited insert builder: the
 * caller needs the id to launch the Workflow and to stamp revert
 * linkage, and embeds the statement in its own `db.batch([...])` (a
 * run row is minted on its own path, not inside a domain-mutation
 * batch).
 *
 * Rejects an empty or whitespace-only message with
 * `StewardshipRunValidationError` (spec §2: no bulk mutation without a
 * stated reason). The DB CHECK (`length(trim(message)) > 0`) is the
 * backstop; this is the fail-fast front stop.
 */
export function composeRunInsert(
  db: DrizzleD1Database<any>,
  params: RunInsertParams,
): { id: string; statement: BatchItem<"sqlite"> } {
  assertRunMessage(params.message);

  const id = crypto.randomUUID();
  const now = params.now ?? Date.now();

  const statement = db.insert(stewardshipRuns).values({
    id,
    tenantId: params.tenantId,
    federationId: params.federationId ?? null,
    kind: params.kind,
    message: params.message,
    justification: params.justification ?? null,
    userId: params.userId,
    status: "pending",
    revertsRunId: params.revertsRunId ?? null,
    revertedByRunId: null,
    profileId: params.profileId ?? null,
    profileVersion: params.profileVersion ?? null,
    sourceArtifact: params.sourceArtifact ?? null,
    reportArtifact: params.reportArtifact ?? null,
    createdAt: now,
  });

  return { id, statement };
}
