/**
 * Tests — profile editor state (lossless binding round-trip)
 *
 * This suite pins the editor's load-bearing invariant: rows carry the
 * ORIGINAL transform spec verbatim, so a load-then-save with no edits
 * (the name-only save path) serializes back byte-identical bindings for
 * every transform kind — `vocabulary.mapping` / `caseInsensitive`,
 * `concatenate` part labels and separator, `splitRejoin` separators, and
 * `date` year bounds all survive. Param edits merge into the existing
 * spec instead of rebuilding it; kind switches build a minimal fresh
 * spec by design.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  rowsFromBindings,
  bindingsFromRows,
  kindOfRow,
  paramOfRow,
  withKind,
  withParam,
} from "../../app/lib/import/profile-editor";
import type { ProfileBinding } from "../../app/lib/import/profile-schema";

// One binding per transform kind, every optional parameter populated —
// the exact shapes the flattening bug destroyed.
const FULL_FAT_BINDINGS: ProfileBinding[] = [
  { source: "identifier", target: "referenceCode" },
  { source: "title", target: "title", transform: { kind: "direct" } },
  {
    source: "extentAndMedium",
    target: "extent",
    transform: { kind: "defaultWhenBlank", default: "sin datos" },
  },
  {
    source: "CÓDIGO",
    target: "medium",
    transform: { kind: "constant", value: "Papel" },
  },
  {
    source: "archivalHistory",
    target: "provenance",
    transform: {
      kind: "concatenate",
      parts: [
        { column: "archivalHistory", label: "Historia" },
        { column: "acquisition", label: "Adquisición" },
      ],
      separator: " — ",
    },
  },
  {
    source: "language",
    target: "language",
    transform: { kind: "splitRejoin", inputSeparator: "|", outputSeparator: "; " },
  },
  {
    source: "eventStartDates",
    target: "dateStart",
    transform: { kind: "date", yearMin: 1500, yearMax: 1900, dayFirst: false },
  },
  {
    source: "legacyId",
    target: "legacyIds",
    transform: { kind: "direct" },
    provider: "atom",
  },
  {
    source: "levelOfDescription",
    target: "descriptionLevel",
    transform: {
      kind: "vocabulary",
      mapping: { expediente: "file", fondo: "fonds" },
      default: "file",
      caseInsensitive: false,
    },
  },
  {
    source: "repository",
    target: "findingAids",
    transform: { kind: "carryForward" },
  },
];

describe("lossless round-trip (the name-only-save path)", () => {
  it("rows -> bindings reproduces every transform byte-identically", () => {
    const json = JSON.stringify(FULL_FAT_BINDINGS);
    const rows = rowsFromBindings(json);
    const roundTripped = JSON.stringify(bindingsFromRows(rows));
    expect(roundTripped).toBe(json);
  });

  it("preserves vocabulary.mapping and caseInsensitive", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const vocab = bindingsFromRows(rows).find((b) => b.target === "descriptionLevel");
    expect(vocab?.transform).toEqual({
      kind: "vocabulary",
      mapping: { expediente: "file", fondo: "fonds" },
      default: "file",
      caseInsensitive: false,
    });
  });

  it("preserves concatenate part labels and separator", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const concat = bindingsFromRows(rows).find((b) => b.target === "provenance");
    expect(concat?.transform).toEqual({
      kind: "concatenate",
      parts: [
        { column: "archivalHistory", label: "Historia" },
        { column: "acquisition", label: "Adquisición" },
      ],
      separator: " — ",
    });
  });

  it("preserves splitRejoin separators", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const split = bindingsFromRows(rows).find((b) => b.target === "language");
    expect(split?.transform).toEqual({
      kind: "splitRejoin",
      inputSeparator: "|",
      outputSeparator: "; ",
    });
  });

  it("preserves the legacyIds provider tag", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const legacy = bindingsFromRows(rows).find((b) => b.target === "legacyIds");
    expect(legacy?.provider).toBe("atom");
  });

  it("preserves date year bounds and dayFirst", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const date = bindingsFromRows(rows).find((b) => b.target === "dateStart");
    expect(date?.transform).toEqual({ kind: "date", yearMin: 1500, yearMax: 1900, dayFirst: false });
  });
});

describe("param edits merge, never rebuild", () => {
  it("vocabulary default edit keeps mapping and caseInsensitive", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const i = rows.findIndex((r) => r.target === "descriptionLevel");
    const edited = withParam(rows[i], "item");
    expect(edited.transform).toEqual({
      kind: "vocabulary",
      mapping: { expediente: "file", fondo: "fonds" },
      default: "item",
      caseInsensitive: false,
    });
  });

  it("concatenate column edit keeps separator and surviving labels", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const i = rows.findIndex((r) => r.target === "provenance");
    // Drop the second column, add a new one; the first keeps its label.
    const edited = withParam(rows[i], "archivalHistory, generalNote");
    expect(edited.transform).toEqual({
      kind: "concatenate",
      parts: [
        { column: "archivalHistory", label: "Historia" },
        { column: "generalNote" },
      ],
      separator: " — ",
    });
  });

  it("defaultWhenBlank edit replaces only the default", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const i = rows.findIndex((r) => r.target === "extent");
    expect(withParam(rows[i], "n/a").transform).toEqual({
      kind: "defaultWhenBlank",
      default: "n/a",
    });
  });

  it("kinds without an inline param return the row unchanged", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const date = rows.find((r) => r.target === "dateStart")!;
    expect(withParam(date, "whatever")).toBe(date);
  });

  it("constant edit replaces only the value, and its param displays it", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const i = rows.findIndex((r) => r.target === "medium");
    expect(kindOfRow(rows[i])).toBe("constant");
    expect(paramOfRow(rows[i])).toBe("Papel");
    expect(withParam(rows[i], "file").transform).toEqual({
      kind: "constant",
      value: "file",
    });
    expect(withKind(rows[i], "constant").transform).toEqual({
      kind: "constant",
      value: "",
    });
  });
});

describe("display helpers and kind switches", () => {
  it("kindOfRow and paramOfRow read the carried spec", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const vocab = rows.find((r) => r.target === "descriptionLevel")!;
    expect(kindOfRow(vocab)).toBe("vocabulary");
    expect(paramOfRow(vocab)).toBe("file");
    const concat = rows.find((r) => r.target === "provenance")!;
    expect(paramOfRow(concat)).toBe("archivalHistory, acquisition");
    const bare = rows.find((r) => r.target === "referenceCode")!;
    expect(kindOfRow(bare)).toBe("none");
  });

  it("a kind switch builds a minimal fresh spec and none clears it", () => {
    const rows = rowsFromBindings(JSON.stringify(FULL_FAT_BINDINGS));
    const vocab = rows.find((r) => r.target === "descriptionLevel")!;
    expect(withKind(vocab, "date").transform).toEqual({ kind: "date" });
    expect(withKind(vocab, "none").transform).toBeUndefined();
  });

  it("bindingsFromRows drops unfilled rows", () => {
    expect(
      bindingsFromRows([
        { source: "identifier", target: "referenceCode" },
        { source: "", target: "" },
        { source: "x", target: "" },
      ]),
    ).toEqual([{ source: "identifier", target: "referenceCode" }]);
  });
});
