-- import_profiles: named, per-tenant, versioned mapping profiles
-- (imports spec §2; build plan phase 3).
--
-- One row per profile. `bindings` is the JSON mapping — CSV HEADER
-- NAMES (never positional indices; the N2-TSV column-shift incident,
-- survey §7.11b) to description fields, each binding carrying an
-- optional transform spec. The shape is Zod-validated at the app
-- layer before any write; the DB stores it opaque.
--
-- Versioning: a profile is a single mutable row whose `version`
-- increments on every bindings edit. Runs pin (profile_id,
-- profile_version) on the stewardship_runs envelope (0062), so a run
-- records WHICH version it used and drift is detectable; reversal
-- never needs to replay a mapping — the journal's before-images
-- (0063) carry the actual effects.
--
-- Sharing (spec §7.3 ruling): `shared_with_federation` marks a
-- profile visible read-only to federation member tenants. Only
-- meaningful on profiles owned by a federation-lead tenant; enforced
-- at the app layer, not here.
--
-- `starter_key` marks seeded starter profiles (build plan phase 7:
-- AtoM ISAD(G), AGN FUID, EAP, MEAP, and the generated Fisqua
-- canonical template) so seeding is idempotent and upgradable;
-- NULL = operator-authored.
--
-- FKs: tenant_id and the user attribution columns are real and
-- RESTRICT (a profile's scope and author must exist). Nothing
-- references import_profiles by FK: stewardship_runs.profile_id is
-- deliberately FK-free (0062) so a run stays readable after its
-- profile is deleted, and deleting a profile is allowed.
--
-- Purely additive: CREATE TABLE + CREATE INDEX only, IF NOT EXISTS
-- throughout; nothing backfills.
--
-- Version: v0.6.0

CREATE TABLE IF NOT EXISTS import_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  version INTEGER NOT NULL DEFAULT 1,
  bindings TEXT NOT NULL,
  starter_key TEXT,
  shared_with_federation INTEGER NOT NULL DEFAULT 0 CHECK (shared_with_federation IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS import_profiles_tenant_name_unq ON import_profiles(tenant_id, name);
CREATE INDEX IF NOT EXISTS import_profiles_tenant_idx ON import_profiles(tenant_id, updated_at);
