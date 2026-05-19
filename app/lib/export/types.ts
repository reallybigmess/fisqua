/**
 * Export Record Types
 *
 * This module deals with the TypeScript shapes for the JSON records
 * the publish pipeline emits. Each interface mirrors exactly one
 * published artefact (description, repository, entity, place, nested
 * child entry) so the formatters and the R2 writers cannot drift
 * apart without a compiler error.
 *
 * `ExportTenant` is the resolved tenant context threaded through every
 * pipeline step. The shape is deliberately narrow (id + slug +
 * descriptiveStandard) so the workflow can load it once at start
 * without dragging the full Drizzle row through every step boundary;
 * downstream EAD3 + DC pipelines read `descriptiveStandard` to pick
 * the active per-standard profile.
 *
 * `EadProfile`, `EadInput`, and `EadRepository` are the EAD3-builder
 * data contract. `EadProfile` cross-references each standard's
 * per-level mandatoriness from `app/lib/standards/<std>.ts` (the
 * single source of truth) and adds only EAD-specific
 * wrapping/placement choices. The closed-map registry at
 * `app/lib/export/ead/profiles/registry.ts` resolves a tenant's
 * `descriptiveStandard` to the right profile.
 *
 * @version v0.4.0
 */

import type { Standard } from "../standards/types";

/**
 * Resolved tenant context threaded through every export step. The
 * three fields are everything the pipeline needs:
 *
 *   - `id`    — joined into every D1 read so cross-tenant rows
 *               cannot leak.
 *   - `slug`  — prefixed onto every R2 key so cross-tenant objects
 *               cannot collide. Slug rather than UUID because tenant
 *               slugs are immutable and human-readable in `rclone ls`.
 *   - `descriptiveStandard` — picks the active per-standard EAD3
 *               profile. Carried through every step even when only
 *               the EAD3 builder reads it, so downstream callers
 *               don't need a second sweep.
 */
export type ExportTenant = {
  id: string;
  slug: string;
  descriptiveStandard: "isadg" | "dacs" | "rad";
};

/** Description record in the exported descriptions.json */
export interface ExportDescription {
  id: string;
  repository_code: string;
  country: string;
  reference_code: string;
  local_identifier: string;
  title: string;
  description_level: string;
  date_expression: string | null;
  date_start: string | null;
  parent_id: string | null;
  parent_reference_code: string | null;
  has_children: boolean;
  child_count: number;
  children_level: string | null;
  has_digital: boolean;
  iiif_manifest_url: string;
  mets_url: string;
  scope_content: string | null;
  ocr_text: string | null;
  extent: string | null;
  arrangement: string | null;
  access_conditions: string | null;
  reproduction_conditions: string | null;
  language: string | null;
  location_of_originals: string | null;
  location_of_copies: string | null;
  related_materials: string | null;
  finding_aids: string | null;
  notes: string | null;
  publication_title: string | null;
  imprint: string | null;
  edition_statement: string | null;
  series_statement: string | null;
  uniform_title: string | null;
  section_title: string | null;
  pages: string | null;
  creator_display: string | null;
  place_display: string | null;
}

/** Repository record in repositories.json, with nested root_descriptions */
export interface ExportRepository {
  id: string;
  code: string;
  name: string;
  short_name: string | null;
  country_code: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  description_count: number;
  image_reproduction_text: string;
  display_title: string | null;
  subtitle: string | null;
  hero_image_url: string | null;
  root_descriptions: Omit<ExportDescription, "ocr_text">[];
}

/** Entity record in entities.json */
export interface ExportEntity {
  entity_code: string | null;
  display_name: string;
  sort_name: string;
  given_name: string | null;
  particle: string | null;
  surname: string | null;
  entity_type: string;
  honorific: string | null;
  primary_function: string | null;
  name_variants: string[];
  dates_of_existence: string | null;
  date_earliest: string | null;
  date_latest: string | null;
  date_start: string | null;
  date_end: string | null;
  history: string | null;
  legal_status: string | null;
  functions: string | null;
  sources: string | null;
  wikidata_id: string | null;
  viaf_id: string | null;
}

/** Place record in places.json */
export interface ExportPlace {
  label: string;
  place_code: string | null;
  display_name: string;
  place_type: string | null;
  fclass: string | null;
  name_variants: string[];
  historical_gobernacion: string | null;
  historical_partido: string | null;
  historical_region: string | null;
  country_code: string | null;
  admin_level_1: string | null;
  admin_level_2: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinate_precision: string | null;
  tgn_id: string | null;
  hgis_id: string | null;
  whg_id: string | null;
  wikidata_id: string | null;
}

/** Entry in children/{referenceCode}.json */
export interface ExportChildEntry {
  id: string;
  reference_code: string;
  title: string;
  description_level: string;
  date_expression: string | null;
  has_children: boolean;
  child_count: number;
  has_digital: boolean;
}

/** Export run progress record */
export interface ExportProgress {
  exportId: string;
  status: "pending" | "running" | "complete" | "error";
  currentStep: string | null;
  stepsCompleted: number;
  totalSteps: number;
  recordCounts: Record<string, number>;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// EAD3 builder contract
// ---------------------------------------------------------------------------

/**
 * Configuration for one descriptive standard's EAD3 emission.
 *
 * Cross-references `app/lib/standards/<std>.ts` for per-level mandatoriness
 * via `requiredFieldsForLevel` — does NOT duplicate the form-side source
 * of truth. Only EAD-specific wrapping and placement decisions live
 * here on top of the form-side config.
 *
 * Element ordering inside `<archdesc>` is universal (RNG-enforced by EAD3
 * v1.1.1); profiles toggle inclusion only, not order.
 */
export type EadProfile = {
  standard: Standard;
  /** Reference into the form-side single-source-of-truth — do NOT duplicate. */
  requiredFieldsForLevel: (level: string) => ReadonlyArray<string>;
  /**
   * Where biographical/admin history goes in the EAD3 tree.
   *  - "context" — emitted as `<bioghist>` directly under `<archdesc>` (DACS § 2.7, RAD).
   *  - "notes"   — emitted under `<notestmt><note>` (ISAD(G) 3.4.1 places admin/biog under "Notes").
   *  - "omit"    — never emitted (reserved for future profiles).
   */
  bioghistPlacement: "context" | "notes" | "omit";
  /** Whether unitdate emission ranges (1810-1850) or stays single (1820-03-12). */
  unitdateWrapping: "single" | "ranged";
  /** Optional sections inside `<archdesc>` that this profile emits when columns are populated. */
  includeAdminBiogHistory: boolean;
  includePreferredCitation: boolean;
  includeAcquisitionInfo: boolean;
  includeSystemOfArrangement: boolean;
};

/**
 * Row shape consumed by the EAD3 builder (`buildEad3` in
 * `app/lib/export/ead/builder.ts`). Aligned with the test fixture in
 * `tests/export/ead/fixtures.ts` so test rows can be passed straight in
 * without a separate adapter layer.
 *
 * Union schema additions (adminBiogHistory, preferredCitation,
 * acquisitionInfo, systemOfArrangement, physicalCharacteristics) are
 * carried as optional fields — DACS and RAD profiles consume them; the
 * ISAD(G) profile mostly leaves them omitted.
 */
export type EadInput = {
  id: string;
  referenceCode: string;
  title: string;
  /** "fonds" | "subfonds" | "series" | "subseries" | "section" | "file" | "item" | "volume" | "collection". */
  descriptionLevel: string;
  dateExpression: string | null;
  extent: string | null;
  creatorDisplay: string | null;
  scopeContent: string | null;
  accessConditions: string | null;
  language: string | null;
  placeDisplay: string | null;
  imprint: string | null;
  parentReferenceCode: string | null;
  repositoryId: string;
  isPublished: boolean;
  /** Provenance JSON from the legacy import: each entry becomes `<unitid type="<provider>">`. */
  legacyIds: Array<{ provider: string; id: string | number }> | null;
  // Union-schema additions (migration 0036) — consumed by DACS and RAD
  // profiles. Optional because not every test fixture row populates
  // them and the ISAD(G) profile mostly leaves them off.
  adminBiogHistory?: string | null;
  preferredCitation?: string | null;
  acquisitionInfo?: string | null;
  systemOfArrangement?: string | null;
  physicalCharacteristics?: string | null;
};

/** Repository information consumed by the EAD3 builder for `<repository>` and rights default. */
export type EadRepository = {
  name: string;
  city: string;
  code: string;
  rightsText: string | null;
};
