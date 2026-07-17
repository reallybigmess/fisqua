-- import_uploads: the metadata row behind every staged CSV upload
-- (imports spec §§1, 4; build plan phase 3 "staged object + metadata
-- row").
--
-- The staged FILE lives in the staging store (B2 staging bucket in
-- production, the local R2 binding in dev/tests — spec §7.4);
-- `artifact_key` points at it. This row carries what the upload →
-- profile → dry-run → commit flow needs without re-fetching the
-- object: original filename, size, parsed header names, row count,
-- the chosen profile, and the latest dry-run report artifact
-- (written before and independently of any commit — the pre-write
-- audit discipline, spec §4).
--
-- Encoding-rejected files (anything not UTF-8/utf-8-sig, spec §4.1)
-- never stage an object and never get a row: rejection happens at
-- intake with a named error.
--
-- Lifecycle: staged → committed (run_id stamped) | discarded.
-- Discard is a status flip, not a DELETE — the artifact may already
-- be referenced by a dry-run report, and honest bookkeeping beats
-- tidy tables at this volume.
--
-- FKs: tenant_id/user_id real and RESTRICT (scope and uploader must
-- exist). run_id carries a real FK — stewardship_runs rows are never
-- deleted (0062 mutability contract), so the reference is safe.
-- profile_id is FK-free, mirroring stewardship_runs.profile_id: an
-- upload must stay readable after its profile is deleted.
--
-- Purely additive: CREATE TABLE + CREATE INDEX only, IF NOT EXISTS
-- throughout; nothing backfills.
--
-- Version: v0.6.0

CREATE TABLE IF NOT EXISTS import_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  row_count INTEGER,
  headers TEXT,
  profile_id TEXT,
  profile_version INTEGER,
  report_artifact TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'committed', 'discarded')),
  run_id TEXT REFERENCES stewardship_runs(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS import_uploads_tenant_idx ON import_uploads(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS import_uploads_status_idx ON import_uploads(status);
