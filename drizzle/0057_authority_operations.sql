-- Authority operations ledger: append-only record of what was merged,
-- split, or deleted in the federation-scoped authority space.
--
-- WHAT
-- ----
-- One row per irreversible authority mutation (entity/place/vocabulary
-- merge, split, or delete). The row names the two records involved
-- (source/target), the acting user, and a JSON `detail` payload. It is
-- the durable system of record for these operations: the free-text
-- merge/split notes on `entities.sources` remain human-readable in
-- place, and `merged_into` remains the live pointer the app filters on,
-- but neither survives a later edit and places never carried a note at
-- all. This table is the one an investigator can trust.
--
-- Two further operation values serve the pipeline provenance backfill
-- (authorities spec §10). `resolve` records how a record came to be —
-- per-entity creation provenance — and is written only by the
-- provenance backfill, never by the admin routes. `separate` records a
-- decision NOT to merge two records (a refuted merge): the
-- do-not-relink rejection table future automated extraction consults
-- before re-proposing a pair.
--
-- WHY
-- ---
-- Merge silently deletes junction rows that collide with the target's
-- unique index, destroying their role_note / sequence / honorific /
-- function / name_as_recorded; the deletion left no trace. The
-- `detail.droppedLinks` payload captures each such row's full content
-- before it is deleted, in the same batch as the deletion, so nothing
-- is lost without landing here first. Delete captures a full row
-- snapshot so a hard delete is reconstructible. Split records how many
-- links moved to the new record.
--
-- IDEMPOTENCY
-- -----------
-- Purely additive: CREATE TABLE + CREATE INDEX + CREATE TRIGGER only,
-- no ALTER of existing tables and no table rebuild. Safe to re-run
-- against a database that already has it — every object uses
-- IF NOT EXISTS. Nothing here backfills or migrates existing rows.
--
-- APPEND-ONLY (mirrors the 0037 audit_log immutability pattern)
-- ------------------------------------------------------------
-- BEFORE UPDATE and BEFORE DELETE triggers both RAISE(ABORT). Unlike
-- audit_log (whose actor_user_id ON DELETE SET NULL cascade needs a
-- WHEN carve-out), user_id here is NOT NULL with ON DELETE RESTRICT, so
-- no cascade ever mutates a row — both triggers use the bare
-- unconditional RAISE form, which also sidesteps the workers-sdk #4326
-- trigger-parser quirk that affects compound CASE expressions on remote
-- D1. The only way past the triggers is DROP TRIGGER in a migration,
-- which is auditable in source control.
--
-- FKs: federation_id and user_id are real foreign keys (the ledger is
-- federation-scoped and its author must exist). source_id and target_id
-- carry NO foreign key by design: a deleted record must stay
-- referenceable, and a merge loser or split parent may itself be
-- deleted later.
--
-- Version: v0.4.2

CREATE TABLE IF NOT EXISTS authority_operations (
  id TEXT PRIMARY KEY NOT NULL,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT,
  record_type TEXT NOT NULL CHECK (record_type IN ('entity', 'place', 'vocabulary_term')),
  operation TEXT NOT NULL CHECK (operation IN ('merge', 'split', 'delete', 'resolve', 'separate')),
  source_id TEXT NOT NULL,
  target_id TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS authority_operations_federation_idx ON authority_operations(federation_id);
CREATE INDEX IF NOT EXISTS authority_operations_source_idx ON authority_operations(source_id);
CREATE INDEX IF NOT EXISTS authority_operations_target_idx ON authority_operations(target_id);

CREATE TRIGGER IF NOT EXISTS authority_operations_no_update
BEFORE UPDATE ON authority_operations
BEGIN
  SELECT RAISE(ABORT, 'authority_operations is append-only');
END;

CREATE TRIGGER IF NOT EXISTS authority_operations_no_delete
BEFORE DELETE ON authority_operations
BEGIN
  SELECT RAISE(ABORT, 'authority_operations is immutable');
END;
