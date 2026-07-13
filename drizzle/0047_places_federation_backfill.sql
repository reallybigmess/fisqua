-- Authorities lift, file 3 of 4: places federation_id backfill, then
-- recreate the two FTS AFTER-UPDATE triggers dropped in 0045.
--
-- 6,903 places backfilled through the tenants JOIN (idempotent via
-- WHERE federation_id IS NULL -- see 0045's header for the
-- chunk-per-file rationale). With the backfills done, the AFTER-UPDATE
-- triggers come back BYTE-FOR-BYTE from their canonical source,
-- drizzle/0041_fix_fts_delete_triggers.sql (verified identical to the
-- pre-lift live sqlite_master). From this file on, entity/place updates
-- sync FTS again.
--
-- Version: v0.4.2

UPDATE places SET federation_id = (SELECT t.federation_id FROM tenants t WHERE t.id = places.tenant_id) WHERE federation_id IS NULL;

CREATE TRIGGER entities_fts_au AFTER UPDATE ON entities BEGIN
  DELETE FROM entities_fts WHERE rowid = old.rowid;
  INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants)
  VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants);
END;

CREATE TRIGGER places_fts_au AFTER UPDATE ON places BEGIN
  DELETE FROM places_fts WHERE rowid = old.rowid;
  INSERT INTO places_fts(rowid, label, display_name, name_variants)
  VALUES (new.rowid, new.label, new.display_name, new.name_variants);
END;
