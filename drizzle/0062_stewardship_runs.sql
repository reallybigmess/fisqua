-- stewardship_runs: the commit envelope for bulk operations
-- (stewardship record spec §2; imports build plan phase 2).
--
-- One row per bulk operation — an import run or a revert run. The
-- envelope carries the REQUIRED operator message (the commit-message
-- discipline: no bulk mutation without a stated reason), attribution,
-- revert linkage, artifact pointers, and the export_runs-shaped
-- Cloudflare Workflows lifecycle columns (0018/0019/0055 precedent).
--
-- Purely additive: CREATE TABLE + CREATE INDEX only, IF NOT EXISTS
-- throughout; nothing backfills.
--
-- Mutability contract (spec §6): rows are minted once; ONLY the
-- lifecycle/linkage columns (status, step tracking, heartbeats,
-- error_message, started/completed_at, reverted_by_run_id) are ever
-- updated, and only by the Workflow and the revert stamp. No
-- append-only triggers here — unlike the journal (0063), the envelope
-- legitimately transitions state. Rows are never deleted by
-- application code.
--
-- FKs: tenant_id, federation_id, user_id are real (a run's scope and
-- author must exist; RESTRICT so no cascade can consume a ledger row).
-- reverts_run_id / reverted_by_run_id carry NO foreign key (spec §2):
-- ledger rows must stay referenceable forever, mirroring
-- authority_operations.source_id. profile_id carries no FK — the
-- import_profiles table lands in a later phase, and a run must remain
-- readable even if its profile is later deleted.
--
-- Version: v0.6.0

CREATE TABLE IF NOT EXISTS stewardship_runs (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'revert')),
  message TEXT NOT NULL CHECK (length(trim(message)) > 0),
  justification TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'error')),
  reverts_run_id TEXT,
  reverted_by_run_id TEXT,
  profile_id TEXT,
  profile_version INTEGER,
  source_artifact TEXT,
  report_artifact TEXT,
  record_counts TEXT,
  workflow_instance_id TEXT,
  current_step TEXT,
  steps_completed INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  current_step_started_at INTEGER,
  current_step_completed_at INTEGER,
  last_heartbeat_at INTEGER,
  error_message TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS stewardship_runs_tenant_idx ON stewardship_runs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS stewardship_runs_status_idx ON stewardship_runs(status);
CREATE INDEX IF NOT EXISTS stewardship_runs_reverts_idx ON stewardship_runs(reverts_run_id);
