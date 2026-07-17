/**
 * Profile editor state — lossless binding <-> row translation
 *
 * This module deals with the pure state helpers behind the mapping
 * surface. The load-bearing invariant: a load-then-save round-trip is
 * LOSSLESS for every transform kind. An `EditorRow` therefore carries
 * the ORIGINAL `ProfileTransform` object verbatim — never a flattened
 * projection — and the edit helpers overwrite only the field the UI
 * actually edited, preserving everything else (`vocabulary.mapping` and
 * `caseInsensitive`, `concatenate` part labels and separator,
 * `splitRejoin` separators, `date` year bounds). A name-only save must
 * serialize back byte-identical bindings.
 *
 * Changing a row's transform KIND deliberately builds a minimal fresh
 * spec: the operator chose a different transform, so the old kind's
 * parameters do not carry over.
 *
 * Every function here is pure; the route component owns React state and
 * the persistence call.
 *
 * @version v0.6.0
 */

import type { ProfileBinding, ProfileTransform } from "./profile-schema";

/** The transform-kind values the picker offers ("none" = no transform). */
export const EDITOR_TRANSFORM_KINDS = [
  "none",
  "direct",
  "defaultWhenBlank",
  "constant",
  "splitRejoin",
  "date",
  "vocabulary",
  "concatenate",
  "carryForward",
] as const;

export type EditorTransformKind = (typeof EDITOR_TRANSFORM_KINDS)[number];

export interface EditorRow {
  source: string;
  target: string;
  /** The full transform spec, carried verbatim; absent = direct copy. */
  transform?: ProfileTransform;
  /** The legacyIds provider tag, carried verbatim (lossless round-trip). */
  provider?: string;
}

/** Kinds whose primary parameter is editable in the inline param input. */
export const PARAM_KINDS: ReadonlySet<EditorTransformKind> = new Set([
  "defaultWhenBlank",
  "constant",
  "vocabulary",
  "concatenate",
]);

/** Rows from a stored bindings JSON string; one empty row when unusable. */
export function rowsFromBindings(json: string | null | undefined): EditorRow[] {
  if (json) {
    try {
      const parsed = JSON.parse(json) as ProfileBinding[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((b) => ({
          source: b.source,
          target: b.target,
          transform: b.transform,
          provider: b.provider,
        }));
      }
    } catch {
      /* fall through to a single empty row */
    }
  }
  return [emptyRow()];
}

/** Bindings from rows, dropping rows that are not yet filled in. */
export function bindingsFromRows(rows: EditorRow[]): ProfileBinding[] {
  const bindings: ProfileBinding[] = [];
  for (const row of rows) {
    const source = row.source.trim();
    const target = row.target.trim();
    if (source === "" || target === "") continue;
    const binding: ProfileBinding = { source, target };
    if (row.transform) binding.transform = row.transform;
    if (row.provider) binding.provider = row.provider;
    bindings.push(binding);
  }
  return bindings;
}

export function emptyRow(): EditorRow {
  return { source: "", target: "" };
}

/** The picker value for a row's current transform. */
export function kindOfRow(row: EditorRow): EditorTransformKind {
  return row.transform?.kind ?? "none";
}

/** The inline param input's display value, per kind. */
export function paramOfRow(row: EditorRow): string {
  const t = row.transform;
  if (!t) return "";
  switch (t.kind) {
    case "defaultWhenBlank":
      return t.default;
    case "constant":
      return t.value;
    case "vocabulary":
      return t.default;
    case "concatenate":
      return t.parts.map((p) => p.column).join(", ");
    default:
      return "";
  }
}

/**
 * A row with its transform KIND changed. Builds a minimal spec for the
 * new kind (an explicit kind switch does not inherit the old kind's
 * parameters); "none" clears the transform entirely.
 */
export function withKind(row: EditorRow, kind: EditorTransformKind): EditorRow {
  const base = { source: row.source, target: row.target };
  switch (kind) {
    case "none":
      return base;
    case "direct":
      return { ...base, transform: { kind: "direct" } };
    case "defaultWhenBlank":
      return { ...base, transform: { kind: "defaultWhenBlank", default: "" } };
    case "constant":
      return { ...base, transform: { kind: "constant", value: "" } };
    case "splitRejoin":
      return { ...base, transform: { kind: "splitRejoin" } };
    case "date":
      return { ...base, transform: { kind: "date" } };
    case "vocabulary":
      return { ...base, transform: { kind: "vocabulary", mapping: {}, default: "" } };
    case "concatenate":
      return { ...base, transform: { kind: "concatenate", parts: [] } };
    case "carryForward":
      return { ...base, transform: { kind: "carryForward" } };
  }
}

/**
 * A row with its inline PARAM edited. Merges into the existing spec,
 * preserving every field the input does not represent:
 * `vocabulary.mapping` / `caseInsensitive`, `concatenate.separator`,
 * and — for concatenate columns that keep their names — their labels.
 * Kinds without an inline param return the row unchanged.
 */
export function withParam(row: EditorRow, param: string): EditorRow {
  const t = row.transform;
  if (!t) return row;
  switch (t.kind) {
    case "defaultWhenBlank":
      return { ...row, transform: { ...t, default: param } };
    case "constant":
      return { ...row, transform: { ...t, value: param } };
    case "vocabulary":
      return { ...row, transform: { ...t, default: param } };
    case "concatenate": {
      const names = param
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      const parts = names.map(
        (column) => t.parts.find((p) => p.column === column) ?? { column },
      );
      return { ...row, transform: { ...t, parts } };
    }
    default:
      return row;
  }
}
