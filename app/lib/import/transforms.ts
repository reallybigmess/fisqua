/**
 * Import transform catalogue — the pure-function core
 *
 * This module deals with the declarative column transforms a mapping
 * profile binds to description fields: direct copy, default-when-blank,
 * constant (a fixed value regardless of the source cell — for fields
 * that are structural properties of a format rather than columns in it),
 * labelled concatenation, split-and-rejoin of pipe-delimited multi-values,
 * the parameterized date transform (delegated to `./date-parser`),
 * controlled-vocabulary remap, and carry-forward inheritance. Each is a
 * pure function of the raw cell value(s) and a small row context; none
 * touch the database, the network, or any I/O.
 *
 * The asymmetry rule is enforced here: a describing-value problem
 * (unrecognised vocabulary, an unparseable date, a missing concatenation
 * column) degrades to a safe result and reports a STRUCTURED warning in
 * the return — it is never logged, never thrown. Identifier resolution is
 * a separate, rejecting concern and is not part of this slice.
 *
 * Truncation is never a transform: over-length values are a downstream
 * validation reject, so nothing here silently shortens a value.
 *
 * @version v0.6.0
 */

import {
  parseDateExpression,
  type DateParseResult,
} from "./date-parser";

export interface DirectTransform {
  kind: "direct";
}

export interface DefaultWhenBlankTransform {
  kind: "defaultWhenBlank";
  /** Substituted verbatim when the source value is blank. */
  default: string;
}

export interface ConstantTransform {
  kind: "constant";
  /**
   * Emitted verbatim for every row, whatever the source cell holds. The
   * honest mechanism for fields that are STRUCTURAL properties of a
   * format rather than columns in it (e.g. an inventory format whose
   * rows are all one description level): the binding's source column
   * exists only to satisfy the header contract and is never read.
   */
  value: string;
}

export interface ConcatenatePart {
  /** Source CSV header name to pull from the row's columns. */
  column: string;
  /** Optional label rendered as `"<label>: <value>"`. */
  label?: string;
}

export interface ConcatenateTransform {
  kind: "concatenate";
  parts: readonly ConcatenatePart[];
  /** Separator between non-empty parts (default newline). */
  separator?: string;
}

export interface SplitRejoinTransform {
  kind: "splitRejoin";
  /** Delimiter to split on (default `"|"`). */
  inputSeparator?: string;
  /** Delimiter to rejoin with (default `", "`). */
  outputSeparator?: string;
}

export interface DateTransform {
  kind: "date";
  /** Lowest acceptable year (default 1000). */
  yearMin?: number;
  /** Highest acceptable year (default 2100). */
  yearMax?: number;
  /**
   * Interpret numeric `NN-NN-YYYY` dates day-first (default true, the
   * parser's convention). US-style month-first sources — SBMAL's
   * `2/4/1640` means February 4 — set false.
   */
  dayFirst?: boolean;
}

export interface VocabularyTransform {
  kind: "vocabulary";
  /** Recognised source value -> canonical target value. */
  mapping: Record<string, string>;
  /** Returned when a non-blank value is not in `mapping`. */
  default: string;
  /** Match keys case-insensitively (default true). */
  caseInsensitive?: boolean;
}

export interface CarryForwardTransform {
  kind: "carryForward";
}

export type TransformSpec =
  | DirectTransform
  | DefaultWhenBlankTransform
  | ConstantTransform
  | ConcatenateTransform
  | SplitRejoinTransform
  | DateTransform
  | VocabularyTransform
  | CarryForwardTransform;

export type TransformWarningCode =
  | "missing_source_column"
  | "separator_collision"
  | "unknown_vocabulary"
  | "unparseable_date"
  | "uncertain_date"
  | "date_day_clamped"
  | "reversed_date_range"
  | "ambiguous_day_month"
  | "carry_forward_no_predecessor";

export interface TransformWarning {
  code: TransformWarningCode;
  message: string;
  detail?: Record<string, unknown>;
}

/** A transform's output: a string, or the structured date result. */
export type TransformValue = string | DateParseResult;

export interface TransformResult {
  value: TransformValue;
  warnings: TransformWarning[];
}

/** The raw cell input for one binding on one row. */
export interface TransformRaw {
  /** The value of the binding's own source column. */
  value: string | null | undefined;
  /**
   * The full row keyed by CSV header name. Required by `concatenate`
   * (which reads several columns); optional for single-column transforms.
   */
  columns?: Record<string, string | null | undefined>;
}

/** Per-row context threaded across rows for stateful transforms. */
export interface RowContext {
  /** The value `carryForward` produced for the previous row, if any. */
  previousValue?: string | null;
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function direct(raw: TransformRaw): TransformResult {
  return { value: clean(raw.value), warnings: [] };
}

function defaultWhenBlank(
  spec: DefaultWhenBlankTransform,
  raw: TransformRaw
): TransformResult {
  return {
    value: isBlank(raw.value) ? spec.default : clean(raw.value),
    warnings: [],
  };
}

function constant(spec: ConstantTransform): TransformResult {
  // The source cell is never read; the spec's value IS the result.
  return { value: spec.value, warnings: [] };
}

function concatenate(
  spec: ConcatenateTransform,
  raw: TransformRaw
): TransformResult {
  const separator = spec.separator ?? "\n";
  const columns = raw.columns ?? {};
  const warnings: TransformWarning[] = [];
  const pieces: string[] = [];

  for (const part of spec.parts) {
    if (!(part.column in columns)) {
      warnings.push({
        code: "missing_source_column",
        message: `Column "${part.column}" referenced by concatenate is not present in the row`,
        detail: { column: part.column },
      });
      continue;
    }
    const value = clean(columns[part.column]);
    if (value === "") continue;
    pieces.push(part.label ? `${part.label}: ${value}` : value);
  }

  return { value: pieces.join(separator), warnings };
}

function splitRejoin(
  spec: SplitRejoinTransform,
  raw: TransformRaw
): TransformResult {
  const inputSeparator = spec.inputSeparator ?? "|";
  const outputSeparator = spec.outputSeparator ?? ", ";
  const warnings: TransformWarning[] = [];

  const value = clean(raw.value);
  if (value === "") return { value: "", warnings };

  const segments = value
    .split(inputSeparator)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");

  // A segment that already contains the output separator makes the
  // rejoined boundaries ambiguous — report it (skip when the separator
  // is whitespace-only, which would fire on every multi-word segment).
  if (
    outputSeparator.trim() !== "" &&
    segments.some((segment) => segment.includes(outputSeparator))
  ) {
    warnings.push({
      code: "separator_collision",
      message: `A value segment already contains the output separator "${outputSeparator}"; rejoined boundaries are ambiguous`,
      detail: { outputSeparator },
    });
  }

  return { value: segments.join(outputSeparator), warnings };
}

function date(spec: DateTransform, raw: TransformRaw): TransformResult {
  const outcome = parseDateExpression(raw.value, {
    yearMin: spec.yearMin,
    yearMax: spec.yearMax,
    dayFirst: spec.dayFirst,
  });
  return {
    value: outcome.result,
    warnings: outcome.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      detail: warning.detail,
    })),
  };
}

function vocabulary(
  spec: VocabularyTransform,
  raw: TransformRaw
): TransformResult {
  // Blank is absence, not an unrecognised value — no warning.
  if (isBlank(raw.value)) return { value: spec.default, warnings: [] };

  const value = clean(raw.value);
  const caseInsensitive = spec.caseInsensitive ?? true;

  let mapped: string | undefined;
  if (caseInsensitive) {
    const target = value.toLowerCase();
    const entry = Object.entries(spec.mapping).find(
      ([key]) => key.toLowerCase() === target
    );
    mapped = entry?.[1];
  } else {
    mapped = spec.mapping[value];
  }

  if (mapped === undefined) {
    return {
      value: spec.default,
      warnings: [
        {
          code: "unknown_vocabulary",
          message: `Unrecognised value "${value}" mapped to default "${spec.default}"`,
          detail: { value, default: spec.default },
        },
      ],
    };
  }

  return { value: mapped, warnings: [] };
}

function carryForward(
  raw: TransformRaw,
  context: RowContext
): TransformResult {
  if (!isBlank(raw.value)) return { value: clean(raw.value), warnings: [] };

  const previous = context.previousValue;
  if (isBlank(previous)) {
    return {
      value: "",
      warnings: [
        {
          code: "carry_forward_no_predecessor",
          message:
            "Blank value with no previous row value to inherit from",
          detail: {},
        },
      ],
    };
  }

  return { value: clean(previous), warnings: [] };
}

function assertNever(spec: never): never {
  throw new Error(
    `Unhandled transform kind: ${(spec as { kind?: string }).kind}`
  );
}

/**
 * Apply one transform to one row's raw cell value(s).
 *
 * `raw` carries the binding's own value (and, for `concatenate`, the full
 * row); `context` carries the previous row's resolved value for
 * `carryForward`. Returns the resolved value plus any structured warnings;
 * describing-value degradations surface here and are never thrown.
 */
export function applyTransform(
  spec: TransformSpec,
  raw: TransformRaw,
  context: RowContext = {}
): TransformResult {
  switch (spec.kind) {
    case "direct":
      return direct(raw);
    case "defaultWhenBlank":
      return defaultWhenBlank(spec, raw);
    case "constant":
      return constant(spec);
    case "concatenate":
      return concatenate(spec, raw);
    case "splitRejoin":
      return splitRejoin(spec, raw);
    case "date":
      return date(spec, raw);
    case "vocabulary":
      return vocabulary(spec, raw);
    case "carryForward":
      return carryForward(raw, context);
    default:
      return assertNever(spec);
  }
}
