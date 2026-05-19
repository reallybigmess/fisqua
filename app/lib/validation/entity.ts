/**
 * Entity Validation Schemas
 *
 * This module deals with the Zod schemas that validate entity
 * authority records on every write path -- create, edit, bulk
 * import, and autosave draft. The
 * `entitySchema` captures the full shape the DB expects and is
 * intentionally stricter than the UI form: the admin UI may defer
 * optional fields, but a row committed to `entities` has to satisfy
 * every declared constraint. The `entityCode` regex pins the
 * `ne-xxxxxx` format (6 lowercase alphanumeric characters from a
 * 32-char alphabet) so external references have a stable shape.
 *
 * Migration `drizzle/0036_union_schema.sql` dropped `legal_status`
 * (0% populated in production audit) and added `dbe_id` (Diccionario
 * Biográfico Electrónico authority ref) and the generic `legacy_ids`
 * JSON column.
 *
 * @version v0.4.0
 */

import { z } from "zod/v4";
import { ENTITY_TYPES } from "./enums";

export const entitySchema = z.object({
  id: z.string().uuid(),
  entityCode: z.string().regex(/^ne-[a-z2-9]{6}$/), // 6-char from 32-char alphabet
  displayName: z.string().min(1).max(500),
  sortName: z.string().min(1).max(500),
  surname: z.string().max(200).optional(),
  givenName: z.string().max(200).optional(),
  entityType: z.enum(ENTITY_TYPES),
  honorific: z.string().max(100).optional(),
  primaryFunction: z.string().max(300).optional(),
  nameVariants: z.string().default("[]"), // JSON string
  datesOfExistence: z.string().max(100).optional(),
  dateStart: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable()
    .optional(),
  dateEnd: z
    .string()
    .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
    .nullable()
    .optional(),
  history: z.string().optional(),
  functions: z.string().optional(),
  sources: z.string().optional(),
  mergedInto: z.string().uuid().nullable().optional(),
  wikidataId: z.string().max(20).nullable().optional(),
  viafId: z.string().max(20).nullable().optional(),
  // Diccionario Biográfico Electrónico authority ref (added in 0036).
  dbeId: z.string().max(20).nullable().optional(),
  // Generic legacy id JSON column (0036). Full Zod shape lives in
  // app/lib/validation/legacy-ids.ts.
  legacyIds: z.string().default("[]"),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createEntitySchema = entitySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateEntitySchema = entitySchema
  .partial()
  .required({ id: true });

export const importEntitySchema = entitySchema;
