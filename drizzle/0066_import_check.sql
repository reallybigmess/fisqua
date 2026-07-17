-- import readiness check: findings cache, decisions, and the run's
-- acceptance snapshot (readiness-check design §3.5).
--
-- The Check step aggregates validation findings by problem class before
-- any dry run. `check_findings` caches the computed findings JSON
-- pinned to (profile_id, profile_version) — recomputed on drift, never
-- trusted across profile edits. `check_decisions` records which
-- decision classes the operator accepted (class keys + who + when);
-- acceptance is per upload and never carries to a re-upload.
--
-- `stewardship_runs.accepted_findings` is the audit copy: the
-- acceptances snapshotted at run mint, so the run record shows which
-- incompleteness the operator knowingly accepted even after the upload
-- row's working state moves on. Read at mint from the upload row,
-- never from client input.
--
-- Purely additive: ALTER TABLE ADD COLUMN only; nothing backfills.
-- Existing uploads read as unchecked (NULL findings), which is correct
-- — the check computes on first visit to the Check step.
--
-- Version: v0.6.0

ALTER TABLE import_uploads ADD COLUMN check_findings TEXT;
ALTER TABLE import_uploads ADD COLUMN check_decisions TEXT;
ALTER TABLE stewardship_runs ADD COLUMN accepted_findings TEXT;
