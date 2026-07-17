-- Changelog becomes the stewardship journal
-- (stewardship record spec §3; imports build plan phase 2).
--
-- Two additive columns:
--   * run_id — which stewardship run caused this row; NULL = an
--     ordinary hand edit. No FK: journal rows must stay readable
--     regardless of anything that happens around runs, mirroring the
--     ledger-discipline no-FK rule (0057 header).
--   * kind — the effect discriminator. Existing rows are all field
--     updates, so DEFAULT 'update' is the correct backfill for every
--     historical row as well as the safe default for hand-edit writes.
--     Journal contract per kind (spec §3): create = full new-row
--     snapshot ({old: null}), update = ordinary field diff (the
--     before-image), delete = full pre-image ({new: null}),
--     link/unlink = the junction row's content.
--
-- Plus the run index (revert walks a run's journal) and the
-- append-only triggers RULED 2026-07-12: the journal is now
-- load-bearing for revert, so rows must be immutable at the DB level.
-- Bare unconditional RAISE form (the 0057 rationale): changelog's
-- user_id FK has no ON DELETE action (NO ACTION — a user delete would
-- FK-error, not cascade), so no cascade ever mutates a row and no WHEN
-- carve-out is needed. Verified before this migration: no application
-- code path UPDATEs or DELETEs changelog rows (stewardship internal
-- survey §1). The only way past the triggers is DROP TRIGGER in a
-- migration, auditable in source control.
--
-- Version: v0.6.0

ALTER TABLE changelog ADD COLUMN run_id TEXT;
ALTER TABLE changelog ADD COLUMN kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('create', 'update', 'delete', 'link', 'unlink'));

CREATE INDEX IF NOT EXISTS changelog_run_idx ON changelog(run_id);

CREATE TRIGGER IF NOT EXISTS changelog_no_update
BEFORE UPDATE ON changelog
BEGIN
  SELECT RAISE(ABORT, 'changelog is append-only');
END;

CREATE TRIGGER IF NOT EXISTS changelog_no_delete
BEFORE DELETE ON changelog
BEGIN
  SELECT RAISE(ABORT, 'changelog is immutable');
END;
