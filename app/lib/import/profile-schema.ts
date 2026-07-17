/**
 * Import profile bindings — the Zod shape stored in import_profiles.bindings
 *
 * This module deals with the JSON contract behind a mapping profile: an
 * array of bindings, each pairing a source CSV HEADER NAME (never a
 * positional index — the N2-TSV column-shift incident, spec §2) to a
 * target description field, with an optional transform. The transform
 * schema mirrors the `TransformSpec` union in `./transforms` field for
 * field; the two `satisfies` assertions below fail the typecheck if
 * either side drifts, and `transform-spec-parity` unit-tests the same
 * invariant at runtime.
 *
 * The schema validates STRUCTURE only — a source and target are
 * non-empty, the transform is well-formed, at least one binding exists,
 * targets are unique, and a `referenceCode` binding is present (spec §2,
 * §3). It is deliberately standard-agnostic: whether a target column is
 * legal for the tenant's descriptive standard is a separate check
 * (`isValidTarget` in `./target-fields`) applied at the mapping surface,
 * because the stored JSON outlives any single standard's field list.
 *
 * @version v0.6.0
 */

import { z } from "zod/v4";
import type { TransformSpec } from "./transforms";
import { REQUIRED_TARGET } from "./target-fields";

// One transform schema per member of the TransformSpec union, in the
// same order. `parts` is `.readonly()` so its inferred type matches
// `readonly ConcatenatePart[]` exactly (both assignment directions).
const directSchema = z.object({ kind: z.literal("direct") });

const defaultWhenBlankSchema = z.object({
  kind: z.literal("defaultWhenBlank"),
  default: z.string(),
});

const constantSchema = z.object({
  kind: z.literal("constant"),
  value: z.string(),
});

const concatenatePartSchema = z.object({
  column: z.string(),
  label: z.string().optional(),
});

const concatenateSchema = z.object({
  kind: z.literal("concatenate"),
  parts: z.array(concatenatePartSchema).readonly(),
  separator: z.string().optional(),
});

const splitRejoinSchema = z.object({
  kind: z.literal("splitRejoin"),
  inputSeparator: z.string().optional(),
  outputSeparator: z.string().optional(),
});

const dateSchema = z.object({
  kind: z.literal("date"),
  yearMin: z.number().optional(),
  yearMax: z.number().optional(),
  dayFirst: z.boolean().optional(),
});

const vocabularySchema = z.object({
  kind: z.literal("vocabulary"),
  mapping: z.record(z.string(), z.string()),
  default: z.string(),
  caseInsensitive: z.boolean().optional(),
});

const carryForwardSchema = z.object({ kind: z.literal("carryForward") });

export const transformSpecSchema = z.discriminatedUnion("kind", [
  directSchema,
  defaultWhenBlankSchema,
  constantSchema,
  concatenateSchema,
  splitRejoinSchema,
  dateSchema,
  vocabularySchema,
  carryForwardSchema,
]);

/** The inferred transform type — kept in lockstep with `TransformSpec`. */
export type ProfileTransform = z.infer<typeof transformSpecSchema>;

// Type-level drift guards: each direction of assignability must hold,
// so the Zod schema and the hand-written union are structurally equal.
// A missing member, a renamed field, or a changed optionality breaks
// one of these at `tsc` time.
const _schemaSatisfiesUnion = {} as ProfileTransform satisfies TransformSpec;
const _unionSatisfiesSchema = {} as TransformSpec satisfies ProfileTransform;
void _schemaSatisfiesUnion;
void _unionSatisfiesSchema;

export const profileBindingSchema = z.object({
  /** Source CSV header name — matched by name, never by position. */
  source: z.string().trim().min(1),
  /** Target description field (validated against the standard elsewhere). */
  target: z.string().trim().min(1),
  /** Optional transform; absent means a direct copy at apply time. */
  transform: transformSpecSchema.optional(),
  /**
   * Provider tag for `legacyIds` bindings — the source-system identity
   * each entry carries (e.g. `atom`, `former-reference-geiger`). Absent
   * means a slug of the source header; meaningless on other targets.
   */
  provider: z.string().trim().min(1).optional(),
});

export type ProfileBinding = z.infer<typeof profileBindingSchema>;

/**
 * The stored bindings array. Profile-level invariants ride here so an
 * invalid mapping can never be persisted: at least one binding, no two
 * bindings writing the same target — EXCEPT `legacyIds`, which several
 * source columns may feed (each entry keeps its own provider tag, so
 * multiple former-reference columns coexist) — and a required
 * `referenceCode` binding (rows resolve strictly by reference code,
 * spec §3).
 */
export const profileBindingsSchema = z
  .array(profileBindingSchema)
  .min(1, { message: "at_least_one_binding" })
  .check((ctx) => {
    const bindings = ctx.value;
    const seen = new Set<string>();
    for (let i = 0; i < bindings.length; i++) {
      const target = bindings[i].target;
      if (seen.has(target) && target !== "legacyIds") {
        ctx.issues.push({
          code: "custom",
          message: "duplicate_target",
          path: [i, "target"],
          input: target,
        });
      }
      seen.add(target);
    }
    if (!seen.has(REQUIRED_TARGET)) {
      ctx.issues.push({
        code: "custom",
        message: "reference_code_binding_required",
        path: [],
        input: bindings,
      });
    }
  });

export type ProfileBindings = z.infer<typeof profileBindingsSchema>;

/**
 * Parse and validate a bindings payload (already JSON-parsed). Returns
 * the Zod result so callers can surface field-level issues in the
 * report/UI without re-implementing the invariants.
 */
export function parseProfileBindings(input: unknown) {
  return profileBindingsSchema.safeParse(input);
}
