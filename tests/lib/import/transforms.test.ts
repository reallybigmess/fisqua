/**
 * Tests — import transform catalogue
 *
 * Covers each transform in the catalogue across its base, blank,
 * degenerate, and warning cases, plus the `applyTransform` dispatcher.
 * The date transform's exhaustive behaviour lives in
 * `date-parser.test.ts`; here it is checked only for delegation and
 * warning surfacing. Every degradation must appear as a structured
 * warning in the return — never thrown, never a truncation.
 *
 * @version v0.6.0
 */

import { describe, it, expect } from "vitest";
import { applyTransform } from "../../../app/lib/import/transforms";
import type { DateParseResult } from "../../../app/lib/import/date-parser";

// Local narrowing helper: the date transform is the only one returning a
// structured value rather than a string.
function asDate(value: unknown): DateParseResult {
  if (typeof value === "string") {
    throw new Error("expected a structured date result, got a string");
  }
  return value as DateParseResult;
}

describe("direct copy", () => {
  it("base: trims and copies", () => {
    const { value, warnings } = applyTransform({ kind: "direct" }, { value: "  foo  " });
    expect(value).toBe("foo");
    expect(warnings).toHaveLength(0);
  });

  it("blank: empty string stays empty", () => {
    expect(applyTransform({ kind: "direct" }, { value: "" }).value).toBe("");
  });

  it("degenerate: null becomes empty string, no warning", () => {
    const { value, warnings } = applyTransform({ kind: "direct" }, { value: null });
    expect(value).toBe("");
    expect(warnings).toHaveLength(0);
  });
});

describe("default when blank", () => {
  const spec = { kind: "defaultWhenBlank", default: "Unknown" } as const;

  it("base: passes a non-blank value through", () => {
    expect(applyTransform(spec, { value: "Bogota" }).value).toBe("Bogota");
  });

  it("blank: empty string yields the default", () => {
    expect(applyTransform(spec, { value: "" }).value).toBe("Unknown");
  });

  it("degenerate: whitespace-only yields the default, no warning", () => {
    const { value, warnings } = applyTransform(spec, { value: "   " });
    expect(value).toBe("Unknown");
    expect(warnings).toHaveLength(0);
  });
});

describe("constant", () => {
  const spec = { kind: "constant", value: "file" } as const;

  it("base: emits the constant whatever the source cell holds", () => {
    const { value, warnings } = applyTransform(spec, { value: "Legajo 3" });
    expect(value).toBe("file");
    expect(warnings).toHaveLength(0);
  });

  it("blank and absent cells yield the constant too, no warning", () => {
    expect(applyTransform(spec, { value: "" }).value).toBe("file");
    const absent = applyTransform(spec, { value: undefined });
    expect(absent.value).toBe("file");
    expect(absent.warnings).toHaveLength(0);
  });
});

describe("concatenate", () => {
  const spec = {
    kind: "concatenate",
    parts: [
      { column: "phys", label: "Physical" },
      { column: "type", label: "Document types" },
    ],
  } as const;

  it("base: joins labelled non-empty parts with a newline", () => {
    const { value, warnings } = applyTransform(spec, {
      value: null,
      columns: { phys: "vellum", type: "letter" },
    });
    expect(value).toBe("Physical: vellum\nDocument types: letter");
    expect(warnings).toHaveLength(0);
  });

  it("blank: all parts empty yields an empty string", () => {
    expect(
      applyTransform(spec, { value: null, columns: { phys: "", type: "  " } }).value
    ).toBe("");
  });

  it("degenerate: one empty part is skipped", () => {
    expect(
      applyTransform(spec, { value: null, columns: { phys: "vellum", type: "" } }).value
    ).toBe("Physical: vellum");
  });

  it("warning: a referenced column absent from the row is reported", () => {
    const { value, warnings } = applyTransform(spec, {
      value: null,
      columns: { phys: "vellum" },
    });
    expect(value).toBe("Physical: vellum");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("missing_source_column");
    expect(warnings[0].detail).toEqual({ column: "type" });
  });

  it("unlabelled parts render the bare value; custom separator honoured", () => {
    const custom = {
      kind: "concatenate",
      parts: [{ column: "a" }, { column: "b" }],
      separator: " | ",
    } as const;
    expect(
      applyTransform(custom, { value: null, columns: { a: "one", b: "two" } }).value
    ).toBe("one | two");
  });
});

describe("split and rejoin", () => {
  it("base: pipe-delimited becomes comma-joined", () => {
    const { value, warnings } = applyTransform(
      { kind: "splitRejoin" },
      { value: "Bogota|Tunja|Cartagena" }
    );
    expect(value).toBe("Bogota, Tunja, Cartagena");
    expect(warnings).toHaveLength(0);
  });

  it("blank: empty stays empty", () => {
    expect(applyTransform({ kind: "splitRejoin" }, { value: "" }).value).toBe("");
  });

  it("degenerate: single value passes through; empty segments dropped", () => {
    expect(applyTransform({ kind: "splitRejoin" }, { value: "solo" }).value).toBe("solo");
    expect(applyTransform({ kind: "splitRejoin" }, { value: "a||b" }).value).toBe("a, b");
  });

  it("warning: a segment containing the output separator is flagged", () => {
    const { value, warnings } = applyTransform(
      { kind: "splitRejoin" },
      { value: "Bogota, D.C.|Tunja" }
    );
    expect(value).toBe("Bogota, D.C., Tunja");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("separator_collision");
  });

  it("custom separators honoured", () => {
    const spec = { kind: "splitRejoin", inputSeparator: ";", outputSeparator: " / " } as const;
    expect(applyTransform(spec, { value: "a;b;c" }).value).toBe("a / b / c");
  });
});

describe("date (delegates to the parser)", () => {
  it("base: expands a bare year", () => {
    const { value, warnings } = applyTransform({ kind: "date" }, { value: "1875" });
    const result = asDate(value);
    expect(result.dateStart).toBe("1875-01-01");
    expect(result.dateEnd).toBe("1875-12-31");
    expect(warnings).toHaveLength(0);
  });

  it("blank: no date, no warning", () => {
    const { value, warnings } = applyTransform({ kind: "date" }, { value: "" });
    expect(asDate(value).dateStart).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it("warning: an uncertain date surfaces the parser warning", () => {
    const { value, warnings } = applyTransform({ kind: "date" }, { value: "189?" });
    expect(asDate(value).dateCertainty).toBe("uncertain");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("uncertain_date");
  });

  it("warning: garbage surfaces an unparseable warning", () => {
    const { warnings } = applyTransform({ kind: "date" }, { value: "not a date" });
    expect(warnings[0].code).toBe("unparseable_date");
  });

  it("year bounds are forwarded to the parser", () => {
    const { value } = applyTransform(
      { kind: "date", yearMin: 800, yearMax: 2100 },
      { value: "0850" }
    );
    expect(asDate(value).dateStart).toBe("0850-01-01");
  });

  it("dayFirst is forwarded: month-first sources read 2/4/1640 as February 4", () => {
    // Real SBMAL value: the master's own Date_Start reads it 1640-02-04.
    const monthFirst = applyTransform(
      { kind: "date", dayFirst: false },
      { value: "2/4/1640" }
    );
    expect(asDate(monthFirst.value).dateStart).toBe("1640-02-04");
    // The default (day-first) reads the same value as 2 April.
    const dayFirst = applyTransform({ kind: "date" }, { value: "2/4/1640" });
    expect(asDate(dayFirst.value).dateStart).toBe("1640-04-02");
  });
});

describe("controlled-vocabulary remap", () => {
  const spec = {
    kind: "vocabulary",
    mapping: { aut: "author", rcp: "recipient" },
    default: "mentioned",
  } as const;

  it("base: a recognised value maps, no warning", () => {
    const { value, warnings } = applyTransform(spec, { value: "aut" });
    expect(value).toBe("author");
    expect(warnings).toHaveLength(0);
  });

  it("case-insensitive by default", () => {
    expect(applyTransform(spec, { value: "AUT" }).value).toBe("author");
  });

  it("blank: yields the default with no warning", () => {
    const { value, warnings } = applyTransform(spec, { value: "" });
    expect(value).toBe("mentioned");
    expect(warnings).toHaveLength(0);
  });

  it("warning: an unrecognised value degrades to the default and reports it", () => {
    const { value, warnings } = applyTransform(spec, { value: "notarius" });
    expect(value).toBe("mentioned");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("unknown_vocabulary");
    expect(warnings[0].detail).toEqual({ value: "notarius", default: "mentioned" });
  });

  it("case-sensitive mode misses a differently-cased key and warns", () => {
    const strict = {
      kind: "vocabulary",
      mapping: { Aut: "author" },
      default: "mentioned",
      caseInsensitive: false,
    } as const;
    const { value, warnings } = applyTransform(strict, { value: "aut" });
    expect(value).toBe("mentioned");
    expect(warnings[0].code).toBe("unknown_vocabulary");
  });
});

describe("carry-forward", () => {
  const spec = { kind: "carryForward" } as const;

  it("base: a present value is used and becomes carryable", () => {
    const { value, warnings } = applyTransform(spec, { value: "Legajo 1" });
    expect(value).toBe("Legajo 1");
    expect(warnings).toHaveLength(0);
  });

  it("blank: inherits the previous row's value, no warning", () => {
    const { value, warnings } = applyTransform(
      spec,
      { value: "" },
      { previousValue: "Legajo 1" }
    );
    expect(value).toBe("Legajo 1");
    expect(warnings).toHaveLength(0);
  });

  it("warning: blank with no predecessor yields empty and reports it", () => {
    const { value, warnings } = applyTransform(spec, { value: "" }, {});
    expect(value).toBe("");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("carry_forward_no_predecessor");
  });

  it("warning: a blank predecessor counts as no predecessor", () => {
    const { warnings } = applyTransform(
      spec,
      { value: "" },
      { previousValue: "" }
    );
    expect(warnings[0].code).toBe("carry_forward_no_predecessor");
  });
});

describe("applyTransform dispatcher", () => {
  it("routes every catalogue kind without throwing", () => {
    const kinds = [
      applyTransform({ kind: "direct" }, { value: "x" }),
      applyTransform({ kind: "defaultWhenBlank", default: "d" }, { value: "" }),
      applyTransform({ kind: "concatenate", parts: [] }, { value: null, columns: {} }),
      applyTransform({ kind: "splitRejoin" }, { value: "a|b" }),
      applyTransform({ kind: "date" }, { value: "1900" }),
      applyTransform({ kind: "vocabulary", mapping: {}, default: "d" }, { value: "z" }),
      applyTransform({ kind: "carryForward" }, { value: "y" }),
    ];
    expect(kinds).toHaveLength(7);
    for (const { warnings } of kinds) {
      expect(Array.isArray(warnings)).toBe(true);
    }
  });
});
