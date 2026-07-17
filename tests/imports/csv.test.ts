/**
 * Tests — CSV intake (RFC 4180 parser + strict UTF-8 decode)
 *
 * This suite pins the hand-rolled parser's contract: BOM handling and
 * non-UTF-8 rejection by name (spec §4.1), and the RFC 4180 nasty cases
 * — quoted fields with embedded commas and newlines, doubled quotes,
 * CRLF / LF / lone-CR record separators, trailing empty fields, a quote
 * at field end in an unquoted field, and blank-line dropping.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  decodeUtf8,
  parseCsv,
  decodeAndParseCsv,
  CsvEncodingError,
  CsvParseError,
} from "../../app/lib/import/csv";
import { ATOM_ISADG_HEADERS, makeAtomCsv, SAMPLE_ATOM_ROWS, withBom } from "./fixtures";

describe("decodeUtf8", () => {
  it("strips a leading UTF-8 BOM", () => {
    const bytes = withBom("a,b\n1,2\n");
    expect(decodeUtf8(bytes)).toBe("a,b\n1,2\n");
  });

  it("decodes plain UTF-8 without a BOM", () => {
    const bytes = new TextEncoder().encode("á,é\n1,2\n");
    expect(decodeUtf8(bytes)).toBe("á,é\n1,2\n");
  });

  it("rejects non-UTF-8 bytes with a named CsvEncodingError", () => {
    // 0xFF 0xFE is a UTF-16LE BOM — invalid as UTF-8 in fatal mode.
    const bad = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    expect(() => decodeUtf8(bad)).toThrow(CsvEncodingError);
  });

  it("rejects a lone continuation byte", () => {
    const bad = new Uint8Array([0x80]);
    try {
      decodeUtf8(bad);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsvEncodingError);
      expect((e as CsvEncodingError).code).toBe("csv_encoding");
    }
  });
});

describe("parseCsv", () => {
  it("extracts headers and counts data rows", () => {
    const out = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(out.headers).toEqual(["a", "b", "c"]);
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const out = parseCsv('a,b\n"x,y",z\n');
    expect(out.rows[0]).toEqual(["x,y", "z"]);
  });

  it("handles embedded newlines inside quotes", () => {
    const out = parseCsv('a,b\n"line1\nline2",z\n');
    expect(out.rows[0]).toEqual(["line1\nline2", "z"]);
    expect(out.rowCount).toBe(1);
  });

  it("collapses doubled quotes to a single literal quote", () => {
    const out = parseCsv('a\n"she said ""hi"""\n');
    expect(out.rows[0]).toEqual(['she said "hi"']);
  });

  it("keeps a trailing empty field", () => {
    const out = parseCsv("a,b,c\n1,2,\n");
    expect(out.rows[0]).toEqual(["1", "2", ""]);
  });

  it("treats a quote at the end of an unquoted field as a literal", () => {
    const out = parseCsv('a,b\nabc",def\n');
    expect(out.rows[0]).toEqual(['abc"', "def"]);
  });

  it("accepts CRLF line endings", () => {
    const out = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(out.headers).toEqual(["a", "b"]);
    expect(out.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("accepts a lone CR as a record separator", () => {
    const out = parseCsv("a,b\r1,2\r3,4");
    expect(out.headers).toEqual(["a", "b"]);
    expect(out.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("parses a final record with no trailing newline", () => {
    const out = parseCsv("a,b\n1,2");
    expect(out.rows).toEqual([["1", "2"]]);
  });

  it("drops fully blank lines rather than emitting empty records", () => {
    const out = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(out.rowCount).toBe(2);
    expect(out.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("preserves a trailing empty quoted field", () => {
    const out = parseCsv('a,b\n1,""\n');
    expect(out.rows[0]).toEqual(["1", ""]);
  });

  it("throws a named CsvParseError on empty input", () => {
    try {
      parseCsv("");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsvParseError);
      expect((e as CsvParseError).code).toBe("empty_csv");
    }
  });

  it("rejects an unterminated quote instead of merging the file", () => {
    // The runaway quote would otherwise swallow rows 2 and 3 into one cell.
    const text = 'a,b\n"unclosed,1\n2,3\n4,5\n';
    try {
      parseCsv(text);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsvParseError);
      expect((e as CsvParseError).code).toBe("unterminated_quote");
    }
  });

  it("rejects duplicated header names, naming the duplicates", () => {
    try {
      parseCsv("title,title,id\n1,2,3\n");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CsvParseError);
      const err = e as CsvParseError;
      expect(err.code).toBe("duplicate_headers");
      expect(err.headers).toEqual(["title"]);
    }
  });

  it("names each duplicated header once", () => {
    try {
      parseCsv("a,a,b,b,b,c\n");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as CsvParseError).headers).toEqual(["a", "b"]);
    }
  });
});

describe("decodeAndParseCsv over the AtoM template", () => {
  it("round-trips the verbatim header row and template rows", () => {
    const csv = makeAtomCsv(SAMPLE_ATOM_ROWS);
    const out = decodeAndParseCsv(withBom(csv));
    expect(out.headers).toEqual([...ATOM_ISADG_HEADERS]);
    expect(out.rowCount).toBe(2);
    // The pipe-delimited multi-value cell survives as one field.
    const langIdx = ATOM_ISADG_HEADERS.indexOf("language");
    expect(out.rows[1][langIdx]).toBe("es|la");
  });
});
