/**
 * Import dry-run runner — report + rejects artefacts, no journalled writes
 *
 * This module deals with running the validation pipeline (`./validate`)
 * over a staged upload and a chosen profile, and writing the two artefacts
 * the operator judges before any commit (spec §4): a JSON report under
 * `stagingKey.report` and a rejects CSV under `stagingKey.reject`. It runs
 * before, and independently of, any commit — the pre-write audit
 * discipline. The only database write is stamping the upload's
 * `report_artifact` pointer; NOTHING here writes descriptions, entities,
 * places, repositories, or any junction — the journal-coverage scanner
 * guards that, and the dry-run has no business mutating journalled state.
 *
 * Count discipline (design law, spec §4): every count in the report is a
 * reduction over the SAME verdicts the pipeline produced — there is no
 * separate recount. The rejects CSV carries the ORIGINAL columns verbatim
 * plus a row number and a reason (the `_needs_review.csv` pattern), so a
 * cataloguer opens it in the same spreadsheet the upload came from.
 *
 * The create-vs-update classification needs the tenant's existing
 * reference codes; that is the one D1 READ here, chunked into bounded
 * `IN (...)` queries rather than a query per row.
 *
 * @version v0.6.0
 */

import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions } from "../../db/schema";
import type { Standard } from "../standards/types";
import type { ProfileBindings } from "./profile-schema";
import { decodeAndParseCsv } from "./csv";
import { REQUIRED_TARGET } from "./target-fields";
import {
  extractParentReferenceCodes,
  extractReferenceCodes,
  validate,
  type RejectReason,
  type RowVerdict,
  type ValidationWarning,
} from "./validate";
import {
  stagingKey,
  type StagingStore,
} from "./staging.server";
import { stampUploadReport, type UploadRow } from "./uploads.server";

/** The report artefact's shape, versioned so a reader can gate on it. */
export interface DryRunReport {
  reportVersion: 1;
  uploadId: string;
  tenantId: string;
  filename: string;
  profileId: string;
  profileVersion: number;
  standard: Standard;
  updateExisting: boolean;
  /**
   * The accepted `missing_required_field:<level>:<field>` classes this run
   * classified under, sorted. A report is reviewable evidence only for the
   * acceptance state it ran with — the commit compares the upload's CURRENT
   * acceptances against this set and refuses on any mismatch. Stored report
   * artefacts may lack the field; readers MUST treat absence as the empty
   * set.
   */
  acceptedClasses?: string[];
  generatedAt: number;
  counts: {
    total: number;
    creates: number;
    updates: number;
    skips: number;
    rejects: number;
    warnings: number;
    /** Reject tallies keyed by named reason (spec §4). */
    rejectsByReason: Record<string, number>;
    /** Warning tallies keyed by transform/date warning code. */
    warningsByCode: Record<string, number>;
  };
  headerBinding: {
    unboundBindings: { source: string; target: string }[];
    unrecognisedHeaders: string[];
  };
  /** Rejected rows with the key columns the report UI shows, verbatim. */
  rejects: {
    rowNumber: number;
    reason: RejectReason;
    referenceCode: string;
    title: string;
    detail?: Record<string, unknown>;
  }[];
}

export interface DryRunInput {
  db: DrizzleD1Database<any>;
  store: StagingStore;
  tenantId: string;
  upload: UploadRow;
  profile: { id: string; version: number; bindings: ProfileBindings };
  standard: Standard;
  updateExisting: boolean;
  /** Structural defaults the commit would assign (e.g. a target repository). */
  defaults?: { repositoryId?: string };
  /**
   * Readiness-check acceptances (design §4): accepted
   * `missing_required_field:<level>:<field>` class keys. Rows failing only
   * on these classes create honestly sparse instead of rejecting. The
   * caller derives this from the upload's recorded decisions.
   */
  acceptedClasses?: ReadonlySet<string>;
}

export interface DryRunOutcome {
  report: DryRunReport;
  reportKey: string;
  rejectKey: string;
}

/**
 * The existence query binds one fixed parameter (the tenant id) besides
 * its chunk of codes; D1 caps bound parameters at 100 per statement, so
 * the chunk size must satisfy chunk + fixed <= 100. A unit test pins the
 * arithmetic — re-derive it before changing either constant.
 */
export const EXISTENCE_QUERY_FIXED_PARAMS = 1;
export const EXISTING_CODES_CHUNK = 99;

/**
 * Read which of `codes` already exist as reference codes for the tenant,
 * in bounded `IN (...)` chunks (never a query per row). Returns a set for
 * O(1) create-vs-update classification.
 */
export async function fetchExistingReferenceCodes(
  db: DrizzleD1Database<any>,
  tenantId: string,
  codes: readonly string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  const unique = [...new Set(codes)].filter((c) => c !== "");
  for (let i = 0; i < unique.length; i += EXISTING_CODES_CHUNK) {
    const chunk = unique.slice(i, i + EXISTING_CODES_CHUNK);
    const rows = (await db
      .select({ referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(
        // Tenant scope AND membership in this chunk — reference codes are
        // unique per tenant (desc_ref_code_idx on (tenantId, referenceCode)).
        and(
          eq(descriptions.tenantId, tenantId),
          inArray(descriptions.referenceCode, chunk),
        ),
      )
      .all()) as { referenceCode: string }[];
    for (const row of rows) existing.add(row.referenceCode);
  }
  return existing;
}

/**
 * Read the CURRENT parent reference code for each existing row among
 * `codes` (null = the row is a root), keyed by the row's own reference
 * code. A self-join resolves the parent id to its reference code; the
 * join binds no extra parameters, so the chunk arithmetic is the same as
 * the existence read's (chunk + tenant id <= 100). Feeds the
 * `parent_change_ignored` warning: imports never re-parent existing rows,
 * and the report must name the rows whose CSV parent was ignored.
 */
export async function fetchExistingReferenceParents(
  db: DrizzleD1Database<any>,
  tenantId: string,
  codes: readonly string[],
): Promise<Map<string, string | null>> {
  const parents = new Map<string, string | null>();
  const parentDesc = alias(descriptions, "parent_desc");
  const unique = [...new Set(codes)].filter((c) => c !== "");
  for (let i = 0; i < unique.length; i += EXISTING_CODES_CHUNK) {
    const chunk = unique.slice(i, i + EXISTING_CODES_CHUNK);
    const rows = (await db
      .select({
        referenceCode: descriptions.referenceCode,
        parentReferenceCode: parentDesc.referenceCode,
      })
      .from(descriptions)
      .leftJoin(parentDesc, eq(parentDesc.id, descriptions.parentId))
      .where(
        and(
          eq(descriptions.tenantId, tenantId),
          inArray(descriptions.referenceCode, chunk),
        ),
      )
      .all()) as { referenceCode: string; parentReferenceCode: string | null }[];
    for (const row of rows) parents.set(row.referenceCode, row.parentReferenceCode);
  }
  return parents;
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * The rejects-CSV reason cell (design §5): the reason code, extended with
 * the concrete detail so a cataloguer opening the file reads WHAT to fix —
 * `missing_required_field` names the fields, `parent_rejected` names the
 * parent, `duplicate_reference_code` names the colliding rows. The
 * machine-readable code stays first so the column remains groupable.
 */
function reasonCell(reject: RowVerdict): string {
  const reason = reject.reason ?? "invalid_field";
  const detail = reject.detail ?? {};
  if (reason === "missing_required_field") {
    const fields = (detail.requiredMissing as string[]) ?? (detail.fields as string[]) ?? [];
    return fields.length > 0 ? `${reason}: ${fields.join(", ")}` : reason;
  }
  if (reason === "parent_rejected") {
    const parent = detail.parentReferenceCode as string | undefined;
    return parent ? `${reason}: ${parent}` : reason;
  }
  if (reason === "duplicate_reference_code") {
    const rows = (detail.rows as number[]) ?? [];
    return rows.length > 0 ? `${reason}: rows ${rows.join(", ")}` : reason;
  }
  return reason;
}

/**
 * A reserved column name that cannot collide with the source headers: the
 * preferred name, suffixed with underscores until unique. The source
 * columns pass through verbatim, so it is the RESERVED name that yields.
 */
function reservedHeader(preferred: string, taken: ReadonlySet<string>): string {
  let candidate = preferred;
  while (taken.has(candidate)) candidate += "_";
  return candidate;
}

/**
 * Build the rejects CSV: the original header row plus a row-number and a
 * reason column (named `_row_number` / `_reason`, underscore-suffixed if
 * the source file already uses those names), then one line per rejected
 * row carrying that row's ORIGINAL cell values verbatim (aligned to the
 * original headers) with its row number and reason appended.
 */
function buildRejectsCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  rejects: readonly RowVerdict[],
): string {
  const taken = new Set(headers);
  const rowNumberHeader = reservedHeader("_row_number", taken);
  taken.add(rowNumberHeader);
  const reasonHeader = reservedHeader("_reason", taken);
  const outHeaders = [...headers, rowNumberHeader, reasonHeader];
  const lines = [outHeaders.map(csvField).join(",")];
  for (const reject of rejects) {
    const original = rows[reject.rowNumber - 1] ?? [];
    const cells = headers.map((_, i) => csvField(original[i] ?? ""));
    cells.push(csvField(String(reject.rowNumber)));
    cells.push(csvField(reasonCell(reject)));
    lines.push(cells.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function tally(verdicts: readonly RowVerdict[], warnings: readonly ValidationWarning[]) {
  const counts = {
    total: verdicts.length,
    creates: 0,
    updates: 0,
    skips: 0,
    rejects: 0,
    warnings: warnings.length,
    rejectsByReason: {} as Record<string, number>,
    warningsByCode: {} as Record<string, number>,
  };
  for (const v of verdicts) {
    if (v.verdict === "create") counts.creates++;
    else if (v.verdict === "update") counts.updates++;
    else if (v.verdict === "skip") counts.skips++;
    else if (v.verdict === "reject") {
      counts.rejects++;
      const reason = v.reason ?? "invalid_field";
      counts.rejectsByReason[reason] = (counts.rejectsByReason[reason] ?? 0) + 1;
    }
  }
  for (const w of warnings) {
    counts.warningsByCode[w.code] = (counts.warningsByCode[w.code] ?? 0) + 1;
  }
  return counts;
}

/** Resolve the source header a binding target reads from, if any. */
function sourceFor(bindings: ProfileBindings, target: string): string | null {
  return bindings.find((b) => b.target === target)?.source ?? null;
}

/**
 * Run the dry-run: parse the staged CSV, classify every row, write the
 * report and rejects artefacts to the staging store, and stamp the
 * upload's `report_artifact` pointer. No journalled table is touched.
 */
export async function runDryRun(input: DryRunInput): Promise<DryRunOutcome> {
  const bytes = await input.store.getBytes(input.upload.artifactKey);
  if (!bytes) {
    throw new Error(`Staged upload object missing: ${input.upload.artifactKey}`);
  }
  const parsed = decodeAndParseCsv(bytes);

  // The existence read covers BOTH the rows' own reference codes (to
  // classify create vs update) AND the parent reference codes (so an
  // "items into an existing container" import can resolve a parent that
  // lives in the database, not the file — spec §6). A parent that is
  // itself an in-file row is classified in-file before this set is
  // consulted, so including it here is harmless.
  const codes = extractReferenceCodes({
    bindings: input.profile.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
  });
  const parentCodes = extractParentReferenceCodes({
    bindings: input.profile.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
  });
  const existingReferenceCodes = await fetchExistingReferenceCodes(
    input.db,
    input.tenantId,
    [...codes, ...parentCodes],
  );
  const existingParents = await fetchExistingReferenceParents(
    input.db,
    input.tenantId,
    codes,
  );

  const result = validate({
    standard: input.standard,
    bindings: input.profile.bindings,
    headers: parsed.headers,
    rows: parsed.rows,
    existingReferenceCodes,
    updateExisting: input.updateExisting,
    defaults: input.defaults,
    existingParents,
    acceptedClasses: input.acceptedClasses,
  });

  const counts = tally(result.verdicts, result.warnings);

  const refSource = sourceFor(input.profile.bindings, REQUIRED_TARGET);
  const titleSource = sourceFor(input.profile.bindings, "title");
  const headerIndex = new Map(parsed.headers.map((h, i) => [h, i]));
  const rawCell = (rowNumber: number, header: string | null): string => {
    if (header === null) return "";
    const i = headerIndex.get(header);
    if (i === undefined) return "";
    return parsed.rows[rowNumber - 1]?.[i] ?? "";
  };

  const rejectVerdicts = result.verdicts.filter((v) => v.verdict === "reject");
  const report: DryRunReport = {
    reportVersion: 1,
    uploadId: input.upload.id,
    tenantId: input.tenantId,
    filename: input.upload.filename,
    profileId: input.profile.id,
    profileVersion: input.profile.version,
    standard: input.standard,
    updateExisting: input.updateExisting,
    acceptedClasses: [...(input.acceptedClasses ?? [])].sort(),
    generatedAt: Date.now(),
    counts,
    headerBinding: result.headerBinding,
    rejects: rejectVerdicts.map((v) => ({
      rowNumber: v.rowNumber,
      reason: v.reason ?? "invalid_field",
      referenceCode: rawCell(v.rowNumber, refSource),
      title: rawCell(v.rowNumber, titleSource),
      detail: v.detail,
    })),
  };

  const reportKey = stagingKey.report(input.tenantId, input.upload.id);
  const rejectKey = stagingKey.reject(input.tenantId, input.upload.id);
  await input.store.put(reportKey, JSON.stringify(report, null, 2), {
    contentType: "application/json; charset=utf-8",
  });
  await input.store.put(
    rejectKey,
    buildRejectsCsv(parsed.headers, parsed.rows, rejectVerdicts),
    { contentType: "text/csv; charset=utf-8" },
  );

  await stampUploadReport(input.db, input.tenantId, input.upload.id, {
    reportArtifact: reportKey,
    profileId: input.profile.id,
    profileVersion: input.profile.version,
  });

  return { report, reportKey, rejectKey };
}
