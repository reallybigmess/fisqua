-- Partition AHR out, file 2 of 4: descriptions backfill chunk 2 of 4.
--
-- One bounded id-range chunk, one /query call, its own 30s budget (see
-- 0051's header for the chunk-per-file rationale and the code-keyed
-- subquery). Covers co-ahr descriptions with id in ['4','8') (~13.7K
-- rows).
--
-- FTS trigger: like every file in this sequence, this file DROPs the
-- descriptions_fts_au trigger (IF EXISTS) before its UPDATE and recreates
-- it (byte-for-byte from the 0041 canonical source) after -- so the
-- backfill writes no FTS shadow churn AND the trigger is present when this
-- file commits (no commit boundary is ever trigger-missing; see 0051's
-- header for why). Idempotent / re-runnable: the DROP ... IF EXISTS +
-- plain CREATE pair runs cleanly whether or not the trigger exists, and
-- the tenant_id=neogranadina guard skips rows already moved by a prior run.
--
-- Version: v0.4.2

DROP TRIGGER IF EXISTS descriptions_fts_au;

UPDATE descriptions
SET tenant_id = 'c82525bd-13d5-46dd-9c1b-e258507b966c'
WHERE tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  AND id >= '4' AND id < '8'
  AND repository_id IN (
    SELECT id FROM repositories
    WHERE code = 'co-ahr' AND tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  );

CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;
