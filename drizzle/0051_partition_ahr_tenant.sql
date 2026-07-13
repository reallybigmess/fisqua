-- Partition AHR out into its own tenant, file 1 of 4 (federation
-- migration sequence step 6): create the ahr tenant and move the first
-- id-range chunk of co-ahr descriptions.
--
-- WHAT STEP 6 DOES
-- ----------------
-- Creates the `ahr` tenant ("Archivo Histórico de Rionegro") inside the
-- NEOGRANADINA federation, then moves the AHR catalogue -- every
-- `descriptions` row under the co-ahr repository (0051-0054), plus the
-- co-ahr `repositories` row itself (0054) -- from the neogranadina
-- tenant to the new ahr tenant. Nothing else moves: AHR-related
-- crowdsourcing (projects, volumes, entries, ...) STAYS with the
-- Neogranadina lead tenant (ruled 2026-07-07), and the
-- federation-scoped authorities (entities/places/vocabulary_terms) and
-- their junction rows are UNTOUCHED because AHR joins the SAME
-- federation as Neogranadina (invariant I4 holds by construction).
--
-- WHY FOUR FILES (chunked by id-range)
-- ------------------------------------
-- Wrangler sends each migration file as ONE synchronous /query call
-- bounded by D1's 30-second limit (the 0045-0048 lesson). The
-- descriptions backfill re-tenants ~55K rows of a very wide (~70-column)
-- table AND reshuffles the per-tenant unique index
-- desc_ref_code_idx (tenant_id, reference_code) for every moved row,
-- because tenant_id is the leading index column. Measured on local D1
-- (workerd/SQLite) as a single UPDATE: ~1.2-1.7s -- over the "well under
-- 1s / ~30x headroom against 30s" discipline this project holds every
-- heavy migration to (step 3's heaviest file was 291 ms). Remote D1 is
-- typically slower than local, so the single UPDATE's headroom is too
-- thin. Following the 0045 lesson, the backfill is split into four
-- id-range chunks, one bounded chunk per FILE (each file its own /query
-- call and its own 30s budget), each measured well under 1s.
--
-- The id ranges partition the co-ahr id space (lowercase v4 UUIDs,
-- first hex char uniformly distributed) into four disjoint, exhaustive
-- lexicographic bands covering ANY TEXT id (no lower bound on the first
-- band, no upper bound on the last), so every co-ahr row is moved by
-- exactly one file:
--   0051 (this file): id < '4'                (~13.8K rows)
--   0052:             id >= '4' AND id < '8'  (~13.7K rows)
--   0053:             id >= '8' AND id < 'c'  (~13.9K rows)
--   0054:             id >= 'c'               (~14.0K rows) + repo-row move
--
-- WHY THE MOVE IS KEYED ON repository CODE 'co-ahr', NOT A UUID LITERAL
-- --------------------------------------------------------------------
-- Repository rows are seeded per-environment by the import scripts with
-- freshly-generated UUIDs, so the co-ahr repository has a DIFFERENT id
-- in each database (production and local/CI are not the same literal).
-- Hard-coding either environment's UUID would make this migration a
-- silent NO-OP in the other. The stable cross-environment identifier is
-- the repository CODE (the import contract resolves "strictly by stable
-- reference codes, never transient IDs"). So each descriptions chunk
-- resolves co-ahr's id through a subquery on
-- (code='co-ahr', tenant_id=neogranadina), scoped to the Neogranadina
-- tenant so the per-tenant repo_code index (0043) cannot make it
-- ambiguous. The repository row stays under neogranadina until 0054, so
-- the subquery resolves in every chunk file.
--
-- FTS TRIGGER (EACH file drops-if-exists and restores it -- no commit
-- boundary is ever trigger-missing)
-- ------------------------------------------------------------------
-- `descriptions` has an FTS5 shadow (descriptions_fts) kept in sync by
-- three triggers; only the AFTER-UPDATE one (descriptions_fts_au) fires
-- on this backfill. tenant_id is NOT an FTS-indexed column
-- (descriptions_fts indexes reference_code + title only), so letting the
-- trigger fire would write ~2 wasted FTS row-ops per moved row -- pure
-- churn. To keep that optimization WITHOUT ever leaving the database
-- with the trigger missing at a commit boundary, EACH of 0051-0054
-- `DROP TRIGGER IF EXISTS descriptions_fts_au` at the top (before its own
-- UPDATE) and recreates it at the bottom (after its own UPDATE): the
-- trigger is absent only during a single file's churn-free UPDATE and is
-- PRESENT whenever any file commits. This matters because wrangler
-- applies each file as a SEPARATE tracked query -- a "drop once in 0051,
-- restore once in 0054" shape would, if an intermediate file failed on
-- production, leave 0051 committed with the trigger dropped and 0054
-- never run, so live description edits would silently stop updating
-- descriptions_fts until noticed. The per-file drop/restore closes that
-- window. The recreated body is BYTE-FOR-BYTE the canonical source,
-- drizzle/0041_fix_fts_delete_triggers.sql (verified identical to the
-- pre-move live sqlite_master descriptions_fts_au body). The AI/AD
-- triggers do not fire on UPDATE and are left in place.
--
-- IDEMPOTENCY / ATOMICITY
-- -----------------------
-- Each migration file is one atomic /query call with rollback-on-error
-- (atomicity pre-flight confirmed against production before 0042), so no
-- partial state survives a failure. Every statement is also idempotent
-- for safe re-apply (whole file OR a manual single-file re-exec): the
-- tenant insert is INSERT OR IGNORE; the trigger DDL is DROP TRIGGER IF
-- EXISTS immediately before a plain CREATE, so BOTH the drop and the
-- create succeed whether or not the trigger already exists (the DDL is
-- fully re-runnable); each descriptions chunk guards on
-- tenant_id=neogranadina AND the co-ahr subquery AND its id range
-- (already-moved rows carry tenant_id=ahr and are skipped).
--
-- AHR TENANT CAPABILITY FLAGS (conservative; detailed provisioning is step 7)
-- --------------------------------------------------------------------------
-- crowdsourcing_enabled = 0: RULED OFF -- AHR material is catalogued
--   collaboratively by the federation, not via AHR's own crowdsourcing.
-- vocabulary_hub_enabled / publish_pipeline_enabled /
--   multi_repository_enabled = 0: CONSERVATIVE least-privilege defaults.
--   Step 7 (provisioning) sets AHR's real capability profile; until then
--   a member tenant with every module off is viable (its subdomain
--   resolves and its catalogue is readable -- catalogue reads are not
--   capability-gated). descriptive_standard 'isadg' (same as
--   Neogranadina, ruled); status 'active'; quota NULL (unlimited
--   placeholder); federation_id = the Neogranadina federation.
--
-- INVARIANTS PRESERVED (verified empirically on local D1 after apply)
-- ------------------------------------------------------------------
-- I4 (junction integrity): AHR is in the Neogranadina federation (same
--   as before) and the authorities are all Neogranadina-federation rows,
--   so the description-tenant-federation = authority-federation equality
--   still holds; the mismatch-count JOINs return 0/0.
-- I5 (per-tenant code uniqueness): moving a SUBSET of rows already
--   mutually unique within neogranadina to a fresh ahr tenant preserves
--   their mutual uniqueness (no co-ahr reference code repeats within
--   co-ahr; co-ahr is the only repository moving, so its code is
--   trivially unique within ahr). desc_ref_code_idx (tenant_id,
--   reference_code) and repo_code_idx (tenant_id, code) both still hold.
--
-- The ahr tenant UUID MUST match app/lib/tenant.ts AHR_TENANT_ID
-- byte-for-byte; NEOGRANADINA_TENANT_ID / NEOGRANADINA_FEDERATION_ID
-- match the 0034 / 0044 seed literals.
--
-- Version: v0.4.2

-- Create the ahr tenant (in the Neogranadina federation). INSERT OR
-- IGNORE for idempotency; the federation row already exists from 0044.
INSERT OR IGNORE INTO tenants (
  id, slug, name, kind, descriptive_standard, status,
  crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled,
  quota_storage_bytes, federation_id, created_at, updated_at
) VALUES (
  'c82525bd-13d5-46dd-9c1b-e258507b966c', 'ahr', 'Archivo Histórico de Rionegro', 'tenant', 'isadg', 'active',
  0, 0, 0, 0,
  NULL, 'b4462493-6170-44f8-ae07-24666606d1f1', 1779800000000, 1779800000000
);

-- Drop the descriptions FTS AFTER-UPDATE trigger so THIS file's tenant_id
-- backfill (a non-FTS column) writes no FTS shadow churn. Restored at the
-- bottom of this file so the trigger is present when this file commits.
-- IF EXISTS makes a manual single-file re-exec safe.
DROP TRIGGER IF EXISTS descriptions_fts_au;

-- Chunk 1 of 4: co-ahr descriptions with id < '4'. Keyed on repository
-- CODE (see header); idempotent via the tenant_id=neogranadina guard.
UPDATE descriptions
SET tenant_id = 'c82525bd-13d5-46dd-9c1b-e258507b966c'
WHERE tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  AND id < '4'
  AND repository_id IN (
    SELECT id FROM repositories
    WHERE code = 'co-ahr' AND tenant_id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
  );

-- Restore the descriptions FTS AFTER-UPDATE trigger BYTE-FOR-BYTE from
-- its canonical source, drizzle/0041_fix_fts_delete_triggers.sql, so the
-- trigger is present when this file commits.
CREATE TRIGGER descriptions_fts_au AFTER UPDATE ON descriptions BEGIN
  DELETE FROM descriptions_fts WHERE rowid = old.rowid;
  INSERT INTO descriptions_fts(rowid, reference_code, title)
  VALUES (new.rowid, new.reference_code, new.title);
END;
