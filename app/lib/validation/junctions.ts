/**
 * Junction Table Validation
 *
 * This module deals with the Zod schemas for the description ->
 * entity and description -> place junction rows. They are used by
 * the API routes that mutate those relationships and by the bulk
 * import CLI to reject rows that would violate referential
 * integrity.
 *
 * @version v0.4.0
 */
import { z } from "zod/v4";
import { ENTITY_ROLES, PLACE_ROLES, CERTAINTY_LEVELS } from "./enums";

// --- DescriptionEntity ---

export const descriptionEntitySchema = z.object({
  id: z.string().uuid(),
  descriptionId: z.string().uuid(),
  entityId: z.string().uuid(),
  role: z.enum(ENTITY_ROLES),
  roleNote: z.string().optional(),
  sequence: z.number().int().min(0).default(0),
  honorific: z.string().max(100).optional(), // documentary styling
  function: z.string().max(300).optional(), // documentary styling
  nameAsRecorded: z.string().max(500).optional(), // documentary styling
  createdAt: z.number().int(),
});

export const createDescriptionEntitySchema = descriptionEntitySchema.omit({
  id: true,
  createdAt: true,
});

export const updateDescriptionEntitySchema = descriptionEntitySchema
  .partial()
  .required({ id: true });

export const importDescriptionEntitySchema = descriptionEntitySchema;

// --- DescriptionPlace ---

export const descriptionPlaceSchema = z.object({
  id: z.string().uuid(),
  descriptionId: z.string().uuid(),
  placeId: z.string().uuid(),
  role: z.enum(PLACE_ROLES),
  roleNote: z.string().optional(),
  createdAt: z.number().int(),
});

export const createDescriptionPlaceSchema = descriptionPlaceSchema.omit({
  id: true,
  createdAt: true,
});

export const updateDescriptionPlaceSchema = descriptionPlaceSchema
  .partial()
  .required({ id: true });

export const importDescriptionPlaceSchema = descriptionPlaceSchema;

// --- EntityFunction ---

export const entityFunctionSchema = z.object({
  id: z.string().uuid(),
  entityId: z.string().uuid(),
  honorific: z.string().max(100).optional(),
  function: z.string().min(1).max(300),
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
  dateNote: z.string().max(100).optional(),
  certainty: z.enum(CERTAINTY_LEVELS).default("probable"),
  source: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createEntityFunctionSchema = entityFunctionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateEntityFunctionSchema = entityFunctionSchema
  .partial()
  .required({ id: true });

export const importEntityFunctionSchema = entityFunctionSchema;
