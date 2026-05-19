/**
 * Vocabulary Validation
 *
 * This module deals with the Zod schemas for vocabulary term writes:
 * label payload keyed by locale, category, status, and the merge /
 * split payload shapes. Shared by the vocabularies admin routes and
 * the bulk import CLI.
 *
 * @version v0.3.0
 */
import { z } from "zod/v4";
import { VOCABULARY_STATUSES, FUNCTION_CATEGORIES } from "./enums";

export const vocabularyTermSchema = z.object({
  id: z.string().uuid().optional(),
  canonical: z.string().min(1).max(500),
  category: z.enum(FUNCTION_CATEGORIES).nullable().optional(),
  status: z.enum(VOCABULARY_STATUSES).default("approved"),
  notes: z.string().max(2000).nullable().optional(),
});

export type VocabularyTermInput = z.infer<typeof vocabularyTermSchema>;
