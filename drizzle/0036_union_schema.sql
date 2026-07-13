-- Union schema: drop 9 dead columns, add 6 new + 3 legacyIds JSON columns,
-- expand descriptions to the union of ISAD(G) + DACS + RAD
--
-- This migration locks the descriptions schema as the union of all three primary
-- descriptive standards so the v0.4 production import lands once
-- into the final shape rather than re-migrating mid-stream.
--
-- The drop list is the 9 columns the v0.4.0 production-data audit
-- confirmed dead in production: 7 historical / typed-LOD columns on places, one
-- legalStatus on entities, one relatedMaterials on descriptions. The
-- audit reports 0% population on each.
--
-- The add list is 6 new columns plus 3 legacyIds JSON columns.
-- Highlights:
--
--   1. places.fclass — 5-value GeoNames feature class (P/H/A/T/S),
--      enforced via CHECK constraint because the bounded enum
--      gates downstream validator selection. Population 100% in the
--      Django catalogue export; the 5-value set is exhaustive.
--   2. {descriptions, entities, places}.legacy_ids — generic JSON
--      columns; text typed with default '[]'; Zod-parsed at the
--      loader/action layer (app/lib/validation/legacy-ids.ts).
--      Replaces typed `*_legacy_id` columns the audit suggested NOT
--      to add (CA provenance, Django pk).
--   3. descriptions.publication_title — bibliographic block field,
--      13.6% populated in Django; landing it now means the production
--      import can back-fill from the Django dump without a follow-up
--      migration.
--   4. entities.dbe_id — Diccionario Biográfico Electrónico external
--      authority ref; 0.1% populated but a real LOD-style cross-ref
--      that matches the existing aspirational viaf_id / wikidata_id
--      pattern on entities.
--
-- The descriptions union adds DACS-only and RAD-only fields
-- as nullable text columns. The intersection of mandatory fields across
-- ISAD(G), DACS, and RAD is the new universal-NOT-NULL set:
-- id, tenant_id, repository_id, description_level, reference_code,
-- title, created_at, updated_at. local_identifier is RELAXED to
-- nullable (was NOT NULL in v0.3); the DACS/RAD intersection does not
-- mandate it, and the production data is fully populated so the
-- relaxation is purely a forward-looking schema change.
--
-- The DACS/RAD union additions on descriptions, locked here:
--
--   adminBiogHistory        TEXT  (DACS 5.1 — Administrative/Biographical History)
--   preferredCitation       TEXT  (DACS 7.1.5 — Preferred Citation)
--   acquisitionInfo         TEXT  (DACS 5.2 — Custodial History note)
--   systemOfArrangement     TEXT  (RAD 1.7B — Arrangement)
--   physicalCharacteristics TEXT  (RAD 1.5B — Physical Description)
--
-- These five additions are the column-level intersection between the
-- DACS and RAD mandatory/encouraged element sets that ISAD(G) does NOT
-- already supply via existing v0.3 columns (`scope_content`,
-- `arrangement`, `dimensions`, etc.). multi-tenancy.md does not
-- prescribe an explicit list — see "Summary of schema impact" — so the
-- list is locked here.
--
-- Per-standard mandatoriness lives in app-layer Zod validators — not
-- as DB CHECK — because SQLite CHECK cannot reference another table.
-- The validators run at every write boundary: forms, API endpoints,
-- and the bulk-import scripts. This migration commits to that boundary
-- by locking the column shape and writing the rule into
-- app/db/schema.ts's narrative header.
--
-- FTS5 triggers on descriptions/entities/places are dropped (defensive)
-- and re-CREATED after each rebuild because the table drop detaches
-- them. The indexed-column lists do not change in this migration
-- (verified against drizzle/0024 and drizzle/0015 — the only earlier
-- migrations that touched indexed columns on these tables).
--
-- Anticipatory bibliographic fields (volume_number, issue_number,
-- dimensions, medium, date_certainty, translated_title, resource_type,
-- genre) and aspirational external-authority refs (entities.viaf_id,
-- entities.wikidata_id, entities.history, descriptions.provenance) are
-- preserved verbatim.
--
-- Note on transaction framing: D1's Durable-Object-backed migration
-- runner rejects explicit BEGIN/COMMIT
-- and SAVEPOINT statements (the runner wraps every migration file in
-- its own DO transaction via state.storage.transaction()). The entire
-- file below is therefore one atomic unit — partial failure rolls back
-- all three rebuilds — which is stronger than per-table commits.
-- `PRAGMA foreign_key_check` after each rebuild still surfaces FK
-- violations exactly as planned.
--
-- Rebuild order: descriptions → entities → places. descriptions has the
-- most additions; entities and places follow the same idiom.
--
-- Version: v0.4.0

PRAGMA foreign_keys=OFF;

-- ============================================================================
-- Rebuild 1: descriptions
-- ============================================================================

DROP TRIGGER IF EXISTS descriptions_fts_ai;
DROP TRIGGER IF EXISTS descriptions_fts_ad;
DROP TRIGGER IF EXISTS descriptions_fts_au;

CREATE TABLE descriptions_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  parent_id TEXT,
  position INTEGER DEFAULT 0 NOT NULL,
  root_description_id TEXT,
  depth INTEGER DEFAULT 0 NOT NULL,
  child_count INTEGER DEFAULT 0 NOT NULL,
  path_cache TEXT DEFAULT '',
  description_level TEXT NOT NULL,
  resource_type TEXT,
  genre TEXT DEFAULT '[]',
  reference_code TEXT NOT NULL,
  -- local_identifier RELAXED to nullable in 0036 (was NOT NULL in v0.3).
  -- DACS/RAD do not mandate it; ISAD(G) does not mandate it. The Django
  -- export is 99.9% populated so back-filled rows all carry it; this is
  -- a forward-looking relaxation for future DACS/RAD tenants.
  local_identifier TEXT,
  title TEXT NOT NULL,
  translated_title TEXT,
  uniform_title TEXT,
  date_expression TEXT,
  date_start TEXT,
  date_end TEXT,
  date_certainty TEXT,
  extent TEXT,
  dimensions TEXT,
  medium TEXT,
  imprint TEXT,
  edition_statement TEXT,
  series_statement TEXT,
  volume_number TEXT,
  issue_number TEXT,
  pages TEXT,
  -- New column: bibliographic-block "Title of the larger
  -- publication" (journal, series, source-edition); 13.6% populated
  -- in Django.
  publication_title TEXT,
  provenance TEXT,
  scope_content TEXT,
  ocr_text TEXT DEFAULT '',
  arrangement TEXT,
  access_conditions TEXT,
  reproduction_conditions TEXT,
  language TEXT,
  location_of_originals TEXT,
  location_of_copies TEXT,
  -- related_materials DROPPED (0% populated in production).
  finding_aids TEXT,
  section_title TEXT,
  notes TEXT,
  internal_notes TEXT,
  creator_display TEXT,
  place_display TEXT,
  iiif_manifest_url TEXT,
  has_digital INTEGER DEFAULT 0,
  is_published INTEGER DEFAULT 0,
  last_exported_at INTEGER,
  -- New union additions for DACS + RAD coverage.
  admin_biog_history TEXT,
  preferred_citation TEXT,
  acquisition_info TEXT,
  system_of_arrangement TEXT,
  physical_characteristics TEXT,
  -- New legacy_ids JSON column. Zod-parsed at the loader/action
  -- layer (app/lib/validation/legacy-ids.ts).
  legacy_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO descriptions_new (
  id, tenant_id, repository_id,
  parent_id, position, root_description_id, depth, child_count, path_cache,
  description_level, resource_type, genre,
  reference_code, local_identifier, title, translated_title, uniform_title,
  date_expression, date_start, date_end, date_certainty,
  extent, dimensions, medium,
  imprint, edition_statement, series_statement, volume_number, issue_number, pages,
  provenance, scope_content, ocr_text, arrangement,
  access_conditions, reproduction_conditions, language,
  location_of_originals, location_of_copies, finding_aids,
  section_title, notes, internal_notes,
  creator_display, place_display,
  iiif_manifest_url, has_digital, is_published, last_exported_at,
  created_by, updated_by, created_at, updated_at
)
SELECT
  id, tenant_id, repository_id,
  parent_id, position, root_description_id, depth, child_count, path_cache,
  description_level, resource_type, genre,
  reference_code, local_identifier, title, translated_title, uniform_title,
  date_expression, date_start, date_end, date_certainty,
  extent, dimensions, medium,
  imprint, edition_statement, series_statement, volume_number, issue_number, pages,
  provenance, scope_content, ocr_text, arrangement,
  access_conditions, reproduction_conditions, language,
  location_of_originals, location_of_copies, finding_aids,
  section_title, notes, internal_notes,
  creator_display, place_display,
  iiif_manifest_url, has_digital, is_published, last_exported_at,
  created_by, updated_by, created_at, updated_at
FROM descriptions;

DROP TABLE descriptions;
ALTER TABLE descriptions_new RENAME TO descriptions;

CREATE INDEX IF NOT EXISTS desc_parent_pos_idx ON descriptions(parent_id, position);
CREATE INDEX IF NOT EXISTS desc_root_idx ON descriptions(root_description_id);
CREATE UNIQUE INDEX IF NOT EXISTS desc_ref_code_idx ON descriptions(reference_code);
CREATE INDEX IF NOT EXISTS desc_repo_idx ON descriptions(repository_id);
CREATE INDEX IF NOT EXISTS desc_local_id_idx ON descriptions(local_identifier);

-- Re-CREATE FTS5 sync triggers (verbatim from drizzle/0024_descriptions_fts5.sql).
CREATE TRIGGER IF NOT EXISTS descriptions_fts_ai AFTER INSERT ON descriptions BEGIN
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

CREATE TRIGGER IF NOT EXISTS descriptions_fts_ad AFTER DELETE ON descriptions BEGIN
  INSERT INTO descriptions_fts(descriptions_fts, rowid, reference_code, title)
  VALUES ('delete', old.rowid, old.reference_code, old.title);
END;

CREATE TRIGGER IF NOT EXISTS descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  INSERT INTO descriptions_fts(descriptions_fts, rowid, reference_code, title)
  VALUES ('delete', old.rowid, old.reference_code, old.title);
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

PRAGMA foreign_key_check;

-- ============================================================================
-- Rebuild 2: entities
-- ============================================================================

DROP TRIGGER IF EXISTS entities_fts_ai;
DROP TRIGGER IF EXISTS entities_fts_ad;
DROP TRIGGER IF EXISTS entities_fts_au;

CREATE TABLE entities_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entity_code TEXT,
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL,
  surname TEXT,
  given_name TEXT,
  entity_type TEXT NOT NULL,
  honorific TEXT,
  primary_function TEXT,
  primary_function_id TEXT REFERENCES vocabulary_terms(id) ON DELETE SET NULL,
  name_variants TEXT DEFAULT '[]',
  dates_of_existence TEXT,
  date_start TEXT,
  date_end TEXT,
  history TEXT,
  -- legal_status DROPPED (0% populated in production).
  functions TEXT,
  sources TEXT,
  merged_into TEXT,
  wikidata_id TEXT,
  viaf_id TEXT,
  -- New columns: dbe_id (DBE authority ref) + legacy_ids JSON.
  dbe_id TEXT,
  legacy_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO entities_new (
  id, tenant_id, entity_code,
  display_name, sort_name, surname, given_name,
  entity_type, honorific,
  primary_function, primary_function_id, name_variants,
  dates_of_existence, date_start, date_end,
  history, functions, sources, merged_into,
  wikidata_id, viaf_id,
  created_at, updated_at
)
SELECT
  id, tenant_id, entity_code,
  display_name, sort_name, surname, given_name,
  entity_type, honorific,
  primary_function, primary_function_id, name_variants,
  dates_of_existence, date_start, date_end,
  history, functions, sources, merged_into,
  wikidata_id, viaf_id,
  created_at, updated_at
FROM entities;

DROP TABLE entities;
ALTER TABLE entities_new RENAME TO entities;

CREATE UNIQUE INDEX IF NOT EXISTS entity_code_idx ON entities(entity_code);
CREATE INDEX IF NOT EXISTS entity_sort_name_idx ON entities(sort_name);
CREATE INDEX IF NOT EXISTS entity_wikidata_idx ON entities(wikidata_id);
CREATE INDEX IF NOT EXISTS entity_pf_id_idx ON entities(primary_function_id);

-- Re-CREATE FTS5 sync triggers (verbatim from drizzle/0015_fts5_name_variants.sql).
CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name, name_variants)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name, old.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, display_name, sort_name, name_variants)
  VALUES ('delete', old.rowid, old.display_name, old.sort_name, old.name_variants);
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

PRAGMA foreign_key_check;

-- ============================================================================
-- Rebuild 3: places
-- ============================================================================

DROP TRIGGER IF EXISTS places_fts_ai;
DROP TRIGGER IF EXISTS places_fts_ad;
DROP TRIGGER IF EXISTS places_fts_au;

CREATE TABLE places_new (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  place_code TEXT,
  label TEXT NOT NULL,
  display_name TEXT NOT NULL,
  place_type TEXT,
  name_variants TEXT DEFAULT '[]',
  parent_id TEXT,
  latitude REAL,
  longitude REAL,
  coordinate_precision TEXT,
  -- historical_gobernacion, historical_partido, historical_region,
  -- country_code, admin_level_1, admin_level_2, wikidata_id all
  -- DROPPED (0% populated in production).
  needs_geocoding INTEGER DEFAULT 1,
  merged_into TEXT,
  tgn_id TEXT,
  hgis_id TEXT,
  whg_id TEXT,
  -- New columns: fclass (5-value GeoNames feature class) +
  -- legacy_ids JSON. fclass uses the nullable-or-IN CHECK shape from
  -- drizzle/0029_page_targets_and_qc_flags.sql line 77.
  fclass TEXT CHECK (fclass IS NULL OR fclass IN ('P','H','A','T','S')),
  legacy_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO places_new (
  id, tenant_id, place_code,
  label, display_name, place_type, name_variants, parent_id,
  latitude, longitude, coordinate_precision,
  needs_geocoding, merged_into,
  tgn_id, hgis_id, whg_id,
  created_at, updated_at
)
SELECT
  id, tenant_id, place_code,
  label, display_name, place_type, name_variants, parent_id,
  latitude, longitude, coordinate_precision,
  needs_geocoding, merged_into,
  tgn_id, hgis_id, whg_id,
  created_at, updated_at
FROM places;

DROP TABLE places;
ALTER TABLE places_new RENAME TO places;

CREATE UNIQUE INDEX IF NOT EXISTS place_code_idx ON places(place_code);
CREATE INDEX IF NOT EXISTS place_label_idx ON places(label);
CREATE INDEX IF NOT EXISTS place_tgn_idx ON places(tgn_id);

-- Re-CREATE FTS5 sync triggers (verbatim from drizzle/0015_fts5_name_variants.sql).
CREATE TRIGGER IF NOT EXISTS places_fts_ai AFTER INSERT ON places BEGIN
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_ad AFTER DELETE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name, name_variants)
  VALUES ('delete', old.rowid, old.label, old.display_name, old.name_variants);
END;

CREATE TRIGGER IF NOT EXISTS places_fts_au AFTER UPDATE ON places BEGIN
  INSERT INTO places_fts(places_fts, rowid, label, display_name, name_variants)
  VALUES ('delete', old.rowid, old.label, old.display_name, old.name_variants);
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;

PRAGMA foreign_key_check;

PRAGMA foreign_keys=ON;
