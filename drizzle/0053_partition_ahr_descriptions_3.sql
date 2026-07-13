-- Partition AHR out, file 3 of 4: descriptions backfill chunk 3 of 4.
--
-- One bounded id-range chunk, one /query call, its own 30s budget (see
-- 0051's header). Covers co-ahr descriptions with id in ['8','c')
-- (~13.9K rows).
--
-- FTS trigger: this file DROPs descriptions_fts_au (IF EXISTS) before its
-- UPDATE and recreates it (byte-for-byte from the 0041 canonical source)
-- after -- churn-free UPDATE, trigger present at commit, no boundary ever
-- trigger-missing (see 0051's header). Idempotent / re-runnable via the
-- DROP ... IF EXISTS + plain CREATE pair and the tenant_id=neogranadina
-- guard.
--
-- Version: v0.4.2

DROP TRIGGER IF EXISTS descriptions_fts_au;

UPDATE descriptions
SET tenant_id = 'c82525bd-13d5-46dd-9c1b-e258507b966c'
WHERE tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  AND id >= '8' AND id < 'c'
  AND repository_id IN (
    SELECT id FROM repositories
    WHERE code = 'co-ahr' AND tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  );

CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;
