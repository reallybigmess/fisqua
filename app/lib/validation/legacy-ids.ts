/**
 * Legacy Ids JSON Schema
 *
 * This module deals with the Zod schema for the `legacy_ids` column
 * shape on descriptions, entities, and places. Each row carries an
 * array of `{provider, id}` records that map to historical
 * identifiers in upstream systems (Django pk during the v0.4
 * production import, CA object/collection ids for Neogranadina rows,
 * etc.).
 *
 * The column type at the DB layer is `text`; this Zod schema is the
 * runtime gate at every read/write boundary. The bulk-import path is
 * the first writer; future ingest paths (a future second tenant, a
 * VIAF-import script, etc.) reuse this schema.
 *
 * Shape: `Array<{provider: string, id: string | number}>`. Provider is a
 * free-form vendor tag (e.g. "django-zasqua", "ca", "ca-collection",
 * "viaf-import-2026"); id is whatever the upstream system uses (CA and
 * Django use ints; future tenants may use strings).
 *
 * @version v0.4.0
 */

import { z } from "zod/v4";

export const LegacyIdSchema = z.object({
  provider: z.string().min(1),
  id: z.union([z.string().min(1), z.number()]),
});

export const LegacyIdsSchema = z.array(LegacyIdSchema);

export type LegacyId = z.infer<typeof LegacyIdSchema>;
export type LegacyIds = z.infer<typeof LegacyIdsSchema>;
