/**
 * Scripts — import transforms
 *
 * This module deals with the field-level transforms that the import row
 * builders run on every Django row before handing it to the SQL writer. `toEpochSeconds`,
 * `toIsoDate`, and `stringifyJsonArray` cover the boring shape
 * conversions: ISO timestamps to epoch seconds, partial dates passed
 * through, and the JSON-array column normalisation that lets the row
 * builder hand SQL a literal `'[]'` even when the source value is
 * missing.
 *
 * The three `buildLegacyIds*` helpers — one per domain table that
 * carries a `legacy_ids` column in the v0.4 union schema — each
 * produce a JSON string with one record per upstream provenance
 * source. Every helper validates its output through
 * `LegacyIdsSchema.parse(...)` before stringify; a malformed
 * `legacy_ids` value cannot leave this module.
 *
 * The provider strings are `django-zasqua`, `ca-object`,
 * `ca-collection`, `ca-entity`, and `ca-place`. Django's
 * `catalog_place.ca_place_ids` is a JSON array — multiple
 * CollectiveAccess places can collapse to a single Fisqua place via
 * merge, so `buildLegacyIdsForPlace` emits one `ca-place` entry per
 * array element rather than a single value.
 *
 * @version v0.4.0
 */

import { LegacyIdsSchema } from "../../app/lib/validation/legacy-ids";

/**
 * Convert an ISO datetime string to Unix epoch seconds.
 * Returns null for null/undefined input.
 */
export function toEpochSeconds(
  isoString: string | null | undefined
): number | null {
  if (isoString === null || isoString === undefined) return null;
  return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Pass through a date string (YYYY-MM-DD or partial YYYY / YYYY-MM).
 * Returns null for null/undefined input.
 */
export function toIsoDate(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined) return null;
  return value;
}

/**
 * Convert a value to a JSON array string.
 * - Array -> JSON.stringify
 * - String -> return as-is (assumed already JSON)
 * - null/undefined -> "[]"
 */
export function stringifyJsonArray(value: unknown): string {
  if (value === null || value === undefined) return "[]";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  return "[]";
}

/**
 * Build a `legacy_ids` JSON string for a description row.
 *
 * Reads `id` (Django pk → "django-zasqua"), `ca_object_id` (CA object
 * pk → "ca-object"), and `ca_collection_id` (CA collection pk →
 * "ca-collection") from the input record. Null/undefined values are
 * omitted. The optional `extras` list is appended verbatim — the
 * importer uses it to record `{provider: "ocr-truncated", id: <bytes>}`
 * for descriptions whose ocr_text was clipped to fit D1's 100 KB
 * statement limit (see `OCR_MAX_BYTES` in `scripts/commands/descriptions.ts`
 * and the deferred OCR-to-R2 migration). The result is
 * Validated through `LegacyIdsSchema.parse` before stringify so a
 * malformed input cannot produce a malformed output.
 */
export function buildLegacyIdsForDescription(
  record: Record<string, unknown>,
  extras?: Array<{ provider: string; id: string | number }>,
): string {
  const ids: Array<{ provider: string; id: string | number }> = [];
  if (record.id !== null && record.id !== undefined) {
    ids.push({ provider: "django-zasqua", id: record.id as number });
  }
  if (record.ca_object_id !== null && record.ca_object_id !== undefined) {
    ids.push({ provider: "ca-object", id: record.ca_object_id as number });
  }
  if (
    record.ca_collection_id !== null &&
    record.ca_collection_id !== undefined
  ) {
    ids.push({
      provider: "ca-collection",
      id: record.ca_collection_id as number,
    });
  }
  if (extras && extras.length > 0) {
    ids.push(...extras);
  }
  return JSON.stringify(LegacyIdsSchema.parse(ids));
}

/**
 * Build a `legacy_ids` JSON string for an entity row.
 *
 * Reads `id` (Django pk → "django-zasqua") and `ca_entity_id` (CA
 * entity pk → "ca-entity") from the input record. Null/undefined
 * values are omitted. Validates through `LegacyIdsSchema.parse`
 * before stringify.
 */
export function buildLegacyIdsForEntity(
  record: Record<string, unknown>
): string {
  const ids: Array<{ provider: string; id: string | number }> = [];
  if (record.id !== null && record.id !== undefined) {
    ids.push({ provider: "django-zasqua", id: record.id as number });
  }
  if (record.ca_entity_id !== null && record.ca_entity_id !== undefined) {
    ids.push({ provider: "ca-entity", id: record.ca_entity_id as number });
  }
  return JSON.stringify(LegacyIdsSchema.parse(ids));
}

/**
 * Build a `legacy_ids` JSON string for a place row.
 *
 * Reads `id` (Django pk → "django-zasqua") and `ca_place_ids`
 * (Django's JSON-array column on `catalog_place`). Each element of
 * `ca_place_ids` becomes a separate `ca-place` entry, so a Fisqua
 * place that collapses two CA places via merge carries provenance for
 * both. Validates through `LegacyIdsSchema.parse` before stringify.
 */
export function buildLegacyIdsForPlace(
  record: Record<string, unknown>
): string {
  const ids: Array<{ provider: string; id: string | number }> = [];
  if (record.id !== null && record.id !== undefined) {
    ids.push({ provider: "django-zasqua", id: record.id as number });
  }
  // Django catalog_place.ca_place_ids is a JSON ARRAY — many CA places
  // can collapse to one Fisqua place via merge; emit one ca-place
  // record per array element so all provenance survives.
  const caIds = record.ca_place_ids;
  if (Array.isArray(caIds)) {
    for (const caId of caIds) {
      if (caId !== null && caId !== undefined) {
        ids.push({ provider: "ca-place", id: caId as number });
      }
    }
  }
  return JSON.stringify(LegacyIdsSchema.parse(ids));
}

// Version: v0.4.0
