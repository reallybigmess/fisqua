/**
 * Draft Validation
 *
 * This module deals with the Zod schemas that validate the autosave
 * JSON blob shape per record type (description, repository, entity,
 * place) before it lands in the `drafts` table.
 *
 * @version v0.3.0
 */

import { z } from "zod/v4";

export const RECORD_TYPES = ["description", "repository", "entity", "place"] as const;

export const draftSchema = z.object({
  recordId: z.string().min(1),
  recordType: z.enum(RECORD_TYPES),
  snapshot: z.string().min(1),
});

export const changelogSchema = z.object({
  recordId: z.string().min(1),
  recordType: z.enum(RECORD_TYPES),
  note: z.string().optional(),
  diff: z.string().min(1),
});
