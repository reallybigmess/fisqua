/**
 * CSV intake — RFC 4180 parser with strict UTF-8 decoding
 *
 * This module deals with turning uploaded spreadsheet bytes into a
 * header row and data rows, as a pure function with no dependencies.
 * Two stages, each independently testable:
 *
 *   - `decodeUtf8` accepts UTF-8 including a leading BOM (the
 *     `utf-8-sig` Excel reality), strips the BOM, and decodes in
 *     TextDecoder fatal mode so a non-UTF-8 file surfaces as a named
 *     `CsvEncodingError` rather than mojibake (spec §4.1).
 *
 *   - `parseCsv` is an RFC 4180 state machine: comma field separators,
 *     CRLF / LF / lone-CR record separators, quoted fields carrying
 *     embedded commas and newlines, and doubled quotes as one literal
 *     quote inside a quoted field. The first record is the header row;
 *     `rowCount` counts data rows only.
 *
 * A quote opens a field only at the field's start; a quote elsewhere in
 * an unquoted field is a literal character, so `abc"def` round-trips
 * verbatim. Fully blank physical lines carry no field data and are
 * dropped so a trailing newline never fabricates an empty record.
 *
 * The parser never mutates and never touches I/O. Every rejection is a
 * NAMED error: bad bytes (`CsvEncodingError`), no header row, an
 * unterminated quoted field, or duplicated header names — the last two
 * because both silently corrupt structure (a runaway quote merges the
 * rest of the file into one cell; duplicate headers make binding by
 * header name ambiguous, an identifier-class failure).
 *
 * @version v0.6.0
 */

/** A file whose bytes are not valid UTF-8. Staging must reject, never coerce. */
export class CsvEncodingError extends Error {
  readonly code = "csv_encoding" as const;
  constructor(message = "File is not valid UTF-8") {
    super(message);
    this.name = "CsvEncodingError";
  }
}

export type CsvParseErrorCode =
  | "empty_csv"
  | "unterminated_quote"
  | "duplicate_headers";

/**
 * A structurally unusable CSV: no header row, an unterminated quoted
 * field (the rest of the file would silently merge into one cell), or
 * duplicated header names (binding by header name would be ambiguous —
 * an identifier-class failure, so the file is rejected at intake per
 * the asymmetry rule).
 */
export class CsvParseError extends Error {
  readonly code: CsvParseErrorCode;
  /** The duplicated header names, populated for `duplicate_headers`. */
  readonly headers?: string[];
  constructor(code: CsvParseErrorCode, message: string, headers?: string[]) {
    super(message);
    this.name = "CsvParseError";
    this.code = code;
    this.headers = headers;
  }
}

export interface ParsedCsv {
  /** The first record's fields, in file order. */
  headers: string[];
  /** Every record after the header, each an array aligned to no fixed width. */
  rows: string[][];
  /** Count of data rows (records after the header). */
  rowCount: number;
}

const BOM = 0xfeff;

/**
 * Decode raw upload bytes as UTF-8, stripping a leading BOM. Throws
 * `CsvEncodingError` on any byte sequence that is not valid UTF-8 —
 * fatal mode is what keeps a Latin-1 or UTF-16 file from silently
 * decoding into replacement characters and corrupting every cell.
 */
export function decodeUtf8(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    throw new CsvEncodingError();
  }
  // A decoded BOM surfaces as U+FEFF at the string head; drop it.
  if (text.charCodeAt(0) === BOM) return text.slice(1);
  return text;
}

/**
 * Parse RFC 4180 CSV text into a header row and data rows. The first
 * record is the header; `rowCount` counts the rest. Throws a named
 * `CsvParseError`: `empty_csv` when no records are present,
 * `unterminated_quote` when a quoted field never closes, and
 * `duplicate_headers` when two header cells carry the same name.
 */
export function parseCsv(text: string): ParsedCsv {
  const records = scanRecords(text);
  if (records.length === 0) {
    throw new CsvParseError("empty_csv", "CSV has no header row");
  }
  const [headers, ...rows] = records;

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const header of headers) {
    if (seen.has(header)) duplicated.add(header);
    seen.add(header);
  }
  if (duplicated.size > 0) {
    const names = [...duplicated];
    throw new CsvParseError(
      "duplicate_headers",
      `CSV has duplicated header names: ${names.join(", ")}`,
      names,
    );
  }

  return { headers, rows, rowCount: rows.length };
}

/**
 * Convenience: decode then parse in one step, the shape the upload
 * intake needs. Encoding failure raises before any parse work runs, so
 * a rejected file never reaches the staging store.
 */
export function decodeAndParseCsv(bytes: Uint8Array | ArrayBuffer): ParsedCsv {
  return parseCsv(decodeUtf8(bytes));
}

// The RFC 4180 scanner. Walks the string once, tracking whether the
// cursor sits inside a quoted field. Field and record boundaries are
// resolved as they are reached; a doubled quote inside quotes collapses
// to one literal quote.
function scanRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  // True once the current field has begun accumulating characters or a
  // separator has committed a field — distinguishes "" (real empty
  // field) from "no field started yet".
  let fieldStarted = false;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    // Drop a record that is a single empty field: a blank physical line
    // (including the artefact of a trailing newline) carries no data.
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record);
    }
    record = [];
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }

    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
    } else if (c === ",") {
      endField();
      i += 1;
    } else if (c === "\r") {
      // CRLF and lone CR both end the record; consume the paired LF.
      endRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (c === "\n") {
      endRecord();
      i += 1;
    } else {
      field += c;
      fieldStarted = true;
      i += 1;
    }
  }

  // EOF inside a quoted field: the quote never closed, so everything
  // after it has silently merged into one cell. Rejecting is the only
  // honest option — flushing would hand back a structurally wrong file.
  if (inQuotes) {
    throw new CsvParseError(
      "unterminated_quote",
      "CSV has an unterminated quoted field",
    );
  }

  // Flush a final record that had no trailing newline. `field !== ""`
  // or a non-empty record means real trailing content; `fieldStarted`
  // catches a trailing empty quoted field ("").
  if (field !== "" || record.length > 0 || fieldStarted) {
    endRecord();
  }

  return records;
}
