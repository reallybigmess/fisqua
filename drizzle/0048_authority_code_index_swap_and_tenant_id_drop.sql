-- Authorities lift, file 4 of 4: swap the unique code indexes to
-- per-federation (invariant I5) and drop the superseded tenant_id
-- columns.
--
--   entity_code_idx: UNIQUE (entity_code) -> UNIQUE (federation_id, entity_code)
--   place_code_idx:  UNIQUE (place_code)  -> UNIQUE (federation_id, place_code)
--
-- Index names preserved so app/db/schema.ts's uniqueIndex declarations
-- keep matching by name (0043's drop-and-recreate pattern; each
-- migration file is one atomic /query call with rollback-on-error --
-- the atomicity pre-flight was confirmed against production). The new
-- composite is strictly weaker than the old single-column UNIQUE, so no
-- existing rows can violate it.
--
-- WHY A REAL `DROP COLUMN tenant_id` IS SAFE (and no rebuild is needed)
-- ---------------------------------------------------------------------
-- The 0042 header prohibits the 0035 table-REBUILD pattern for
-- populated tables with cascade children (defer_foreign_keys does not
-- defer ON DELETE CASCADE actions inside D1's per-file transaction).
-- `ALTER TABLE ... DROP COLUMN` is a different operation: a rewrite of
-- the ONE table that issues no DELETE, so no cascade can fire. SQLite
-- refuses DROP COLUMN only when the column is a PK, UNIQUE, indexed, or
-- referenced by a trigger/view/CHECK/generated column/partial index.
-- On entities and places, tenant_id is none of these:
--   * not a PK (id is);
--   * in NO index -- and the old single-column code indexes are already
--     replaced above, the new ones cover (federation_id, code);
--   * not referenced by any trigger or view: a sqlite_master scan for
--     '%tenant_id%' returns only audit_log_no_update, which does not
--     touch entities/places; the FTS triggers reference content columns
--     only;
--   * the child FKs (entity_functions, description_entities,
--     description_places) reference the PK id, not tenant_id.
-- PROVEN empirically on local D1 (workerd, the same engine as remote):
-- both DROP COLUMNs executed cleanly on the full dataset (78,276
-- entities / 6,903 places), row counts unchanged, junction-integrity
-- (I4) zero violations.
--
-- All four statements-pairs were measured individually on local D1
-- before landing and each runs in single-digit-to-low-double-digit
-- milliseconds; combined wall time is far under the ~1s/file budget
-- (see 0045's header), so no further split is needed.
--
-- Version: v0.4.2

DROP INDEX entity_code_idx;
CREATE UNIQUE INDEX entity_code_idx ON entities(federation_id, entity_code);
ALTER TABLE entities DROP COLUMN tenant_id;

DROP INDEX place_code_idx;
CREATE UNIQUE INDEX place_code_idx ON places(federation_id, place_code);
ALTER TABLE places DROP COLUMN tenant_id;
