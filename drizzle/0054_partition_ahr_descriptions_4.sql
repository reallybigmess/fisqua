-- Partition AHR out, file 4 of 4: descriptions backfill chunk 4 of 4,
-- then move the co-ahr repository row.
--
-- Covers co-ahr descriptions with id >= 'c' (~14.0K rows; no upper
-- bound, so it catches every remaining lexicographic value -- see
-- 0051's header for the exhaustive-partition reasoning). This is the
-- last chunk. It also moves the co-ahr repository row itself to the ahr
-- tenant.
--
-- ORDERING: the repository move runs LAST, after every descriptions
-- chunk (0051-0053 and this file's chunk), because the chunks resolve
-- co-ahr THROUGH the still-under-neogranadina repository row (the
-- code-keyed subquery). Moving the repository earlier would make the
-- remaining chunks' subquery return nothing. Within this file the chunk
-- UPDATE still resolves co-ahr under neogranadina (the repository move
-- is the final statement).
--
-- FTS trigger: like every file in this sequence, this file DROPs
-- descriptions_fts_au (IF EXISTS) before its descriptions UPDATE and
-- recreates it (byte-for-byte from the 0041 canonical source) after --
-- churn-free UPDATE, trigger present at commit (see 0051's header). The
-- repository move touches the repositories table, which has no FTS
-- trigger, so it sits after the trigger recreate without affecting FTS.
--
-- Idempotent / re-runnable: the DROP ... IF EXISTS + plain CREATE pair
-- runs cleanly whether or not the trigger exists; the descriptions chunk
-- guards on tenant_id=neogranadina; the repository move guards on
-- tenant_id=neogranadina AND code='co-ahr' (an already-moved repository
-- row is skipped). One atomic /query call with rollback-on-error.
--
-- Version: v0.4.2

DROP TRIGGER IF EXISTS descriptions_fts_au;

-- Chunk 4 of 4: co-ahr descriptions with id >= 'c'.
UPDATE descriptions
SET tenant_id = 'c82525bd-13d5-46dd-9c1b-e258507b966c'
WHERE tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  AND id >= 'c'
  AND repository_id IN (
    SELECT id FROM repositories
    WHERE code = 'co-ahr' AND tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  );

-- Restore the descriptions FTS AFTER-UPDATE trigger BYTE-FOR-BYTE from
-- its canonical source, drizzle/0041_fix_fts_delete_triggers.sql.
CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;

-- Move the co-ahr repository row to the ahr tenant. Runs after every
-- descriptions chunk so their code-keyed subquery could still resolve
-- co-ahr under neogranadina.
UPDATE repositories
SET tenant_id = 'c82525bd-13d5-46dd-9c1b-e258507b966c'
WHERE tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b' AND code = 'co-ahr';
