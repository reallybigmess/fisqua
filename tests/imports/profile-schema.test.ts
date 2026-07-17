/**
 * Tests — profile bindings schema + TransformSpec parity
 *
 * This suite pins the Zod contract for `import_profiles.bindings`: the
 * transform schema accepts exactly the `TransformSpec` union members
 * (the runtime backstop to the type-level `satisfies` guards), and the
 * profile-level invariants hold — at least one binding, unique targets,
 * a required `referenceCode` binding, and header-name (not positional)
 * sources.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  transformSpecSchema,
  profileBindingsSchema,
  parseProfileBindings,
} from "../../app/lib/import/profile-schema";
import type { TransformSpec } from "../../app/lib/import/transforms";

const ALL_TRANSFORMS: TransformSpec[] = [
  { kind: "direct" },
  { kind: "defaultWhenBlank", default: "n/a" },
  { kind: "constant", value: "file" },
  { kind: "concatenate", parts: [{ column: "a", label: "A" }, { column: "b" }], separator: "; " },
  { kind: "splitRejoin", inputSeparator: "|", outputSeparator: ", " },
  { kind: "date", yearMin: 1500, yearMax: 2000, dayFirst: false },
  { kind: "vocabulary", mapping: { expediente: "file" }, default: "file", caseInsensitive: true },
  { kind: "carryForward" },
];

describe("transformSpecSchema parity", () => {
  it("accepts every TransformSpec union member", () => {
    for (const spec of ALL_TRANSFORMS) {
      const parsed = transformSpecSchema.safeParse(spec);
      expect(parsed.success, `kind ${spec.kind} should parse`).toBe(true);
    }
  });

  it("accepts the minimal forms (no optional params)", () => {
    expect(transformSpecSchema.safeParse({ kind: "concatenate", parts: [] }).success).toBe(true);
    expect(transformSpecSchema.safeParse({ kind: "splitRejoin" }).success).toBe(true);
    expect(transformSpecSchema.safeParse({ kind: "date" }).success).toBe(true);
    expect(transformSpecSchema.safeParse({ kind: "vocabulary", mapping: {}, default: "x" }).success).toBe(true);
  });

  it("rejects an unknown transform kind", () => {
    expect(transformSpecSchema.safeParse({ kind: "truncate" }).success).toBe(false);
  });

  it("rejects a transform missing a required field", () => {
    // defaultWhenBlank requires `default`.
    expect(transformSpecSchema.safeParse({ kind: "defaultWhenBlank" }).success).toBe(false);
    // vocabulary requires `default`.
    expect(transformSpecSchema.safeParse({ kind: "vocabulary", mapping: {} }).success).toBe(false);
    // constant requires `value`.
    expect(transformSpecSchema.safeParse({ kind: "constant" }).success).toBe(false);
  });
});

describe("profileBindingsSchema", () => {
  const ref = { source: "identifier", target: "referenceCode" };

  it("accepts a valid bindings array", () => {
    const out = profileBindingsSchema.safeParse([
      ref,
      { source: "title", target: "title", transform: { kind: "direct" } },
      { source: "eventStartDates", target: "dateStart", transform: { kind: "date" } },
    ]);
    expect(out.success).toBe(true);
  });

  it("requires at least one binding", () => {
    const out = profileBindingsSchema.safeParse([]);
    expect(out.success).toBe(false);
    expect(out.success === false && out.error.issues.some((i) => i.message === "at_least_one_binding")).toBe(true);
  });

  it("requires a referenceCode binding", () => {
    const out = profileBindingsSchema.safeParse([{ source: "title", target: "title" }]);
    expect(out.success).toBe(false);
    expect(
      out.success === false &&
        out.error.issues.some((i) => i.message === "reference_code_binding_required"),
    ).toBe(true);
  });

  it("rejects duplicate target fields", () => {
    const out = profileBindingsSchema.safeParse([
      ref,
      { source: "title", target: "title" },
      { source: "uniformTitle", target: "title" },
    ]);
    expect(out.success).toBe(false);
    expect(out.success === false && out.error.issues.some((i) => i.message === "duplicate_target")).toBe(true);
  });

  it("rejects a blank source (header name required)", () => {
    const out = parseProfileBindings([ref, { source: "  ", target: "title" }]);
    expect(out.success).toBe(false);
  });

  it("allows SEVERAL bindings targeting legacyIds (the one duplicate-target exemption)", () => {
    const out = profileBindingsSchema.safeParse([
      ref,
      { source: "Former_Reference_Geiger", target: "legacyIds" },
      { source: "Former_Reference_Engelhardt", target: "legacyIds", provider: "zephyrin" },
    ]);
    expect(out.success).toBe(true);
  });

  it("accepts an optional provider on a binding and rejects a blank one", () => {
    expect(
      profileBindingsSchema.safeParse([
        ref,
        { source: "legacyId", target: "legacyIds", provider: "atom" },
      ]).success,
    ).toBe(true);
    expect(
      profileBindingsSchema.safeParse([
        ref,
        { source: "legacyId", target: "legacyIds", provider: "  " },
      ]).success,
    ).toBe(false);
  });
});
