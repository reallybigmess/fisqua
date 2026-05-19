/**
 * Repository Validation
 *
 * This module deals with the Zod schemas for repository-row writes:
 * display metadata, short code, locality, and enabled flag. Shared by
 * the admin routes and the bulk import CLI.
 *
 * @version v0.3.0
 */
import { z } from "zod/v4";

export const repositorySchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(255),
  shortName: z.string().max(200).optional(),
  countryCode: z.string().max(3).default("COL"),
  country: z.string().max(100).optional(),
  city: z.string().max(100).optional(),
  address: z.string().optional(),
  website: z.string().url().optional(),
  notes: z.string().optional(),
  rightsText: z.string().optional(),
  enabled: z.boolean().default(true),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const createRepositorySchema = repositorySchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateRepositorySchema = repositorySchema
  .partial()
  .required({ id: true });

export const importRepositorySchema = repositorySchema;
