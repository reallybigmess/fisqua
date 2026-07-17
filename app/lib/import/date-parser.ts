/**
 * Import date parser — the one parameterized archival-date transform
 *
 * This module deals with parsing free-text archival date expressions
 * into the structured `dateStart` / `dateEnd` / `dateCertainty` fields
 * of a description, plus the verbatim `dateExpression` for display. It
 * is the single date-parsing implementation for the imports module,
 * consolidating the five divergent parsers the zasqua importer survey
 * catalogued; its capability bar is `import_ca.py`'s `parse_date_expression`
 * (year / year-month / full-date tolerance, Spanish month names including
 * the `setiembre` spelling, ranges, invalid-day clamping) extended with
 * the en-dash (`–`) range separator and the canonical Spanish "de" forms
 * ("3 de marzo de 1875", "setiembre de 1875") dominant in Colombian
 * archival data.
 *
 * Output targets the description schema's date columns
 * (`app/lib/validation/description.ts`): `dateStart` / `dateEnd` are ISO
 * strings matching `/^\d{4}(-\d{2}(-\d{2})?)?$/`; this parser always
 * expands to full `YYYY-MM-DD` (a year becomes Jan 1 .. Dec 31, a
 * year-month becomes the 1st .. the last day) so range bounds are
 * precise and consistent with the existing production import.
 *
 * The asymmetry rule governs: a date is a describing value, so every
 * degradation surfaces as a structured warning in the return — never
 * thrown, never fabricated, never silent. Unparseable input leaves the
 * bounds null (`unparseable_date`); qualified dates pass through
 * unparsed (`uncertain_date`) keeping the source's distinction — circa
 * forms carry certainty "approximate", a question mark carries
 * "uncertain" (mirroring the coordinate-precision vocabulary, so
 * neither qualifier is collapsed into the other); an impossible stated
 * day clamps to the
 * month's last day AND reports it (`date_day_clamped`); a reversed range
 * is never swapped — swapping would fabricate intent — so its bounds
 * degrade to null with a report (`reversed_date_range`).
 *
 * Numeric `NN-NN-YYYY` and `N/N/YYYY` dates are inherently ambiguous when
 * both fields are <= 12 (day-month vs month-day). The parser reads them
 * day-first by default (the convention of the source data); `dayFirst:
 * false` flips the reading (US-style month-first sources like the SBMAL
 * master), and a genuinely ambiguous component parses with an
 * `ambiguous_day_month` advisory naming the interpretation used.
 *
 * @version v0.6.0
 */

/** Structured date fields produced from one raw expression. */
export interface DateParseResult {
  /** ISO `YYYY-MM-DD`, or null when the input could not be parsed. */
  dateStart: string | null;
  /** ISO `YYYY-MM-DD`, or null when the input could not be parsed. */
  dateEnd: string | null;
  /**
   * `""` when parsed or absent; `"approximate"` for `ca.` / `ca` /
   * `circa`; `"uncertain"` for `?` (which outranks a circa marker).
   */
  dateCertainty: string;
  /** The trimmed raw input, preserved verbatim for display. */
  dateExpression: string;
}

export type DateParseWarningCode =
  | "unparseable_date"
  | "uncertain_date"
  | "date_day_clamped"
  | "reversed_date_range"
  | "ambiguous_day_month";

export interface DateParseWarning {
  code: DateParseWarningCode;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DateParseOutcome {
  result: DateParseResult;
  warnings: DateParseWarning[];
}

export interface DateParseOptions {
  /** Lowest acceptable year (default 1000, per `import_ca.py`). */
  yearMin?: number;
  /** Highest acceptable year (default 2100, per `import_ca.py`). */
  yearMax?: number;
  /**
   * Interpret numeric `NN-NN-YYYY` dates day-first (default true). An
   * ambiguous component (both fields <= 12) parses under the chosen
   * reading with an `ambiguous_day_month` advisory warning.
   */
  dayFirst?: boolean;
}

const DEFAULT_YEAR_MIN = 1000;
const DEFAULT_YEAR_MAX = 2100;

// Spanish month names to numbers, including the `setiembre` variant.
const SPANISH_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

// Range separators: `..`, hyphen, and en-dash (U+2013). The multi-char
// `..` must come first so the alternation prefers it.
const SEP = "(?:\\.\\.|-|–)";
// A partial ISO date: YYYY, YYYY-MM, or YYYY-MM-DD.
const ISO_PARTIAL = "\\d{4}(?:-\\d{2})?(?:-\\d{2})?";
// A Spanish month word (accented letters included).
const MONTH_WORD = "[A-Za-zÀ-ÿ]+";

// Per-call parse state: resolved options plus the structured-warning
// collector deep helpers report into (clamping, ambiguity, reversal).
interface Ctx {
  yearMin: number;
  yearMax: number;
  dayFirst: boolean;
  warnings: DateParseWarning[];
  ambiguityWarned: boolean;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

// Last calendar day of a 1-indexed month. Years are always >= 1000 here,
// so the JS two-digit-year remapping never applies.
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Build an ISO date, rejecting out-of-range years and impossible months.
// An over-long stated day clamps down to the month's last day (Feb 31 ->
// Feb 28 or 29) and MUST report the clamp — a silent repair would violate
// the "degrade AND report" half of the asymmetry rule.
function safeIso(
  year: number,
  month: number,
  day: number,
  ctx: Ctx
): string | null {
  if (year < ctx.yearMin || year > ctx.yearMax) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1) return null;
  const lastDay = daysInMonth(year, month);
  if (day > lastDay) {
    const clamped = `${pad(year, 4)}-${pad(month)}-${pad(lastDay)}`;
    ctx.warnings.push({
      code: "date_day_clamped",
      message: `Day ${day} does not exist in ${pad(year, 4)}-${pad(month)}; clamped to ${lastDay}`,
      detail: { year, month, day, clampedDay: lastDay, clampedDate: clamped },
    });
    return clamped;
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

// Last day of a month as ISO, for expanding a partial date's end bound.
// Expansion of an unstated day is not a repair, so it never warns.
function monthEndIso(year: number, month: number, ctx: Ctx): string | null {
  if (year < ctx.yearMin || year > ctx.yearMax) return null;
  if (month < 1 || month > 12) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(daysInMonth(year, month))}`;
}

interface Range {
  start: string | null;
  end: string | null;
}

// Expand one partial ISO component (YYYY, YYYY-MM, or YYYY-MM-DD) into
// its start/end bounds in a single pass, so a stated invalid day clamps
// (and warns) exactly once per component.
function isoPair(raw: string, ctx: Ctx): Range | null {
  const match = raw.trim().match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  if (match[3]) {
    const iso = safeIso(year, Number(match[2]), Number(match[3]), ctx);
    return iso ? { start: iso, end: iso } : null;
  }
  if (match[2]) {
    const month = Number(match[2]);
    const start = safeIso(year, month, 1, ctx);
    const end = monthEndIso(year, month, ctx);
    return start || end ? { start, end } : null;
  }
  const start = safeIso(year, 1, 1, ctx);
  const end = safeIso(year, 12, 31, ctx);
  return start || end ? { start, end } : null;
}

// One side of an ISO range: the low edge when it opens the range, the
// high edge when it closes it.
function isoComponent(raw: string, isStart: boolean, ctx: Ctx): string | null {
  const pair = isoPair(raw, ctx);
  if (!pair) return null;
  return isStart ? pair.start : pair.end;
}

// Numeric NN-NN-YYYY component, field order per ctx.dayFirst. A component
// whose two fields could each be the day or the month is advisory-warned
// (once per expression) with the reading used — the value still parses.
function numericIso(
  first: number,
  second: number,
  year: number,
  component: string,
  ctx: Ctx
): string | null {
  const day = ctx.dayFirst ? first : second;
  const month = ctx.dayFirst ? second : first;
  const iso = safeIso(year, month, day, ctx);
  if (
    iso &&
    first <= 12 &&
    second <= 12 &&
    first !== second &&
    !ctx.ambiguityWarned
  ) {
    ctx.ambiguityWarned = true;
    ctx.warnings.push({
      code: "ambiguous_day_month",
      message: `Numeric date "${component}" is ambiguous (both fields <= 12); interpreted ${ctx.dayFirst ? "day-first" : "month-first"} as ${iso}`,
      detail: { component, dayFirst: ctx.dayFirst, interpretedAs: iso },
    });
  }
  return iso;
}

// One Spanish text component, plain or canonical "de" form:
// "29 Marzo 1815", "3 de marzo de 1875", "setiembre de 1875".
function parseSpanishComponent(s: string, ctx: Ctx): Range | null {
  const dayForm = s.match(
    new RegExp(
      `^(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_WORD})\\s+(?:de\\s+)?(\\d{4})$`,
      "i"
    )
  );
  if (dayForm) {
    const month = SPANISH_MONTHS[dayForm[2].toLowerCase()];
    if (!month) return null;
    const iso = safeIso(Number(dayForm[3]), month, Number(dayForm[1]), ctx);
    return iso ? { start: iso, end: iso } : null;
  }
  const monthForm = s.match(new RegExp(`^(${MONTH_WORD})\\s+de\\s+(\\d{4})$`, "i"));
  if (monthForm) {
    const month = SPANISH_MONTHS[monthForm[1].toLowerCase()];
    if (!month) return null;
    const year = Number(monthForm[2]);
    const start = safeIso(year, month, 1, ctx);
    const end = monthEndIso(year, month, ctx);
    return start || end ? { start, end } : null;
  }
  return null;
}

// Spanish range: two Spanish components around one separator. Spanish
// components contain no separator characters, so a plain split is safe.
function parseSpanishRange(s: string, ctx: Ctx): Range | null {
  const parts = s.split(new RegExp(`\\s*${SEP}\\s*`));
  if (parts.length !== 2) return null;
  const left = parseSpanishComponent(parts[0].trim(), ctx);
  if (!left) return null;
  const right = parseSpanishComponent(parts[1].trim(), ctx);
  if (!right) return null;
  return { start: left.start, end: right.end };
}

function parseNumericSingle(s: string, ctx: Ctx): string | null {
  // Two spellings of the numeric single date: the dash form (`NN-NN-YYYY`,
  // second field two digits so a year range like `1521-1605` never matches)
  // and the slash form (`N/N/YYYY`, the SBMAL master's spelling — a slash is
  // never a range separator, so both fields may be one digit).
  const match =
    s.match(/^(\d{1,2})-(\d{2})-(\d{4})$/) ??
    s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return numericIso(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    s,
    ctx
  );
}

function parseNumericRange(s: string, ctx: Ctx): Range | null {
  const num = "(\\d{1,2})-(\\d{2})-(\\d{4})";
  const iso = "(\\d{4})-(\\d{2})-(\\d{2})";

  const numNum = s.match(new RegExp(`^${num}\\s*${SEP}\\s*${num}$`));
  if (numNum) {
    const [, f1, s1, y1, f2, s2, y2] = numNum;
    return {
      start: numericIso(Number(f1), Number(s1), Number(y1), `${f1}-${s1}-${y1}`, ctx),
      end: numericIso(Number(f2), Number(s2), Number(y2), `${f2}-${s2}-${y2}`, ctx),
    };
  }
  const isoNum = s.match(new RegExp(`^${iso}\\s*${SEP}\\s*${num}$`));
  if (isoNum) {
    const [, y1, m1, d1, f2, s2, y2] = isoNum;
    return {
      start: safeIso(Number(y1), Number(m1), Number(d1), ctx),
      end: numericIso(Number(f2), Number(s2), Number(y2), `${f2}-${s2}-${y2}`, ctx),
    };
  }
  const numIso = s.match(new RegExp(`^${num}\\s*${SEP}\\s*${iso}$`));
  if (numIso) {
    const [, f1, s1, y1, y2, m2, d2] = numIso;
    return {
      start: numericIso(Number(f1), Number(s1), Number(y1), `${f1}-${s1}-${y1}`, ctx),
      end: safeIso(Number(y2), Number(m2), Number(d2), ctx),
    };
  }
  return null;
}

function unparseable(expression: string): DateParseOutcome {
  return {
    result: {
      dateStart: null,
      dateEnd: null,
      dateCertainty: "",
      dateExpression: expression,
    },
    warnings: [
      {
        code: "unparseable_date",
        message: `Could not parse date expression "${expression}"; start and end left empty`,
        detail: { expression },
      },
    ],
  };
}

/**
 * Parse a raw archival date expression into structured fields.
 *
 * Blank input yields an all-null result with no warning (a legitimately
 * absent date). Uncertain markers pass through unparsed with an
 * `uncertain_date` warning; a reversed range degrades to null bounds
 * with a `reversed_date_range` warning; anything else that fails to
 * parse degrades with an `unparseable_date` warning. Never throws.
 */
export function parseDateExpression(
  raw: string | null | undefined,
  options: DateParseOptions = {}
): DateParseOutcome {
  const ctx: Ctx = {
    yearMin: options.yearMin ?? DEFAULT_YEAR_MIN,
    yearMax: options.yearMax ?? DEFAULT_YEAR_MAX,
    dayFirst: options.dayFirst ?? true,
    warnings: [],
    ambiguityWarned: false,
  };

  const expression = (raw ?? "").trim();

  // Blank is "no date supplied" — not a degradation.
  if (expression === "") {
    return {
      result: {
        dateStart: null,
        dateEnd: null,
        dateCertainty: "",
        dateExpression: "",
      },
      warnings: [],
    };
  }

  // Strip leading punctuation (e.g. ",1824-01-02") before length checks.
  const s = expression.replace(/^[,;.\s]+/, "");

  if (s.length < 4) return unparseable(expression);

  // Qualified dates pass through unparsed, flagged for review, keeping
  // the distinction the source drew: circa forms mean the cataloguer
  // estimated the date ("approximate"); a question mark means they
  // doubted it ("uncertain"). A "?" outranks a circa marker when both
  // appear. Bare "ca" counts only as a standalone word (start-anchored
  // or space-delimited), so words merely containing "ca" ("cerca",
  // "Cauca") never match.
  const lower = s.toLowerCase();
  const hasQuestionMark = s.includes("?");
  const hasCirca =
    lower.includes("ca.") ||
    lower.includes("circa") ||
    /(^|\s)ca(\s|$)/.test(lower);
  if (hasQuestionMark || hasCirca) {
    const certainty = hasQuestionMark ? "uncertain" : "approximate";
    return {
      result: {
        dateStart: null,
        dateEnd: null,
        dateCertainty: certainty,
        dateExpression: expression,
      },
      warnings: [
        {
          code: "uncertain_date",
          message: `Qualified date "${expression}" left unparsed for review (${certainty})`,
          detail: { expression, certainty },
        },
      ],
    };
  }

  // Wrap a parsed range as the final outcome. A reversed range is never
  // swapped (swapping would fabricate intent): both bounds degrade to
  // null and the reversal is reported.
  const finish = (range: Range | null): DateParseOutcome | null => {
    if (!range) return null;
    const { start, end } = range;
    if (!start && !end) return null;
    if (start && end && start > end) {
      ctx.warnings.push({
        code: "reversed_date_range",
        message: `Date range "${expression}" is reversed (start ${start} is after end ${end}); bounds left empty`,
        detail: { dateStart: start, dateEnd: end },
      });
      return {
        result: {
          dateStart: null,
          dateEnd: null,
          dateCertainty: "",
          dateExpression: expression,
        },
        warnings: ctx.warnings,
      };
    }
    return {
      result: {
        dateStart: start,
        dateEnd: end,
        dateCertainty: "",
        dateExpression: expression,
      },
      warnings: ctx.warnings,
    };
  };

  // Order mirrors import_ca.py: Spanish, then numeric, then ISO forms.
  let out = finish(parseSpanishRange(s, ctx));
  if (out) return out;

  out = finish(parseSpanishComponent(s, ctx));
  if (out) return out;

  out = finish(parseNumericRange(s, ctx));
  if (out) return out;

  const numericSingle = parseNumericSingle(s, ctx);
  out = finish(
    numericSingle ? { start: numericSingle, end: numericSingle } : null
  );
  if (out) return out;

  // ISO range: "YYYY[-MM[-DD]] .. YYYY[-MM[-DD]]" (or - / en-dash).
  const isoRange = s.match(
    new RegExp(`^(${ISO_PARTIAL})\\s*${SEP}\\s*(${ISO_PARTIAL})$`)
  );
  if (isoRange) {
    out = finish({
      start: isoComponent(isoRange[1], true, ctx),
      end: isoComponent(isoRange[2], false, ctx),
    });
    if (out) return out;
  }

  // End-only "- 1878-12-01" — duplicate onto start.
  const endOnly = s.match(new RegExp(`^-\\s*(${ISO_PARTIAL})$`));
  if (endOnly) {
    out = finish(isoPair(endOnly[1], ctx));
    if (out) return out;
  }

  // Start-only ".. 1823-04-06" — duplicate onto end.
  const startOnly = s.match(new RegExp(`^\\.\\.\\s*(${ISO_PARTIAL})$`));
  if (startOnly) {
    out = finish(isoPair(startOnly[1], ctx));
    if (out) return out;
  }

  // Single ISO date: YYYY, YYYY-MM, or YYYY-MM-DD.
  if (/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(s)) {
    out = finish(isoPair(s, ctx));
    if (out) return out;
  }

  return unparseable(expression);
}
