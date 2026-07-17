/**
 * Tests — import date parser
 *
 * A fixture-table suite pinning the parameterized archival-date parser at
 * the `import_ca.py` capability bar plus the review-ruled extensions: bare
 * years, year-month, full dates, numeric NN-NN-YYYY (day-first default
 * with a `dayFirst` option and an ambiguity advisory), Spanish month names
 * (including `setiembre`) in plain and canonical "de" forms, all three
 * range separators (`..`, `-`, `–`), mixed ISO/numeric ranges, uncertain
 * passthrough (`?` / `ca.` / bare `ca` / `circa`, with false-positive
 * guards), invalid-day clamping REPORTED via `date_day_clamped`, reversed
 * ranges degraded (never swapped) via `reversed_date_range`, and garbage
 * that must degrade with a warning and never throw.
 *
 * Expectations derive from `import_ca.py`'s documented behaviour (year
 * expands to Jan 1 .. Dec 31; year-month to the 1st .. last day; invalid
 * days clamp down) plus the adversarial-review rulings on warning
 * surfacing, reversal, bare-`ca`, Spanish "de" forms, and day-first.
 *
 * @version v0.6.0
 */

import { describe, it, expect } from "vitest";
import { parseDateExpression } from "../../../app/lib/import/date-parser";

interface Case {
  label: string;
  input: string;
  start: string | null;
  end: string | null;
  certainty?: string;
  warning?:
    | "unparseable_date"
    | "uncertain_date"
    | "date_day_clamped"
    | "reversed_date_range"
    | "ambiguous_day_month";
}

const parsedCases: Case[] = [
  // Bare year expands to full-year bounds.
  { label: "bare year", input: "1875", start: "1875-01-01", end: "1875-12-31" },
  // Year-month expands to first .. last day.
  { label: "year-month", input: "1875-03", start: "1875-03-01", end: "1875-03-31" },
  { label: "year-month April (30d)", input: "1875-04", start: "1875-04-01", end: "1875-04-30" },
  { label: "year-month leap Feb", input: "1816-02", start: "1816-02-01", end: "1816-02-29" },
  // Full ISO date.
  { label: "full ISO", input: "1824-10-16", start: "1824-10-16", end: "1824-10-16" },
  // Numeric day-first, unambiguous (day > 12).
  { label: "numeric single day>12", input: "13-02-1815", start: "1815-02-13", end: "1815-02-13" },
  { label: "numeric slash single day>12", input: "13/02/1815", start: "1815-02-13", end: "1815-02-13" },
  // Spanish text dates, plain form.
  { label: "Spanish single", input: "29 Marzo 1815", start: "1815-03-29", end: "1815-03-29" },
  { label: "Spanish lowercase", input: "29 marzo 1815", start: "1815-03-29", end: "1815-03-29" },
  { label: "Spanish setiembre", input: "15 Setiembre 1820", start: "1820-09-15", end: "1820-09-15" },
  { label: "Spanish septiembre", input: "15 Septiembre 1820", start: "1820-09-15", end: "1820-09-15" },
  { label: "Spanish accented diciembre", input: "7 Diciembre 1780", start: "1780-12-07", end: "1780-12-07" },
  // Spanish canonical "de" forms.
  { label: "Spanish de full", input: "3 de marzo de 1875", start: "1875-03-03", end: "1875-03-03" },
  { label: "Spanish de setiembre", input: "3 de setiembre de 1875", start: "1875-09-03", end: "1875-09-03" },
  { label: "Spanish de partial (day de month year)", input: "3 de marzo 1875", start: "1875-03-03", end: "1875-03-03" },
  { label: "Spanish month de year", input: "setiembre de 1875", start: "1875-09-01", end: "1875-09-30" },
  { label: "Spanish month de year leap Feb", input: "febrero de 1816", start: "1816-02-01", end: "1816-02-29" },
  { label: "Spanish month de year capitalised", input: "Marzo de 1875", start: "1875-03-01", end: "1875-03-31" },
  // Ranges, all three separators.
  { label: "ISO range ..", input: "1825-01-01 .. 1825-12-31", start: "1825-01-01", end: "1825-12-31" },
  { label: "year range hyphen", input: "1864 - 1930", start: "1864-01-01", end: "1930-12-31" },
  { label: "year range en-dash", input: "1864 – 1930", start: "1864-01-01", end: "1930-12-31" },
  { label: "mixed-granularity range", input: "1830-05-14 .. 1831-12", start: "1830-05-14", end: "1831-12-31" },
  // Mixed ISO/numeric range (numeric side unambiguous: day 26).
  { label: "ISO..numeric mixed range", input: "1815-05-07 .. 26-08-1815", start: "1815-05-07", end: "1815-08-26" },
  // Spanish ranges, plain and "de" forms.
  { label: "Spanish range", input: "7 Diciembre 1780 - 29 Junio 1781", start: "1780-12-07", end: "1781-06-29" },
  { label: "Spanish de range hyphen", input: "3 de marzo de 1875 - 8 de abril de 1876", start: "1875-03-03", end: "1876-04-08" },
  { label: "Spanish month-de range ..", input: "marzo de 1875 .. abril de 1876", start: "1875-03-01", end: "1876-04-30" },
  { label: "Spanish month-de range en-dash", input: "enero de 1800 – diciembre de 1810", start: "1800-01-01", end: "1810-12-31" },
  { label: "Spanish mixed plain/de range", input: "29 Marzo 1815 .. setiembre de 1815", start: "1815-03-29", end: "1815-09-30" },
  // Open-ended notations duplicate the bound.
  { label: "end-only", input: "- 1878-12-01", start: "1878-12-01", end: "1878-12-01" },
  { label: "start-only", input: ".. 1823-04-06", start: "1823-04-06", end: "1823-04-06" },
  // Leading punctuation is stripped.
  { label: "leading comma", input: ",1824-01-02", start: "1824-01-02", end: "1824-01-02" },
  // Surrounding whitespace.
  { label: "surrounding whitespace", input: "  1875  ", start: "1875-01-01", end: "1875-12-31" },
];

const clampCases: Case[] = [
  { label: "Feb 31 non-leap", input: "1815-02-31", start: "1815-02-28", end: "1815-02-28", warning: "date_day_clamped" },
  { label: "Feb 31 leap", input: "1816-02-31", start: "1816-02-29", end: "1816-02-29", warning: "date_day_clamped" },
  { label: "Feb 31 century non-leap", input: "1900-02-31", start: "1900-02-28", end: "1900-02-28", warning: "date_day_clamped" },
  { label: "Feb 31 400-leap", input: "2000-02-31", start: "2000-02-29", end: "2000-02-29", warning: "date_day_clamped" },
  { label: "April 31 clamps to 30", input: "1875-04-31", start: "1875-04-30", end: "1875-04-30", warning: "date_day_clamped" },
  { label: "Spanish Feb 31 clamps", input: "31 Febrero 1815", start: "1815-02-28", end: "1815-02-28", warning: "date_day_clamped" },
  { label: "Spanish de Feb 31 clamps", input: "31 de febrero de 1815", start: "1815-02-28", end: "1815-02-28", warning: "date_day_clamped" },
];

const reversedCases: Case[] = [
  { label: "reversed year range ..", input: "1876 .. 1875", start: null, end: null, warning: "reversed_date_range" },
  { label: "reversed year range hyphen", input: "1876 - 1875", start: null, end: null, warning: "reversed_date_range" },
  { label: "reversed year range en-dash", input: "1876 – 1875", start: null, end: null, warning: "reversed_date_range" },
  { label: "reversed year-month range", input: "1875-06 .. 1875-03", start: null, end: null, warning: "reversed_date_range" },
  { label: "reversed full-date range", input: "1825-12-31 .. 1825-01-01", start: null, end: null, warning: "reversed_date_range" },
  { label: "reversed Spanish de range", input: "abril de 1876 .. marzo de 1875", start: null, end: null, warning: "reversed_date_range" },
];

// Circa forms carry "approximate" (the cataloguer estimated); a question
// mark carries "uncertain" (the cataloguer doubted); "?" outranks circa
// when both appear. Mirrors the coordinate-precision vocabulary.
const uncertainCases: Case[] = [
  { label: "trailing question mark", input: "189?", start: null, end: null, certainty: "uncertain", warning: "uncertain_date" },
  { label: "ca. prefix", input: "ca. 1750", start: null, end: null, certainty: "approximate", warning: "uncertain_date" },
  { label: "ca. immediately before year", input: "ca. 1875", start: null, end: null, certainty: "approximate", warning: "uncertain_date" },
  { label: "bare ca word", input: "ca 1875", start: null, end: null, certainty: "approximate", warning: "uncertain_date" },
  { label: "circa word", input: "circa 1800", start: null, end: null, certainty: "approximate", warning: "uncertain_date" },
  { label: "circa before year", input: "circa 1875", start: null, end: null, certainty: "approximate", warning: "uncertain_date" },
  { label: "interior bare ca", input: "1875 ca 1880", start: null, end: null, certainty: "approximate", warning: "uncertain_date" },
  { label: "question in full date", input: "1800-0?-01", start: null, end: null, certainty: "uncertain", warning: "uncertain_date" },
  { label: "question outranks circa", input: "ca. 1875?", start: null, end: null, certainty: "uncertain", warning: "uncertain_date" },
];

const garbageCases: Case[] = [
  { label: "prose", input: "not a date", start: null, end: null, warning: "unparseable_date" },
  { label: "too short numeric", input: "152", start: null, end: null, warning: "unparseable_date" },
  { label: "non-numeric four chars", input: "abcd", start: null, end: null, warning: "unparseable_date" },
  { label: "slash with two-digit year", input: "13/02/15", start: null, end: null, warning: "unparseable_date" },
  { label: "year below floor", input: "0999", start: null, end: null, warning: "unparseable_date" },
  { label: "year above ceiling", input: "2200", start: null, end: null, warning: "unparseable_date" },
  { label: "full date above ceiling", input: "3000-05-01", start: null, end: null, warning: "unparseable_date" },
  { label: "impossible month", input: "1875-13", start: null, end: null, warning: "unparseable_date" },
  { label: "unknown Spanish month", input: "3 de florero de 1875", start: null, end: null, warning: "unparseable_date" },
  // False-positive guards: "ca" inside a word is NOT an uncertainty marker.
  { label: "cerca is not ca", input: "cerca 1875", start: null, end: null, warning: "unparseable_date" },
  { label: "Cauca is not ca", input: "Cauca 1875", start: null, end: null, warning: "unparseable_date" },
];

describe("parseDateExpression — parsed dates", () => {
  it.each(parsedCases)(
    "$label: $input",
    ({ input, start, end, certainty }) => {
      const { result, warnings } = parseDateExpression(input);
      expect(result.dateStart).toBe(start);
      expect(result.dateEnd).toBe(end);
      expect(result.dateCertainty).toBe(certainty ?? "");
      expect(result.dateExpression).toBe(input.trim());
      expect(warnings).toHaveLength(0);
    }
  );
});

describe("parseDateExpression — invalid days clamp AND report", () => {
  it.each(clampCases)("$label: $input", ({ input, start, end, warning }) => {
    const { result, warnings } = parseDateExpression(input);
    expect(result.dateStart).toBe(start);
    expect(result.dateEnd).toBe(end);
    expect(result.dateCertainty).toBe("");
    expect(result.dateExpression).toBe(input.trim());
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(warning);
    expect(warnings[0].detail).toMatchObject({ clampedDate: start });
  });

  it("carries the original and clamped day in detail", () => {
    const { warnings } = parseDateExpression("1875-04-31");
    expect(warnings[0].detail).toMatchObject({
      year: 1875,
      month: 4,
      day: 31,
      clampedDay: 30,
    });
  });

  it("a range with one clamped side keeps the parse and reports once", () => {
    const { result, warnings } = parseDateExpression("1815-02-31 .. 1815-06-01");
    expect(result.dateStart).toBe("1815-02-28");
    expect(result.dateEnd).toBe("1815-06-01");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("date_day_clamped");
  });

  it("expansion of an unstated day never warns (year-month end)", () => {
    const { warnings } = parseDateExpression("1875-04");
    expect(warnings).toHaveLength(0);
  });
});

describe("parseDateExpression — reversed ranges degrade, never swap", () => {
  it.each(reversedCases)("$label: $input", ({ input, warning }) => {
    const { result, warnings } = parseDateExpression(input);
    expect(result.dateStart).toBeNull();
    expect(result.dateEnd).toBeNull();
    expect(result.dateCertainty).toBe("");
    expect(result.dateExpression).toBe(input.trim());
    const reversed = warnings.filter((w) => w.code === warning);
    expect(reversed).toHaveLength(1);
    expect(reversed[0].detail).toHaveProperty("dateStart");
    expect(reversed[0].detail).toHaveProperty("dateEnd");
  });

  it("detail carries both computed bounds", () => {
    const { warnings } = parseDateExpression("1876 .. 1875");
    expect(warnings[0].detail).toEqual({
      dateStart: "1876-01-01",
      dateEnd: "1875-12-31",
    });
  });

  it("equal bounds are not reversed", () => {
    const { result, warnings } = parseDateExpression("1875 .. 1875");
    expect(result.dateStart).toBe("1875-01-01");
    expect(result.dateEnd).toBe("1875-12-31");
    expect(warnings).toHaveLength(0);
  });
});

describe("parseDateExpression — uncertain passthrough", () => {
  it.each(uncertainCases)(
    "$label: $input",
    ({ input, certainty, warning }) => {
      const { result, warnings } = parseDateExpression(input);
      expect(result.dateStart).toBeNull();
      expect(result.dateEnd).toBeNull();
      expect(result.dateCertainty).toBe(certainty);
      expect(result.dateExpression).toBe(input.trim());
      expect(warnings).toHaveLength(1);
      expect(warnings[0].code).toBe(warning);
    }
  );
});

describe("parseDateExpression — garbage degrades with a warning", () => {
  it.each(garbageCases)("$label: $input", ({ input, warning }) => {
    const { result, warnings } = parseDateExpression(input);
    expect(result.dateStart).toBeNull();
    expect(result.dateEnd).toBeNull();
    expect(result.dateCertainty).toBe("");
    expect(result.dateExpression).toBe(input.trim());
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(warning);
  });
});

describe("parseDateExpression — day-first vs month-first numeric dates", () => {
  it("default day-first: 04-05-1815 reads as 4 May, with an advisory", () => {
    const { result, warnings } = parseDateExpression("04-05-1815");
    expect(result.dateStart).toBe("1815-05-04");
    expect(result.dateEnd).toBe("1815-05-04");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("ambiguous_day_month");
    expect(warnings[0].detail).toMatchObject({
      dayFirst: true,
      interpretedAs: "1815-05-04",
    });
  });

  it("dayFirst false: 04-05-1815 reads as April 5, with an advisory", () => {
    const { result, warnings } = parseDateExpression("04-05-1815", {
      dayFirst: false,
    });
    expect(result.dateStart).toBe("1815-04-05");
    expect(result.dateEnd).toBe("1815-04-05");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("ambiguous_day_month");
    expect(warnings[0].detail).toMatchObject({
      dayFirst: false,
      interpretedAs: "1815-04-05",
    });
  });

  it("unambiguous day>12 gets no advisory", () => {
    const { warnings } = parseDateExpression("13-02-1815");
    expect(warnings).toHaveLength(0);
  });

  it("dayFirst false makes 13-02-1815 unparseable (month 13)", () => {
    const { result, warnings } = parseDateExpression("13-02-1815", {
      dayFirst: false,
    });
    expect(result.dateStart).toBeNull();
    expect(warnings[0].code).toBe("unparseable_date");
  });

  it("numeric range with one ambiguous side advises once and still parses", () => {
    const { result, warnings } = parseDateExpression("01-02-1820 .. 29-02-1820");
    expect(result.dateStart).toBe("1820-02-01");
    expect(result.dateEnd).toBe("1820-02-29");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("ambiguous_day_month");
  });

  it("slash form honours dayFirst: SBMAL's 2/4/1640 month-first is February 4", () => {
    // Real SBMAL master value; its own Date_Start column reads 1640-02-04.
    const { result, warnings } = parseDateExpression("2/4/1640", {
      dayFirst: false,
    });
    expect(result.dateStart).toBe("1640-02-04");
    expect(result.dateEnd).toBe("1640-02-04");
    expect(warnings[0].code).toBe("ambiguous_day_month");
  });

  it("equal fields (05-05-1815) are not ambiguous", () => {
    const { result, warnings } = parseDateExpression("05-05-1815");
    expect(result.dateStart).toBe("1815-05-05");
    expect(warnings).toHaveLength(0);
  });
});

describe("parseDateExpression — blank input", () => {
  it.each(["", "   ", null, undefined])(
    "blank %p yields all-null, no warning",
    (input) => {
      const { result, warnings } = parseDateExpression(
        input as string | null | undefined
      );
      expect(result.dateStart).toBeNull();
      expect(result.dateEnd).toBeNull();
      expect(result.dateCertainty).toBe("");
      expect(result.dateExpression).toBe("");
      expect(warnings).toHaveLength(0);
    }
  );
});

describe("parseDateExpression — never throws", () => {
  it.each([
    "!!!",
    "1234-",
    "..",
    "- ",
    "9999999999",
    "1875-99-99",
    "🙂 1800",
    "1800 .. ",
    "de 1875",
    "3 de de 1875",
    "ca",
    "1876 .. 1875 .. 1874",
  ])("does not throw on %p", (input) => {
    expect(() => parseDateExpression(input)).not.toThrow();
  });
});

describe("parseDateExpression — parameterized year bounds", () => {
  it("accepts an in-window year the default would reject", () => {
    const { result, warnings } = parseDateExpression("0850", {
      yearMin: 800,
      yearMax: 2100,
    });
    expect(result.dateStart).toBe("0850-01-01");
    expect(result.dateEnd).toBe("0850-12-31");
    expect(warnings).toHaveLength(0);
  });

  it("rejects a year outside a narrowed window", () => {
    const { result, warnings } = parseDateExpression("1400", {
      yearMin: 1500,
      yearMax: 2100,
    });
    expect(result.dateStart).toBeNull();
    expect(warnings[0].code).toBe("unparseable_date");
  });
});
