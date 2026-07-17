/**
 * Import validation pipeline — pure orchestration over the landed pieces
 *
 * This module deals with turning a parsed CSV plus a mapping profile into
 * per-row verdicts (spec §4), composing the pieces that already landed:
 * header binding against the profile, per-row transforms (`./transforms`,
 * including the date parser), identifier discipline (`./identifiers`), and
 * the tenant's descriptive-standard Zod validator
 * (`../standards/validator-factory`) — the real validator, non-negotiable
 * (the schema header's own warning: bulk import MUST run it before INSERT).
 * It is a pure function; the create-vs-update classification is decided
 * against a set of already-existing reference codes the caller supplies
 * (a D1 read the dry-run runner performs), so this module never touches
 * the database.
 *
 * The asymmetry rule (spec §2, §3) is the spine. Identifier failures block
 * a row into a reject with a named reason. Over-length values reject —
 * never truncate (spec §2). A descriptive-standard validation failure
 * rejects with the failing fields named. But an unrecognised DESCRIBING
 * value does NOT reject: the transform catalogue already degrades it to a
 * safe default and returns a structured warning, and those warnings are
 * accumulated here and reported, never promoted to rejects.
 *
 * Structural fields the CSV does not carry are the caller's to supply:
 * `repositoryId` is assigned at commit from the run's target repository
 * (phase 5), so a placeholder is injected before validation to reflect
 * DESCRIBING-field validity rather than rejecting every row on a field no
 * import spreadsheet holds. Source-system identifiers land in `legacyIds`
 * (spec §2), never a typed column per source — several bindings may share
 * that target, each entry tagged with a per-column provider (the binding's
 * own `provider`, else a slug of its source header), so source identity
 * survives the import. `legacyIds` joins the assembled record ONLY when
 * the profile binds it, and a blank transformed cell assigns nothing —
 * blank means keep on update and absent on create — so an import can never
 * blank out a populated field or erase archived identifiers.
 *
 * Rejection cascades through the hierarchy regardless of WHY the parent
 * fell: a row whose in-file parent was rejected — by identifier discipline
 * or by the standard validator — is itself rejected (`parent_rejected`),
 * transitively, because its container will never be created. A skipped
 * parent does not cascade (it already exists in the database).
 *
 * The readiness check (readiness-check design §4) threads an
 * `acceptedClasses` set of `missing_required_field:<level>:<field>` keys.
 * A row whose ONLY validation failures are required-field gaps, every one
 * of them an accepted class, does NOT reject: it is created honestly
 * sparse and the accepted classes tally as warnings. A row failing on any
 * NON-accepted required field, or on any non-required check (over-length,
 * bad level, bad field), still rejects with its fields named. Identifier
 * discipline is untouched by acceptance — the asymmetry rule holds — and
 * an accepted parent that no longer rejects no longer cascades onto its
 * descendants.
 *
 * @version v0.6.0
 */

import { z } from "zod/v4";
import { applyTransform, type RowContext, type TransformValue } from "./transforms";
import type { DateParseResult } from "./date-parser";
import {
  resolveIdentifiers,
  isDescriptionLevel,
  type IdentifierRejectReason,
  type ResolvedRow,
} from "./identifiers";
import type { ProfileBindings } from "./profile-schema";
import { descriptionValidatorFor } from "../standards/validator-factory";
import type { DescriptionLevel, Standard } from "../standards/types";
import { REQUIRED_TARGET, STRUCTURAL_TARGETS } from "./target-fields";

/** Reject reasons: identifier-class (spec §3) plus validation-class (spec §4). */
export type RejectReason =
  | IdentifierRejectReason
  | "value_too_long"
  | "missing_required_field"
  | "invalid_description_level"
  | "invalid_field"
  | "parent_rejected";

export type Verdict = "create" | "update" | "skip" | "reject";

export interface RowVerdict {
  rowNumber: number;
  referenceCode: string | null;
  verdict: Verdict;
  /** Present iff `verdict === "reject"`. */
  reason?: RejectReason;
  /** Structured context: named fields, the colliding rows, the bad parent. */
  detail?: Record<string, unknown>;
  /**
   * The assembled, Zod-parsed description record for `create`/`update`/
   * `skip` verdicts — the commit phase's write payload; absent on rejects.
   */
  record?: Record<string, unknown>;
}

export interface ValidationWarning {
  rowNumber: number;
  /** The transform/date warning code (e.g. `unknown_vocabulary`). */
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface HeaderBindingResult {
  /** Bindings whose source header is absent from the file (named, not fatal). */
  unboundBindings: { source: string; target: string }[];
  /** File headers no binding reads (named for the report). */
  unrecognisedHeaders: string[];
}

export interface ValidateInput {
  standard: Standard;
  bindings: ProfileBindings;
  /** File header names, in file order. */
  headers: readonly string[];
  /** Data rows, each aligned to `headers` by index. */
  rows: readonly (readonly string[])[];
  /** Reference codes already present for the tenant (a D1 read). */
  existingReferenceCodes: ReadonlySet<string>;
  /** §7.1: when false, an existing reference code is skipped, not updated. */
  updateExisting: boolean;
  /** Structural fields the commit assigns; injected before validation. */
  defaults?: { repositoryId?: string };
  /**
   * Existing rows' CURRENT parent reference codes, keyed by the row's own
   * reference code (null = the row is a root). When supplied, an `update`
   * verdict whose CSV parent differs from the row's current parent emits a
   * `parent_change_ignored` warning: imports never re-parent existing rows
   * (re-parenting needs subtree recompute and a revert story — out of v1
   * scope), and the divergence must be visible in the report, never silent.
   */
  existingParents?: ReadonlyMap<string, string | null>;
  /**
   * Readiness-check acceptances (design §4): the set of accepted
   * `missing_required_field:<level>:<field>` class keys. A row failing
   * required-field enforcement ONLY on accepted classes is created
   * honestly sparse (a warning tally) instead of rejected. Absent = the
   * empty set (nothing accepted — the check's own computation runs this
   * way to surface the full picture).
   */
  acceptedClasses?: ReadonlySet<string>;
}

export interface ValidateResult {
  verdicts: RowVerdict[];
  warnings: ValidationWarning[];
  headerBinding: HeaderBindingResult;
  /**
   * The resolved (non-identifier-reject) rows in TOPOLOGICAL order — every
   * parent precedes its children (spec §3). The commit walks this so a
   * child's parent row is always written and requeryable first; a verdict
   * for a row here may still be a later Zod `reject`, so the commit joins
   * by `rowNumber` and acts only on `create`/`update` verdicts.
   */
  ordered: ResolvedRow[];
  /**
   * Resolved identifiers for EVERY data row in file order — the real
   * parent graph the readiness check reads its forward cascades off
   * (design §3.2), including rows that later rejected. `referenceCode` is
   * null when the row carried no code (a blank-reference reject).
   */
  rowIdentifiers: { rowNumber: number; referenceCode: string | null; parentReferenceCode: string | null }[];
  /**
   * Per-row INTRINSIC descriptive-standard validation for every resolved row
   * (in `ordered`), independent of the parent cascade — the readiness check
   * reads a row's own required-field gaps even when its verdict is
   * `parent_rejected` (design §3.2). `requiredMissing` names the row's
   * missing required fields at `level`; `otherInvalid` flags any non-required
   * failure (over-length, bad level/field), which acceptance never relieves.
   */
  rowValidation: {
    rowNumber: number;
    level: DescriptionLevel;
    requiredMissing: string[];
    otherInvalid: boolean;
  }[];
}

/** A placeholder repository id so `repositoryId` is not the field that
 *  rejects every row (it is assigned at commit, not read from the CSV). */
const PLACEHOLDER_REPOSITORY_ID = "00000000-0000-4000-8000-000000000000";
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000001";

const STRUCTURAL_TARGET_SET = new Set<string>(STRUCTURAL_TARGETS);

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** A transform value is either a plain string or the structured date result;
 *  a non-string value is therefore a `DateParseResult`. */
function isDateResult(value: TransformValue): value is DateParseResult {
  return typeof value !== "string";
}

/**
 * The `legacyIds` provider tag for one binding: the binding's own
 * `provider` when set, else a slug of the source header (e.g.
 * `Former_Reference_Geiger` → `former-reference-geiger`). Source identity
 * is preserved per column — never a constant per run — matching the
 * per-source provider convention of every existing `legacy_ids` writer.
 */
export function legacyIdProviderFor(binding: {
  source: string;
  provider?: string;
}): string {
  if (binding.provider && binding.provider.trim() !== "") {
    return binding.provider.trim();
  }
  const slug = binding.source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "import" : slug;
}

/**
 * Resolve, per row, which file column index each header binds to. A
 * binding whose source header is absent is named (its column reads as
 * absent, so a required identifier missing its source surfaces downstream
 * as an identifier reject, not a silent pass).
 */
function bindHeaders(
  headers: readonly string[],
  bindings: ProfileBindings,
): HeaderBindingResult {
  const present = new Set(headers);
  const unboundBindings: { source: string; target: string }[] = [];
  const readHeaders = new Set<string>();
  for (const binding of bindings) {
    if (present.has(binding.source)) {
      readHeaders.add(binding.source);
    } else {
      unboundBindings.push({ source: binding.source, target: binding.target });
    }
    // A concatenate transform reads several columns beyond its own source.
    if (binding.transform?.kind === "concatenate") {
      for (const part of binding.transform.parts) readHeaders.add(part.column);
    }
  }
  const unrecognisedHeaders = headers.filter((h) => !readHeaders.has(h));
  return { unboundBindings, unrecognisedHeaders };
}

/** The assembled description-field values for one row (pre-validation). */
interface AssembledRow {
  rowNumber: number;
  referenceCode: string | null;
  parentReferenceCode: string | null;
  record: Record<string, unknown>;
}

/**
 * Apply every binding's transform to one row, threading carry-forward
 * context per binding target, and assemble the description record. Date
 * results spread into `dateStart`/`dateEnd`/`dateCertainty`/`dateExpression`;
 * `legacyIds` bindings accumulate into the JSON array; `parent` and
 * `referenceCode` are pulled out as identifier inputs. Describing-value
 * warnings are collected, never thrown.
 */
function assembleRow(
  rowNumber: number,
  columns: Record<string, string>,
  bindings: ProfileBindings,
  carry: Map<string, string | null>,
  warnings: ValidationWarning[],
): AssembledRow {
  const record: Record<string, unknown> = {};
  const legacyIds: { provider: string; id: string }[] = [];
  let referenceCode: string | null = null;
  let parentReferenceCode: string | null = null;

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    const spec = binding.transform ?? { kind: "direct" as const };
    // Carry state is per BINDING (index-keyed): several bindings may share
    // the `legacyIds` target, and each column inherits from its own row above.
    const carryKey = String(i);
    const context: RowContext = { previousValue: carry.get(carryKey) ?? null };
    const outcome = applyTransform(spec, { value: columns[binding.source], columns }, context);

    for (const warning of outcome.warnings) {
      warnings.push({
        rowNumber,
        code: warning.code,
        message: warning.message,
        detail: warning.detail,
      });
    }

    const value: TransformValue = outcome.value;

    // Carry-forward threads the resolved STRING value into the next row.
    if (typeof value === "string") carry.set(carryKey, value === "" ? null : value);

    if (binding.target === REQUIRED_TARGET) {
      referenceCode = typeof value === "string" ? (clean(value) || null) : null;
      if (typeof value === "string") record[REQUIRED_TARGET] = clean(value);
      continue;
    }
    if (binding.target === "parent") {
      parentReferenceCode = typeof value === "string" ? (clean(value) || null) : null;
      continue;
    }
    if (binding.target === "legacyIds") {
      const id = typeof value === "string" ? clean(value) : "";
      if (id !== "") legacyIds.push({ provider: legacyIdProviderFor(binding), id });
      continue;
    }
    if (isDateResult(value)) {
      if (value.dateStart !== null) record.dateStart = value.dateStart;
      if (value.dateEnd !== null) record.dateEnd = value.dateEnd;
      if (value.dateCertainty !== "") record.dateCertainty = value.dateCertainty;
      if (value.dateExpression !== "") record.dateExpression = value.dateExpression;
      continue;
    }
    // A plain string target — a BLANK transformed value assigns nothing:
    // blank means keep on update, absent on create (never overwrite a
    // populated field or a schema default with ""). Blank cells are the
    // norm in sparse archival CSVs, so no per-cell warning is emitted.
    if (
      typeof value === "string" &&
      value !== "" &&
      !STRUCTURAL_TARGET_SET.has(binding.target)
    ) {
      record[binding.target] = value;
    }
  }

  // `legacyIds` lands on the record ONLY when the profile binds it: an
  // unbound profile must leave an existing row's archived identifiers
  // untouched, and a serialised "[]" here would wipe them on update.
  if (bindings.some((b) => b.target === "legacyIds")) {
    record.legacyIds = JSON.stringify(legacyIds);
  }
  return { rowNumber, referenceCode, parentReferenceCode, record };
}

/**
 * Pick the primary reject reason and named fields from a failed Zod parse.
 * Precedence: an over-length value (never truncated) outranks a missing
 * required field, which outranks a bad level, which outranks anything else
 * — so the report's single reason is the most actionable one.
 */
function classifyZodFailure(
  error: z.ZodError,
): { reason: RejectReason; detail: Record<string, unknown> } {
  const fields = error.issues.map((i) => String(i.path[0] ?? "")).filter(Boolean);
  // The required-field gaps specifically (`field_required` token, factory) —
  // surfaced separately so the reason names the missing fields (design §5)
  // and the readiness check aggregates them by class (design §3.2).
  const requiredMissing = [
    ...new Set(
      error.issues
        .filter((i) => i.message === "field_required")
        .map((i) => String(i.path[0] ?? ""))
        .filter(Boolean),
    ),
  ];
  const detail = { fields: [...new Set(fields)], requiredMissing };
  if (error.issues.some((i) => i.code === "too_big")) {
    return { reason: "value_too_long", detail };
  }
  if (error.issues.some((i) => i.message === "field_required")) {
    return { reason: "missing_required_field", detail };
  }
  if (error.issues.some((i) => String(i.path[0]) === "descriptionLevel")) {
    return { reason: "invalid_description_level", detail };
  }
  return { reason: "invalid_field", detail };
}

/**
 * Extract the resolved reference code per row without full assembly — the
 * runner needs the codes to batch its D1 existence read before it can
 * classify create vs update. Runs only the reference-code binding's
 * transform (carry-forward threaded), so a code resolved here matches the
 * code the full pipeline resolves.
 */
export function extractReferenceCodes(
  input: Pick<ValidateInput, "bindings" | "headers" | "rows">,
): string[] {
  return extractBoundValues(input, REQUIRED_TARGET);
}

/**
 * Extract the resolved PARENT reference code per row, the same way
 * `extractReferenceCodes` extracts the row's own code. The runner adds
 * these to its existence query so an "items into an existing container"
 * import (spec §6) can resolve a parent that lives in the database rather
 * than in the file — otherwise the parent would look unresolvable and the
 * child would reject. Empty when the profile declares no `parent` binding.
 */
export function extractParentReferenceCodes(
  input: Pick<ValidateInput, "bindings" | "headers" | "rows">,
): string[] {
  return extractBoundValues(input, "parent");
}

/** Resolve one binding target's value per row (carry-forward threaded). */
function extractBoundValues(
  input: Pick<ValidateInput, "bindings" | "headers" | "rows">,
  target: string,
): string[] {
  const binding = input.bindings.find((b) => b.target === target);
  const values: string[] = [];
  if (!binding) return values;
  let previous: string | null = null;
  for (const row of input.rows) {
    const columns = toColumns(input.headers, row);
    const outcome = applyTransform(
      binding.transform ?? { kind: "direct" },
      { value: columns[binding.source], columns },
      { previousValue: previous },
    );
    const value = typeof outcome.value === "string" ? clean(outcome.value) : "";
    if (value !== "") {
      values.push(value);
      previous = value;
    }
  }
  return [...new Set(values)];
}

function toColumns(
  headers: readonly string[],
  row: readonly string[],
): Record<string, string> {
  const columns: Record<string, string> = {};
  headers.forEach((header, index) => {
    if (!(header in columns)) columns[header] = row[index] ?? "";
  });
  return columns;
}

/**
 * Run the full validation pipeline. Returns per-row verdicts, accumulated
 * describing-value warnings, and the header-binding report. Every count a
 * report derives comes from these verdicts — there is no separate recount.
 */
export function validate(input: ValidateInput): ValidateResult {
  const warnings: ValidationWarning[] = [];
  const headerBinding = bindHeaders(input.headers, input.bindings);
  const acceptedClasses = input.acceptedClasses ?? new Set<string>();

  const repositoryId = input.defaults?.repositoryId ?? PLACEHOLDER_REPOSITORY_ID;

  // Pass 1 — assemble every row in file order (carry-forward is a file-order
  // concern, so a later reject never changes an earlier carry).
  const carry = new Map<string, string | null>();
  const assembled: AssembledRow[] = [];
  input.rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const columns = toColumns(input.headers, row);
    assembled.push(
      assembleRow(rowNumber, columns, input.bindings, carry, warnings),
    );
  });

  // Pass 2 — identifier discipline over the resolved codes.
  const identifier = resolveIdentifiers(
    assembled.map((a) => ({
      rowNumber: a.rowNumber,
      referenceCode: a.referenceCode,
      parentReferenceCode: a.parentReferenceCode,
    })),
    input.existingReferenceCodes,
  );

  const verdicts: RowVerdict[] = [];
  for (const reject of identifier.rejects) {
    verdicts.push({
      rowNumber: reject.rowNumber,
      referenceCode: reject.referenceCode,
      verdict: "reject",
      reason: reject.reason,
      detail: reject.detail,
    });
  }

  const assembledByRow = new Map(assembled.map((a) => [a.rowNumber, a]));

  // Pass 3 — descriptive-standard validation, then create/update/skip
  // classification, over the topologically ordered survivors. Topological
  // order makes the parent cascade a single pass: a row whose IN-FILE
  // parent has already landed in `rejectedCodes` — for ANY reason,
  // including a validation reject this pass produced — is itself rejected
  // (`parent_rejected`), because its container will never be created; and
  // its own code joins the set, so the cascade is transitive. A `skip`
  // parent does NOT cascade: it exists in the database already.
  const rejectedCodes = new Set<string>();
  const rowValidation: ValidateResult["rowValidation"] = [];
  for (const resolved of identifier.ordered) {
    const row = assembledByRow.get(resolved.rowNumber)!;

    const record: Record<string, unknown> = {
      id: PLACEHOLDER_ID,
      repositoryId,
      ...row.record,
    };

    const rawLevel = typeof record.descriptionLevel === "string" ? record.descriptionLevel : "";
    const level: DescriptionLevel = isDescriptionLevel(rawLevel) ? rawLevel : "item";

    // The Zod parse runs for EVERY resolved row, before the cascade check —
    // so a row's INTRINSIC required-field gaps are recorded even when its
    // final verdict is `parent_rejected` (a cascade of its container's own
    // gap). The readiness check reads these to surface a row's own decision
    // class independently of the cascade (design §3.2), while the verdict
    // below still cascades as before.
    const parsed = descriptionValidatorFor(input.standard, level).safeParse(record);
    const requiredMissing: string[] = [];
    let otherInvalid = false;
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.message === "field_required") {
          const field = String(issue.path[0] ?? "");
          if (field !== "") requiredMissing.push(field);
        } else {
          otherInvalid = true;
        }
      }
    }
    const uniqueRequiredMissing = [...new Set(requiredMissing)];
    rowValidation.push({
      rowNumber: resolved.rowNumber,
      level,
      requiredMissing: uniqueRequiredMissing,
      otherInvalid,
    });

    if (
      resolved.parentSource === "in_file" &&
      resolved.parentReferenceCode !== null &&
      rejectedCodes.has(resolved.parentReferenceCode)
    ) {
      rejectedCodes.add(resolved.referenceCode);
      verdicts.push({
        rowNumber: resolved.rowNumber,
        referenceCode: resolved.referenceCode,
        verdict: "reject",
        reason: "parent_rejected",
        detail: { parentReferenceCode: resolved.parentReferenceCode },
      });
      continue;
    }

    if (!parsed.success) {
      // Acceptance relief (design §4): a row failing ONLY on accepted
      // required-field classes is created honestly sparse, its accepted
      // classes tallied as warnings — not rejected, so its descendants do
      // not inherit `parent_rejected`. Anything else rejects, naming the
      // missing fields and the level.
      const degradable =
        !otherInvalid &&
        uniqueRequiredMissing.length > 0 &&
        uniqueRequiredMissing.every((f) =>
          acceptedClasses.has(`missing_required_field:${level}:${f}`),
        );
      if (!degradable) {
        const { reason, detail } = classifyZodFailure(parsed.error);
        rejectedCodes.add(resolved.referenceCode);
        verdicts.push({
          rowNumber: resolved.rowNumber,
          referenceCode: resolved.referenceCode,
          verdict: "reject",
          reason,
          detail: { ...detail, level },
        });
        continue;
      }
      for (const field of uniqueRequiredMissing) {
        warnings.push({
          rowNumber: resolved.rowNumber,
          code: "accepted_missing_required",
          message: `Required field '${field}' is missing but its class was accepted; the record is imported without it.`,
          detail: { level, field },
        });
      }
      // Fall through to create/update classification with the sparse record.
    }

    const exists = input.existingReferenceCodes.has(resolved.referenceCode);
    const verdict: Verdict = exists ? (input.updateExisting ? "update" : "skip") : "create";

    // Never-re-parent divergence surfacing: an update row whose CSV parent
    // differs from the record's CURRENT parent is warned by name — the row
    // still updates its descriptive fields, but it is not re-filed, and the
    // operator must see which rows kept their parent. A blank CSV parent is
    // NOT a divergence (blank means keep, matching the field rule above).
    if (
      verdict === "update" &&
      input.existingParents !== undefined &&
      resolved.parentReferenceCode !== null
    ) {
      const currentParent = input.existingParents.get(resolved.referenceCode);
      if (currentParent !== undefined && currentParent !== resolved.parentReferenceCode) {
        warnings.push({
          rowNumber: resolved.rowNumber,
          code: "parent_change_ignored",
          message:
            "The file gives this record a different parent; imports never re-file existing records — the current parent is kept.",
          detail: {
            currentParent,
            fileParent: resolved.parentReferenceCode,
          },
        });
      }
    }

    verdicts.push({
      rowNumber: resolved.rowNumber,
      referenceCode: resolved.referenceCode,
      verdict,
      record,
    });
  }

  verdicts.sort((a, b) => a.rowNumber - b.rowNumber);
  const rowIdentifiers = assembled.map((a) => ({
    rowNumber: a.rowNumber,
    referenceCode: a.referenceCode,
    parentReferenceCode: a.parentReferenceCode,
  }));
  return {
    verdicts,
    warnings,
    headerBinding,
    ordered: identifier.ordered,
    rowIdentifiers,
    rowValidation,
  };
}
