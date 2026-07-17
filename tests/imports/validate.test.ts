/**
 * Tests - import validation pipeline (spec section 4)
 *
 * Pure orchestration over the landed pieces: header binding (unbound
 * bindings + unrecognised headers named), per-row transforms, identifier
 * discipline, the tenant's descriptive-standard Zod validator, and
 * create/update/skip classification against existing reference codes. The
 * asymmetry rule is pinned both ways: an identifier failure REJECTS, an
 * unrecognised describing value DEGRADES to a warning. Over-length values
 * reject rather than truncate; source identifiers land in `legacyIds` with
 * per-column providers; a row whose in-file parent was rejected for ANY
 * reason - identifier or validation - cascades to `parent_rejected`.
 *
 * Fixtures use the verbatim SBMAL DACS headers and REAL SBMAL rows (the
 * consecutive run CMD 1 .. CMD 6, including 3a and 5a).
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { parseCsv } from "../../app/lib/import/csv";
import {
  validate,
  extractReferenceCodes,
  legacyIdProviderFor,
} from "../../app/lib/import/validate";
import { parseProfileBindings } from "../../app/lib/import/profile-schema";
import {
  makeSbmalCsv,
  SBMAL_REAL_ROWS,
  SBMAL_REAL_CODES,
  SBMAL_DACS_BINDINGS,
} from "./fixtures";

function bindings(extra: any[] = []) {
  const parsed = parseProfileBindings([...SBMAL_DACS_BINDINGS, ...extra]);
  if (!parsed.success) throw new Error("fixture bindings invalid: " + JSON.stringify(parsed.error.issues));
  return parsed.data;
}

function parse(rows = SBMAL_REAL_ROWS, extraHeaders: string[] = []) {
  return parseCsv(makeSbmalCsv(rows, extraHeaders));
}

describe("validate - happy path over real rows (isadg)", () => {
  it("classifies every real row as a create when none exist", () => {
    const { headers, rows } = parse();
    const result = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts).toHaveLength(SBMAL_REAL_ROWS.length);
    expect(result.verdicts.every((v) => v.verdict === "create")).toBe(true);
  });
});

describe("validate - create/update/skip classification (S7.1)", () => {
  it("updates an existing code when update is on, skips it when off", () => {
    const { headers, rows } = parse();
    const existing = new Set(["CMD 1"]);

    const upsert = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: existing,
      updateExisting: true,
    });
    expect(upsert.verdicts.find((v) => v.referenceCode === "CMD 1")!.verdict).toBe("update");

    const createOnly = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: existing,
      updateExisting: false,
    });
    expect(createOnly.verdicts.find((v) => v.referenceCode === "CMD 1")!.verdict).toBe("skip");
    // The other seven still create.
    expect(createOnly.verdicts.filter((v) => v.verdict === "create")).toHaveLength(7);
  });
});

describe("validate - header binding is named, never silent", () => {
  it("names an unbound binding and unrecognised headers", () => {
    const { headers, rows } = parse();
    const result = validate({
      standard: "isadg",
      bindings: bindings([{ source: "NoSuchColumn", target: "notes" }]),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.headerBinding.unboundBindings).toContainEqual({
      source: "NoSuchColumn",
      target: "notes",
    });
    // Columns no binding reads are named (e.g. Repository, Notes).
    expect(result.headerBinding.unrecognisedHeaders).toContain("Repository");
  });
});

describe("validate - asymmetry rule", () => {
  it("REJECTS an identifier failure (in-file duplicate blocks BOTH rows)", () => {
    const dup = [...SBMAL_REAL_ROWS, { ...SBMAL_REAL_ROWS[0] }]; // CMD 1 twice
    const { headers, rows } = parse(dup);
    const result = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    const rejects = result.verdicts.filter((v) => v.verdict === "reject");
    // Never first-wins: both colliding rows blocked, each naming the other.
    expect(rejects).toHaveLength(2);
    expect(rejects.every((r) => r.reason === "duplicate_reference_code")).toBe(true);
    expect(rejects.map((r) => r.rowNumber).sort((a, b) => a - b)).toEqual([1, 9]);
    expect(rejects.find((r) => r.rowNumber === 1)!.detail).toMatchObject({ rows: [9] });
  });

  it("DEGRADES an unrecognised vocabulary value to a warning, not a reject", () => {
    // Remap descriptionLevel via a vocabulary transform whose mapping does
    // not know the source value -> safe default + warning, row still valid.
    const rowsIn = [
      { ...SBMAL_REAL_ROWS[0], Report_Type: "expediente" },
    ];
    const { headers, rows } = parse(rowsIn);
    const vocabBindings = bindings().filter((b) => b.target !== "descriptionLevel");
    const result = validate({
      standard: "isadg",
      bindings: [
        ...vocabBindings,
        {
          source: "Report_Type",
          target: "descriptionLevel",
          transform: { kind: "vocabulary", mapping: { file: "file" }, default: "item" },
        },
      ] as any,
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts[0].verdict).toBe("create");
    expect(result.warnings.some((w) => w.code === "unknown_vocabulary")).toBe(true);
  });
});

describe("validate - over-length rejects, never truncates", () => {
  it("rejects a title beyond the schema maximum with value_too_long", () => {
    const long = { ...SBMAL_REAL_ROWS[0], Title: "x".repeat(2001) };
    const { headers, rows } = parse([long]);
    const result = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts[0].verdict).toBe("reject");
    expect(result.verdicts[0].reason).toBe("value_too_long");
  });
});

describe("validate - a validation-rejected parent cascades to its descendants", () => {
  // A parent column appended to the real headers; the parent row is made
  // to fail VALIDATION (over-length title), not identifier resolution -
  // the child and grandchild must still be blocked, transitively.
  const withParent = (
    row: (typeof SBMAL_REAL_ROWS)[number],
    parent?: string,
  ) => ({ ...row, Parent: parent ?? "" }) as Record<string, string>;

  function run(
    rowsIn: Record<string, string>[],
    existingReferenceCodes: ReadonlySet<string> = new Set(),
  ) {
    const csv = makeSbmalCsv(rowsIn as any, ["Parent"]);
    const { headers, rows } = parseCsv(csv);
    return validate({
      standard: "isadg",
      bindings: bindings([{ source: "Parent", target: "parent" }]),
      headers,
      rows,
      existingReferenceCodes,
      updateExisting: false,
    });
  }

  it("rejects the child of a parent the standard validator rejected", () => {
    const badParent = withParent({ ...SBMAL_REAL_ROWS[0], Title: "x".repeat(2001) });
    const child = withParent(SBMAL_REAL_ROWS[1], "CMD 1");
    const result = run([badParent, child]);

    const parent = result.verdicts.find((v) => v.referenceCode === "CMD 1")!;
    expect(parent.verdict).toBe("reject");
    expect(parent.reason).toBe("value_too_long");

    const cascaded = result.verdicts.find((v) => v.referenceCode === "CMD 2")!;
    expect(cascaded.verdict).toBe("reject");
    expect(cascaded.reason).toBe("parent_rejected");
    expect(cascaded.detail).toMatchObject({ parentReferenceCode: "CMD 1" });
  });

  it("cascades transitively to a grandchild", () => {
    const badParent = withParent({ ...SBMAL_REAL_ROWS[0], Title: "x".repeat(2001) });
    const child = withParent(SBMAL_REAL_ROWS[1], "CMD 1");
    const grandchild = withParent(SBMAL_REAL_ROWS[2], "CMD 2");
    const result = run([badParent, child, grandchild]);

    const gc = result.verdicts.find((v) => v.referenceCode === "CMD 3")!;
    expect(gc.verdict).toBe("reject");
    expect(gc.reason).toBe("parent_rejected");
    expect(gc.detail).toMatchObject({ parentReferenceCode: "CMD 2" });
  });

  it("does NOT cascade from a skipped parent (it already exists)", () => {
    const parent = withParent(SBMAL_REAL_ROWS[0]);
    const child = withParent(SBMAL_REAL_ROWS[1], "CMD 1");
    const result = run([parent, child], new Set(["CMD 1"]));
    expect(result.verdicts.find((v) => v.referenceCode === "CMD 1")!.verdict).toBe("skip");
    expect(result.verdicts.find((v) => v.referenceCode === "CMD 2")!.verdict).toBe("create");
  });
});

describe("validate - dateCertainty as a bound supplementary target (spec: bindable pre-parsed certainty)", () => {
  // The SBMAL master carries its own pre-parsed Date_Certainty column
  // alongside the free-text Date_Expressed; a profile can bind it directly
  // via a vocabulary transform instead of re-deriving certainty from the
  // date parser. DACS is the motivating standard - no DACS section field
  // declares dateCertainty, so this also proves the target validates
  // against the DACS Zod validator (target-fields.ts SUPPLEMENTARY_TARGETS).
  function certaintyBindings() {
    return bindings([
      {
        source: "Date_Certainty",
        target: "dateCertainty",
        transform: {
          kind: "vocabulary" as const,
          mapping: { approximate: "approximate", questioned: "uncertain" },
          default: "",
        },
      },
    ]);
  }

  it("lands a mapped certainty value on the record (real CMD 3a row)", () => {
    // CMD 3a is the only real row with a populated Date_Certainty
    // ("approximate"); Extent is added so the DACS item-level required
    // field is satisfied and the row's fate turns on dateCertainty alone.
    const row = { ...SBMAL_REAL_ROWS[3], Extent: "1 item" };
    const { headers, rows } = parse([row]);
    const result = validate({
      standard: "dacs",
      bindings: certaintyBindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts[0].verdict).toBe("create");
    expect(result.verdicts[0].record?.dateCertainty).toBe("approximate");
  });

  it("leaves dateCertainty unset when the source cell is blank (default \"\" assigns nothing)", () => {
    const row = { ...SBMAL_REAL_ROWS[0], Extent: "1 item" }; // CMD 1: blank Date_Certainty
    const { headers, rows } = parse([row]);
    const result = validate({
      standard: "dacs",
      bindings: certaintyBindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts[0].verdict).toBe("create");
    expect(result.verdicts[0].record?.dateCertainty).toBeUndefined();
  });
});

describe("validate - standard validator rejects (DACS required field)", () => {
  it("rejects a DACS item lacking extent with missing_required_field", () => {
    // Real CMD rows have blank extent; DACS item requires it, isadg does not.
    const { headers, rows } = parse([SBMAL_REAL_ROWS[0]]);
    const result = validate({
      standard: "dacs",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts[0].verdict).toBe("reject");
    expect(result.verdicts[0].reason).toBe("missing_required_field");
    expect((result.verdicts[0].detail as any).fields).toContain("extent");
  });
});

describe("validate - readiness-check acceptance threading (design §4)", () => {
  const EXTENT_CLASS = "missing_required_field:item:extent";

  it("creates an accepted-class row honestly sparse with a warning tally", () => {
    const { headers, rows } = parse([SBMAL_REAL_ROWS[0]]);
    const result = validate({
      standard: "dacs",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
      acceptedClasses: new Set([EXTENT_CLASS]),
    });
    expect(result.verdicts[0].verdict).toBe("create");
    const warn = result.warnings.find((w) => w.code === "accepted_missing_required");
    expect(warn).toBeDefined();
    expect((warn!.detail as any).field).toBe("extent");
    expect((warn!.detail as any).level).toBe("item");
  });

  it("still rejects a non-accepted required gap, naming the fields and level", () => {
    const { headers, rows } = parse([SBMAL_REAL_ROWS[0]]);
    const result = validate({
      standard: "dacs",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
      acceptedClasses: new Set(), // nothing accepted
    });
    const v = result.verdicts[0];
    expect(v.verdict).toBe("reject");
    expect(v.reason).toBe("missing_required_field");
    expect((v.detail as any).requiredMissing).toContain("extent");
    expect((v.detail as any).level).toBe("item");
  });

  it("leaves identifier failures untouched by acceptance (asymmetry holds)", () => {
    // Two rows share a reference code — a duplicate rejects regardless of any
    // accepted describing-field class.
    const dupRows = [
      { ...SBMAL_REAL_ROWS[0], Reference_Code: "SAME" },
      { ...SBMAL_REAL_ROWS[1], Reference_Code: "SAME" },
    ];
    const { headers, rows } = parse(dupRows);
    const result = validate({
      standard: "dacs",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
      acceptedClasses: new Set([EXTENT_CLASS]),
    });
    expect(result.verdicts.every((v) => v.reason === "duplicate_reference_code")).toBe(true);
  });

  it("recomputes the cascade under acceptance: an accepted parent stops cascading", () => {
    const collFields = [
      "accessConditions",
      "creatorDisplay",
      "dateExpression",
      "extent",
      "language",
      "scopeContent",
    ];
    const acceptCollection = new Set(
      collFields.map((f) => `missing_required_field:collection:${f}`),
    );
    const hierarchyRows = [
      { Reference_Code: "TEST-COLL", Title: "Container (test parent)", Format: "collection" },
      { ...SBMAL_REAL_ROWS[0], Parent_Reference_Code: "TEST-COLL" },
    ];
    const parentBinding = [{ source: "Parent_Reference_Code", target: "parent" }];
    const { headers, rows } = parse(hierarchyRows, ["Parent_Reference_Code"]);

    // With nothing accepted the collection rejects and the item inherits it.
    const before = validate({
      standard: "dacs",
      bindings: bindings(parentBinding),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(before.verdicts.find((v) => v.referenceCode === "CMD 1")!.reason).toBe(
      "parent_rejected",
    );

    // Accepting the collection's classes lets it create — so its item child no
    // longer inherits `parent_rejected`; it rejects on its OWN extent gap.
    const after = validate({
      standard: "dacs",
      bindings: bindings(parentBinding),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
      acceptedClasses: acceptCollection,
    });
    expect(after.verdicts.find((v) => v.referenceCode === "TEST-COLL")!.verdict).toBe("create");
    const item = after.verdicts.find((v) => v.referenceCode === "CMD 1")!;
    expect(item.verdict).toBe("reject");
    expect(item.reason).toBe("missing_required_field");
    expect((item.detail as any).requiredMissing).toContain("extent");
  });
});

describe("validate - legacyIds landing spot with per-column providers", () => {
  const bulky = "x".repeat(1500);

  it("derives the provider from the source header (slug), overridable per binding", () => {
    expect(legacyIdProviderFor({ source: "Former_Reference_Geiger" })).toBe(
      "former-reference-geiger",
    );
    expect(legacyIdProviderFor({ source: "legacyId", provider: "atom" })).toBe("atom");
  });

  it("lands BOTH former-reference columns distinctly (real CMD 6 row)", () => {
    const { headers, rows } = parse([SBMAL_REAL_ROWS[7]]); // CMD 6
    const result = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    const verdict = result.verdicts[0];
    expect(verdict.verdict).toBe("create");
    const legacyIds = JSON.parse(String(verdict.record!.legacyIds));
    expect(legacyIds).toEqual([
      { provider: "former-reference-geiger", id: "Geiger 87" },
      { provider: "former-reference-engelhardt", id: "Zephyrin 139" },
    ]);
  });

  it("accepts a bulky source identifier in legacyIds (uncapped JSON)", () => {
    const row = { ...SBMAL_REAL_ROWS[0], Former_Reference_Geiger: bulky };
    const { headers, rows } = parse([row]);
    const result = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    // legacyIds has no length cap - the bulky id lands there and validates.
    expect(result.verdicts[0].verdict).toBe("create");
  });

  it("rejects the same bulky value routed to a typed column instead", () => {
    const row = { ...SBMAL_REAL_ROWS[0], Former_Reference_Geiger: bulky };
    const { headers, rows } = parse([row]);
    // Re-route Former_Reference_Geiger to extent (max 1000) - the contrast
    // proves the value's fate depends on WHERE it lands.
    const routed = bindings().map((b) =>
      b.target === "legacyIds" && b.source === "Former_Reference_Geiger"
        ? { ...b, target: "extent" }
        : b,
    );
    const result = validate({
      standard: "isadg",
      bindings: routed as any,
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.verdicts[0].verdict).toBe("reject");
    expect(result.verdicts[0].reason).toBe("value_too_long");
  });

  it("extracts reference codes independently for the D1 existence read", () => {
    const codes = extractReferenceCodes({
      bindings: bindings(),
      headers: parse().headers,
      rows: parse().rows,
    });
    expect(codes).toEqual([...SBMAL_REAL_CODES]);
  });
});

describe("validate - month-first dates flow through the pipeline (dayFirst)", () => {
  it("CMD 2's 2/4/1640 lands as February 4 with an ambiguity advisory", () => {
    const { headers, rows } = parse([SBMAL_REAL_ROWS[1]]); // CMD 2
    const result = validate({
      standard: "isadg",
      bindings: bindings(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    const verdict = result.verdicts[0];
    expect(verdict.verdict).toBe("create");
    // The fixture profile parses Date_Expressed month-first (dayFirst:
    // false); the master's own Date_Start column agrees: 1640-02-04.
    expect(verdict.record!.dateStart).toBe("1640-02-04");
    expect(verdict.record!.dateEnd).toBe("1640-02-04");
    expect(result.warnings.some((w) => w.code === "ambiguous_day_month")).toBe(true);
  });
});
