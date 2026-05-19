/**
 * Scripts — import validation helpers
 *
 * This module deals with two layers of validation for the import pipeline:
 *
 *   1. `validateRows(rows, schema, tableName)` — generic batch
 *      validator. Each command (`scripts/commands/*`) hands a Zod
 *      schema specific to its row shape (the "import-shape" schema —
 *      Django-keyed snake_case, dates as ISO strings, numbers as the
 *      Django pk types). Per-row failures are collected, never thrown,
 *      so a malformed row soft-skips and the rest of the table imports.
 *
 *   2. `validateRowAgainstImportSchemas(record, table)` — catch-all
 *      that runs at the orchestrator boundary. For `descriptions` it
 *      wraps `importDescriptionSchema` (the v0.4 union schema in
 *      `app/lib/validation/description.ts`); for the other three
 *      tenanted tables it runs light NOT-NULL sanity checks. The
 *      heavier work belongs to the per-table commands; this function
 *      is the orchestrator's safety net.
 *
 * Import-time validation enforces schema-level + sanity invariants
 * only. Per-standard mandatoriness (the descriptive-standard factory
 * in app/lib/validation that returns DACS/RAD/ISAD(G)-specific
 * validators) is NOT applied at the import boundary — that validator
 * family targets cataloguer-authored data created against an explicit
 * descriptive standard. The bulk import absorbs Neogranadina's
 * pre-standard Django corpus, which would reject ~70% of rows under
 * the stricter per-standard validator. Operators move rows up to
 * standard compliance through the cataloguing UI after import; the
 * one-shot bulk import is not gated on it. Validators imported here
 * MUST stay shallow.
 *
 * `validateLegacyIdsValue(jsonString)` is the round-trip gate every
 * row builder's emitted `legacy_ids` JSON passes through. It composes
 * `JSON.parse` + `LegacyIdsSchema.safeParse`; both parser and schema
 * failures surface as structured message arrays so the orchestrator
 * can aggregate them into the per-table FailureReport without
 * throwing.
 *
 * @version v0.4.0
 */
import type { z } from "zod/v4";
import type { ImportError } from "./types";
import { importDescriptionSchema } from "../../app/lib/validation/description";
import { LegacyIdsSchema } from "../../app/lib/validation/legacy-ids";

/**
 * Validate an array of rows against a Zod schema, collecting errors
 * per-row without aborting the batch.
 *
 * @param rows - Array of raw data objects to validate
 * @param schema - Zod schema to validate against
 * @param tableName - Table name for error reporting
 * @returns Object with valid parsed rows and collected errors
 */
export function validateRows<T>(
  rows: unknown[],
  schema: z.ZodType<T>,
  tableName: string
): { valid: T[]; errors: ImportError[] } {
  const valid: T[] = [];
  const errors: ImportError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const result = schema.safeParse(row);

    if (result.success) {
      valid.push(result.data);
    } else {
      errors.push({
        table: tableName,
        row: i,
        oldId: (row?.id as number | string) ?? i,
        errors: result.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`
        ),
      });
    }
  }

  return { valid, errors };
}

/**
 * The four tenanted tables the orchestrator runs through.
 * `entity_functions` and the two junction tables are intentionally
 * absent — their row shapes are FK-driven and the per-command builders
 * cover their structural checks.
 */
export type ImportTable = "descriptions" | "entities" | "places" | "repositories";

/**
 * Orchestrator-side row validator. For `descriptions`, runs the row
 * through `importDescriptionSchema` and aggregates field-path messages
 * on failure. For the other three tenanted tables, runs a single
 * NOT-NULL sanity check on the column most likely to be empty in a
 * malformed Django export (display_name, label, code).
 *
 * Returns `{ ok, messages }` rather than throwing so the orchestrator
 * can append messages to a per-table FailureReport entry without
 * unwinding the run. This validator stays shallow on purpose; heavier
 * per-row checks belong to the per-table command in
 * `scripts/commands/*`.
 */
export function validateRowAgainstImportSchemas(
  record: Record<string, unknown>,
  table: ImportTable,
): { ok: boolean; messages: string[] } {
  const messages: string[] = [];

  if (table === "descriptions") {
    const result = importDescriptionSchema.safeParse(record);
    if (!result.success) {
      for (const issue of result.error.issues) {
        messages.push(`${issue.path.join(".")}: ${issue.message}`);
      }
      return { ok: false, messages };
    }
    return { ok: true, messages: [] };
  }

  // Light NOT-NULL sanity checks for the other three tenanted tables.
  // These enforce schema-level invariants only; the per-table command
  // in scripts/commands/* carries the row-shape checks.
  if (table === "entities") {
    if (record.display_name === null || record.display_name === undefined) {
      messages.push("display_name: required");
    }
  } else if (table === "places") {
    if (record.label === null || record.label === undefined) {
      messages.push("label: required");
    }
  } else if (table === "repositories") {
    if (record.code === null || record.code === undefined) {
      messages.push("code: required");
    }
  }

  return { ok: messages.length === 0, messages };
}

/**
 * Round-trip a serialised `legacy_ids` JSON string through
 * `LegacyIdsSchema`. Both parser failures (malformed JSON) and schema
 * failures (well-formed JSON, wrong shape) surface as structured
 * message arrays — the FailureReport aggregator is the consumer.
 *
 * Every row builder's emitted `legacy_ids` value should round-trip
 * cleanly because `scripts/lib/transform.ts` validates before
 * stringify. This helper is the orchestrator's runtime backstop in
 * case a builder ever forgets the validate-before-stringify pattern.
 */
export function validateLegacyIdsValue(
  jsonString: string,
): { ok: boolean; messages: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return {
      ok: false,
      messages: [`legacy_ids: not valid JSON (${(err as Error).message})`],
    };
  }
  const result = LegacyIdsSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      messages: result.error.issues.map(
        (i) => `legacy_ids.${i.path.join(".")}: ${i.message}`,
      ),
    };
  }
  return { ok: true, messages: [] };
}

// Version: v0.4.0
