/**
 * Place Validation Schemas
 *
 * This module deals with the Zod schemas that validate place
 * authority records on every write path -- create, edit, bulk
 * import, and autosave draft. The
 * `placeSchema` captures the full Linked Places-adjacent shape with
 * coordinates and external authority IDs (Getty TGN, WHG, HGIS).
 * The `placeCode` regex pins the `nl-xxxxxx` format (6 lowercase
 * alphanumeric characters from a 32-char alphabet) so external
 * references stay stable across merges and renames.
 *
 * Migration `drizzle/0036_union_schema.sql` dropped
 * historical_gobernacion, historical_partido, historical_region,
 * country_code, admin_level_1, admin_level_2, and wikidata_id from
 * the places table (0% populated in production audit). It added the
 * `fclass` column (5-value GeoNames feature class) with a CHECK
 * constraint and `legacyIds` JSON for migration provenance.
 *
 * @version v0.4.3
 */

import { z } from "zod/v4";
import { PLACE_TYPES, GEONAMES_FCLASSES, COORDINATE_PRECISIONS } from "./enums";

export const placeSchema = z.object({
  id: z.string().uuid(),
  placeCode: z.string().regex(/^nl-[a-z2-9]{6}$/), // 6-char from 32-char alphabet
  label: z.string().min(1).max(255),
  displayName: z.string().min(1).max(500),
  placeType: z.enum(PLACE_TYPES).nullable().optional(),
  nameVariants: z.string().default("[]"), // JSON string
  parentId: z.string().uuid().nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  // Controlled vocabulary (migration 0060); NULL = not recorded. The
  // form boundary coerces the select's empty value to null before this
  // runs, so an unset precision arrives as null, never "".
  coordinatePrecision: z.enum(COORDINATE_PRECISIONS).nullable().optional(),
  mergedInto: z.string().uuid().nullable().optional(),
  tgnId: z.string().max(20).nullable().optional(),
  hgisId: z.string().max(50).nullable().optional(),
  whgId: z.string().max(50).nullable().optional(),
  // 5-value GeoNames feature class enum (added in 0036).
  fclass: z.enum(GEONAMES_FCLASSES).nullable().optional(),
  // Generic legacy id JSON column (0036). Stored as a JSON string at
  // the DB layer; full Zod shape lives in app/lib/validation/legacy-ids.ts.
  legacyIds: z.string().default("[]"),
  // Free-text notes pair (migration 0059). `notes` may eventually
  // publish; `internalNotes` never leaves the admin surface (excluded
  // from the export pipeline). Both nullable — absent = no note.
  notes: z.string().nullable().optional(),
  internalNotes: z.string().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createPlaceSchema = placeSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updatePlaceSchema = placeSchema.partial().required({ id: true });

export const importPlaceSchema = placeSchema;
