/**
 * Import readiness check — compute, cache, decisions, and gating
 *
 * This module wraps the pure aggregation in `./check` with the D1 + staging
 * plumbing the Check step needs (readiness-check design §3). It computes the
 * findings for a staged upload against its chosen profile, caches them on the
 * upload row pinned to `(profileId, profileVersion)`, records and reverses
 * per-class acceptance decisions, and derives the dry-run gate.
 *
 * Caching (design §3.5): `import_uploads.check_findings` holds
 * `{ profileId, profileVersion, computedAt, findings }`. The cache is reused
 * while the pin matches the CURRENT profile version; on drift or absence the
 * findings are recomputed. A profile-version (or profile) change also RESETS
 * every decision — an acceptance is only meaningful against the findings it
 * was made on (design §3.4).
 *
 * Decisions (design §3.4, §3.5): `import_uploads.check_decisions` is a JSON
 * array of self-contained entries — the class keys covered, the level and
 * fields, the row count and forward cascade at acceptance, and who accepted
 * when. Self-containment matters because `mintImportRun` copies this array
 * verbatim into the run's `accepted_findings` snapshot at commit time, so the
 * audit record never depends on re-deriving anything.
 *
 * Gating (design §3.4): the dry run unlocks when every DECISION finding is
 * accepted. A file with no decision findings unlocks trivially. Blocking and
 * informational findings never gate.
 *
 * The existence reads mirror the dry run's (own codes + parent codes, chunked
 * under the D1 bound-parameter cap), so the findings a user decides on are
 * computed from exactly the classification a dry run would produce.
 *
 * @version v0.6.0
 */

import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { importUploads } from "../../db/schema";
import type { Standard } from "../standards/types";
import { decodeAndParseCsv } from "./csv";
import { computeFindings, type Finding } from "./check";
import {
  fetchExistingReferenceCodes,
  fetchExistingReferenceParents,
} from "./dry-run.server";
import type { ProfileBindings } from "./profile-schema";
import type { StagingStore } from "./staging.server";
import type { UploadRow } from "./uploads.server";
import {
  extractParentReferenceCodes,
  extractReferenceCodes,
  validate,
} from "./validate";

/** The cached findings envelope stored on `import_uploads.check_findings`. */
export interface CheckFindingsCache {
  profileId: string;
  profileVersion: number;
  computedAt: number;
  findings: Finding[];
}

/**
 * One recorded acceptance (design §3.5). Self-contained: it names every
 * class key it covers plus the level/fields/counts as they stood at
 * acceptance, so the run's `accepted_findings` snapshot (copied verbatim at
 * mint) is complete on its own.
 */
export interface CheckDecision {
  /** The decision finding's group key (`<level>::<sorted-fields>`). */
  key: string;
  /** Every `missing_required_field:<level>:<field>` class this covers. */
  classKeys: string[];
  level: string;
  fields: string[];
  /** Rows affected per class (all classes in a group share the same rows). */
  count: number;
  cascadeCount: number;
  acceptedBy: string;
  acceptedAt: number;
}

export interface CheckState {
  findings: Finding[];
  decisions: CheckDecision[];
  /** Decision findings still awaiting acceptance. */
  pending: Finding[];
  decisionsTotal: number;
  decisionsMade: number;
  /** The dry-run gate: true when no decision finding is pending. */
  unlocked: boolean;
  computedAt: number;
}

/** The union of every accepted class key — the `validate()` acceptance set. */
export function deriveAcceptedClasses(
  decisions: readonly CheckDecision[],
): Set<string> {
  const set = new Set<string>();
  for (const d of decisions) for (const k of d.classKeys) set.add(k);
  return set;
}

/** Parse the stored decisions array, tolerant of an absent/corrupt column. */
export function parseDecisions(raw: string | null | undefined): CheckDecision[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as CheckDecision[]) : [];
  } catch {
    return [];
  }
}

/** Parse the cached findings envelope, tolerant of an absent/corrupt column. */
function parseCache(raw: string | null | undefined): CheckFindingsCache | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && Array.isArray(value.findings)) {
      return value as CheckFindingsCache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Derive the gate state from findings + decisions (design §3.4). A decision
 * finding is satisfied when a stored decision carries its group key; the dry
 * run unlocks once none remain pending. Blocking/informational findings are
 * never counted here.
 */
export function gateState(
  findings: readonly Finding[],
  decisions: readonly CheckDecision[],
  computedAt: number,
): CheckState {
  const acceptedKeys = new Set(decisions.map((d) => d.key));
  const decisionFindings = findings.filter((f) => f.kind === "decision");
  const pending = decisionFindings.filter((f) => !acceptedKeys.has(f.key));
  return {
    findings: [...findings],
    decisions: [...decisions],
    pending,
    decisionsTotal: decisionFindings.length,
    decisionsMade: decisionFindings.length - pending.length,
    unlocked: pending.length === 0,
    computedAt,
  };
}

/**
 * A staged upload's check state summarised from the CACHED columns alone
 * (design §8a): the landing's "Imports in progress" rows derive their state
 * line and mini-rail from this — never from a findings recompute, and never
 * with a write. `checked` holds only while the cache pin matches the row's
 * own (profileId, profileVersion); counts are meaningful only when checked.
 */
export interface CachedCheckSummary {
  hasProfile: boolean;
  /** Cache present AND pinned to the row's current profile version. */
  checked: boolean;
  decisionsMade: number;
  decisionsTotal: number;
  /** The dry-run gate, per the cached findings + decisions. */
  unlocked: boolean;
}

/**
 * The full check state from an upload row's CACHED columns alone (pure —
 * no DB, no store, no write). Null when the row carries no cache pinned to
 * its own (profileId, profileVersion). This is the ONLY check source for
 * read-only surfaces: a non-staged upload's staged object may already be
 * gone (the delete flow), so nothing rendering it may recompute.
 */
export function cachedCheckState(
  row: Pick<
    UploadRow,
    "profileId" | "profileVersion" | "checkFindings" | "checkDecisions"
  >,
): CheckState | null {
  if (row.profileId === null || row.profileVersion === null) return null;
  const cache = parseCache(row.checkFindings);
  if (
    cache === null ||
    cache.profileId !== row.profileId ||
    cache.profileVersion !== row.profileVersion
  ) {
    return null;
  }
  return gateState(cache.findings, parseDecisions(row.checkDecisions), cache.computedAt);
}

/** Summarise an upload row's check state from its cached columns (pure). */
export function cachedCheckSummary(
  row: Pick<
    UploadRow,
    "profileId" | "profileVersion" | "checkFindings" | "checkDecisions"
  >,
): CachedCheckSummary {
  const state = cachedCheckState(row);
  if (state === null) {
    return {
      hasProfile: row.profileId !== null,
      checked: false,
      decisionsMade: 0,
      decisionsTotal: 0,
      unlocked: false,
    };
  }
  return {
    hasProfile: true,
    checked: true,
    decisionsMade: state.decisionsMade,
    decisionsTotal: state.decisionsTotal,
    unlocked: state.unlocked,
  };
}

/** Map each bound target field to its source header, for fix-hint copy. */
function targetToSourceMap(bindings: ProfileBindings): Record<string, string> {
  const map: Record<string, string> = {};
  for (const b of bindings) if (!(b.target in map)) map[b.target] = b.source;
  return map;
}

export interface ComputeFindingsParams {
  db: DrizzleD1Database<any>;
  store: StagingStore;
  tenantId: string;
  upload: UploadRow;
  standard: Standard;
  profile: { id: string; version: number; bindings: ProfileBindings };
}

/**
 * Compute the readiness findings for an upload against its profile, caching
 * them on the upload row pinned to `(profileId, profileVersion)`. Returns the
 * cache while the pin matches; recomputes on drift or absence. A profile /
 * profile-version change also resets every decision (design §3.4). Findings
 * are always computed with NO acceptances, so the Check step shows the full
 * picture regardless of what has been accepted so far.
 */
export async function computeAndCacheFindings(
  params: ComputeFindingsParams,
): Promise<CheckState> {
  const { db, store, tenantId, upload, standard, profile } = params;
  const prev = parseCache(upload.checkFindings);
  const pinnedOk =
    prev !== null &&
    prev.profileId === profile.id &&
    prev.profileVersion === profile.version;

  if (pinnedOk) {
    return gateState(prev.findings, parseDecisions(upload.checkDecisions), prev.computedAt);
  }

  // Recompute: parse the staged CSV, classify with NO acceptances, aggregate.
  const bytes = await store.getBytes(upload.artifactKey);
  if (!bytes) throw new Error(`Staged upload object missing: ${upload.artifactKey}`);
  const parsed = decodeAndParseCsv(bytes);

  const codes = extractReferenceCodes({
    bindings: profile.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
  });
  const parentCodes = extractParentReferenceCodes({
    bindings: profile.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
  });
  const existingReferenceCodes = await fetchExistingReferenceCodes(db, tenantId, [
    ...codes,
    ...parentCodes,
  ]);
  const existingParents = await fetchExistingReferenceParents(db, tenantId, codes);

  const result = validate({
    standard,
    bindings: profile.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
    existingReferenceCodes,
    updateExisting: false,
    existingParents,
  });

  const findings = computeFindings({
    result,
    rowIdentifiers: result.rowIdentifiers,
    targetToSource: targetToSourceMap(profile.bindings),
  });

  const computedAt = Date.now();
  const cache: CheckFindingsCache = {
    profileId: profile.id,
    profileVersion: profile.version,
    computedAt,
    findings,
  };

  // A prior pin that differs is drift — reset decisions with the recompute
  // (design §3.4). Absence with no prior pin keeps whatever decisions exist
  // (normally none; decisions are only written after findings are computed).
  const drifted =
    prev !== null &&
    (prev.profileId !== profile.id || prev.profileVersion !== profile.version);
  const set: Record<string, unknown> = {
    checkFindings: JSON.stringify(cache),
    updatedAt: computedAt,
  };
  if (drifted) set.checkDecisions = JSON.stringify([]);

  await db
    .update(importUploads)
    .set(set)
    .where(and(eq(importUploads.id, upload.id), eq(importUploads.tenantId, tenantId)));

  const decisions = drifted ? [] : parseDecisions(upload.checkDecisions);
  return gateState(findings, decisions, computedAt);
}

/**
 * Record acceptance of one decision finding. The stored entry is
 * self-contained (design §3.5) — class keys, level, fields, count, cascade,
 * author, timestamp — so the commit's `accepted_findings` snapshot needs no
 * re-derivation. Re-accepting the same key is idempotent (the prior entry is
 * replaced, keeping the latest author/time). Returns the updated decisions.
 */
export async function acceptDecision(
  db: DrizzleD1Database<any>,
  tenantId: string,
  upload: UploadRow,
  finding: {
    key: string;
    classKeys: string[];
    level: string;
    fields: string[];
    count: number;
    cascadeCount: number;
  },
  userId: string,
  now: number = Date.now(),
): Promise<CheckDecision[]> {
  const decisions = parseDecisions(upload.checkDecisions).filter(
    (d) => d.key !== finding.key,
  );
  decisions.push({
    key: finding.key,
    classKeys: finding.classKeys,
    level: finding.level,
    fields: finding.fields,
    count: finding.count,
    cascadeCount: finding.cascadeCount,
    acceptedBy: userId,
    acceptedAt: now,
  });
  await db
    .update(importUploads)
    .set({ checkDecisions: JSON.stringify(decisions), updatedAt: now })
    .where(and(eq(importUploads.id, upload.id), eq(importUploads.tenantId, tenantId)));
  return decisions;
}

/** Reverse a decision (Undo, reversible until commit — design §3.4). */
export async function undoDecision(
  db: DrizzleD1Database<any>,
  tenantId: string,
  upload: UploadRow,
  key: string,
  now: number = Date.now(),
): Promise<CheckDecision[]> {
  const decisions = parseDecisions(upload.checkDecisions).filter((d) => d.key !== key);
  await db
    .update(importUploads)
    .set({ checkDecisions: JSON.stringify(decisions), updatedAt: now })
    .where(and(eq(importUploads.id, upload.id), eq(importUploads.tenantId, tenantId)));
  return decisions;
}
