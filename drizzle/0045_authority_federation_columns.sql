-- Authorities lift to federation scope, file 1 of 4 (federation
-- migration sequence step 3): add the federation_id columns, backfill
-- the (small) vocabulary table, and drop the FTS AFTER-UPDATE triggers
-- ahead of the heavy backfills in 0046/0047.
--
-- WHY THE LIFT IS SPLIT ACROSS FOUR MIGRATION FILES (0045-0048)
-- -------------------------------------------------------------
-- Wrangler applies each migration file as ONE synchronous /query call,
-- and D1 bounds a single query at 30 seconds. A monolithic lift file
-- packs roughly 430K row-writes into that one call: the two backfill
-- UPDATEs (78,276 entities + 6,903 places) each fire the UNCONDITIONAL
-- entities_fts_au / places_fts_au AFTER-UPDATE triggers -- a DELETE +
-- INSERT across the FTS5 shadow tables per row, measured at ~5
-- row-writes per updated row -- even though federation_id is not an
-- FTS-indexed column, so all of that work is wasted. On top of that sit
-- two CREATE UNIQUE INDEX rebuilds and two DROP COLUMN table rewrites.
-- Cloudflare's D1 FAQ explicitly advises chunking work that modifies
-- this many rows. The strategy for this and every future heavy
-- migration: one bounded chunk per FILE (each file gets its own /query
-- call and its own 30s budget), FTS triggers dropped around bulk
-- UPDATEs of non-FTS columns, every backfill statement idempotent
-- (WHERE federation_id IS NULL) so a failed-and-retried file is safe,
-- and each file's local wall time measured under ~1s for 30x headroom.
--
-- The four files:
--   0045 (this file): ADD COLUMN federation_id to entities / places /
--        vocabulary_terms; backfill vocabulary_terms (small table;
--        production count is tiny) + its lookup index; DROP the two
--        FTS AFTER-UPDATE triggers.
--   0046: entities backfill UPDATE (78K rows, no triggers firing).
--   0047: places backfill UPDATE + recreate both AFTER-UPDATE triggers
--        byte-for-byte from their canonical source (0041).
--   0048: the two unique-code index swaps + the two DROP COLUMN
--        tenant_id rewrites.
--
-- The whole sequence is applied back-to-back by one `wrangler d1
-- migrations apply` run, so the windows in which (a) the au triggers
-- are absent (0045..0047) and (b) entities/places rows carry both
-- tenant_id and federation_id (0045..0048) exist only inside the apply
-- run; no application writes occur within it.
--
-- WHAT THE LIFT DOES (federation spec §9 step 3, closes audit item 20b)
-- ---------------------------------------------------------------------
-- entities, places, and vocabulary_terms move from tenant scope to
-- FEDERATION scope: managed by the federation, shared by all member
-- tenants. The junction tables (description_entities,
-- description_places) are untouched -- they stay legal by construction
-- because every current description's tenant belongs to the same
-- federation as the authority it links (invariant I4, verified after
-- apply: the mismatch-count JOIN returns zero).
--
-- WHY federation_id IS "NULLABLE-WITH-FK + BACKFILL", NOT "NOT NULL DEFAULT"
-- --------------------------------------------------------------------------
-- Same reasoning as 0044's tenants.federation_id: there is NO single
-- correct default federation for FUTURE authority rows (AMPL-federation
-- authorities must carry the AMPL id, not a baked-in literal), a wrong
-- default at the ROOT of the authority scoping tree is a
-- cross-federation integrity failure strictly worse than a NULL, and
-- SQLite cannot later drop a column default without the prohibited
-- table rebuild (0042 header). So: ADD COLUMN with a REAL FK, nullable
-- at the DB layer; NOT NULL enforced at the Drizzle/app layer
-- (schema.ts declares `.notNull()`, making omission a compile error).
-- ADD COLUMN cannot combine NOT NULL with REFERENCES anyway.
--
-- BACKFILL SOURCE (verified, not assumed)
-- ---------------------------------------
-- entities/places resolve each row's federation THROUGH ITS TENANT in
-- 0046/0047 (JOIN on tenants.federation_id). Verified on local D1: all
-- 78,276 entities and 6,903 places resolve to the Neogranadina
-- federation via that JOIN. vocabulary_terms has no tenant column (it
-- was a tenant-blind global table); all current terms are
-- Neogranadina's canonical vocabulary, so the backfill below uses the
-- Neogranadina federation literal (byte-for-byte equal to
-- NEOGRANADINA_FEDERATION_ID in app/lib/tenant.ts; AMPL's vocabulary
-- space is seeded separately by copy at provisioning, spec §7).
--
-- The dropped triggers' bodies are recreated in 0047 byte-for-byte from
-- drizzle/0041_fix_fts_delete_triggers.sql, their canonical source
-- (verified identical to live sqlite_master before this migration was
-- written).
--
-- Version: v0.4.2

ALTER TABLE entities ADD COLUMN federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT;
ALTER TABLE places ADD COLUMN federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT;
ALTER TABLE vocabulary_terms ADD COLUMN federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT;

-- vocabulary_terms backfill: small table, safe in this file. Idempotent
-- (WHERE federation_id IS NULL) so a retried file cannot re-write rows.
UPDATE vocabulary_terms SET federation_id = 'b4462493-6170-44f8-ae07-24666606d1f1' WHERE federation_id IS NULL;
CREATE INDEX vt_federation_idx ON vocabulary_terms(federation_id);

-- Drop the unconditional FTS AFTER-UPDATE triggers so the 0046/0047
-- backfills write 1 row per row instead of ~5 (federation_id is not an
-- FTS-indexed column; the FTS churn would be pure waste). Recreated
-- byte-for-byte in 0047.
DROP TRIGGER entities_fts_au;
DROP TRIGGER places_fts_au;
