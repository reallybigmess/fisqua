/**
 * Shared Enum Arrays
 *
 * This module deals with the single source of truth for the
 * controlled-vocabulary arrays used by the Drizzle schema, the Zod
 * validation schemas, and the vocabularies admin surfaces. Values
 * mirror the Django backend (`catalog/models.py`) exactly so a
 * payload that validates here validates there too.
 *
 * @version v0.4.0
 */

// Description levels
export const DESCRIPTION_LEVELS = [
  "fonds", "subfonds", "series", "subseries",
  "file", "item", "collection", "section", "volume",
] as const;

// Resource types
export const RESOURCE_TYPES = [
  "text", "still_image", "cartographic", "mixed",
] as const;

// Entity types
export const ENTITY_TYPES = ["person", "family", "corporate"] as const;

// EntityFunction certainty levels (from EntityFunction.Certainty)
export const CERTAINTY_LEVELS = ["certain", "probable", "possible"] as const;

// Place types
export const PLACE_TYPES = [
  "country", "region", "department", "province", "partido",
  "city", "town", "parish", "hacienda", "mine", "river", "other",
] as const;

// Entity roles in descriptions
export const ENTITY_ROLES = [
  "creator", "author", "editor", "publisher",
  "sender", "recipient",
  "mentioned", "subject",
  "scribe", "witness", "notary",
  "photographer", "artist",
  "plaintiff", "defendant", "petitioner", "judge", "appellant",
  "apoderado",
  "official",
  "heir", "albacea", "spouse", "victim",
  "grantor", "donor", "seller", "buyer",
  "mortgagor", "mortgagee", "creditor", "debtor", "fiador",
] as const;

// Place roles in descriptions
export const PLACE_ROLES = [
  "created", "subject", "mentioned",
  "sent_from", "sent_to", "published", "venue",
] as const;

// Vocabulary term statuses
export const VOCABULARY_STATUSES = ["approved", "proposed", "deprecated"] as const;

// Function categories for vocabulary terms
export const FUNCTION_CATEGORIES = [
  "civil_office", "military_rank", "ecclesiastical_office", "academic_degree",
  "honorific", "occupation_trade", "documentary_role", "kinship",
  "status_condition", "institutional_ref",
] as const;
