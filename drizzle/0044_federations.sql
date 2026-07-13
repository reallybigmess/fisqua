-- Federations foundation (federation migration sequence step 2)
--
-- Introduces the `federations` table (the scoping level above tenants:
-- platform > federation > tenant), seeds the three federations that back
-- the current tenant set, and adds `tenants.federation_id` so EVERY
-- tenant belongs to exactly one federation (federation spec §2 — a
-- standalone tenant is a federation of one).
--
-- WHY federation_id IS "NULLABLE-WITH-FK + BACKFILL", NOT "NOT NULL DEFAULT"
-- ------------------------------------------------------------------------
-- 0042 added `tenant_id NOT NULL DEFAULT '<neogranadina-uuid>'` to the
-- crowdsourcing tables: safe there because in v0.4 ALL crowdsourcing
-- belongs to Neogranadina, so the baked-in default IS the correct
-- back-fill for every existing AND future row until step 4 removes the
-- Drizzle `.default(...)`.
--
-- federation_id is different. There is NO single correct default
-- federation for future tenants: neogranadina belongs to the
-- Neogranadina federation, ampl to the AMPL federation, and every future
-- member/solo tenant to its own. A baked-in DEFAULT would silently file
-- the next provisioned tenant under whichever federation the literal
-- names -- and since federation_id sits at the ROOT of the authority
-- scoping tree (entities/places/vocabularies resolve through it), a
-- wrong default is a cross-federation data-integrity failure, strictly
-- worse than a NULL. SQLite also cannot later drop a column default
-- without the prohibited table rebuild (see 0042's header), so the wrong
-- default would be permanent.
--
-- Therefore: `ADD COLUMN federation_id TEXT REFERENCES federations(id)`
-- -- nullable at the DB layer, with a REAL foreign key (referential
-- integrity on the scoping root: a tenant can never point at a
-- non-existent federation) -- then UPDATE-backfill every current tenant.
-- NOT NULL is enforced at the Drizzle/app layer (schema.ts declares the
-- column `.notNull()`, so reads type it as `string` and inserts must
-- supply it -- a compile error otherwise, which is the intended
-- fail-loud since there is no safe default). ADD COLUMN cannot combine
-- NOT NULL with a REFERENCES clause anyway (SQLite requires a NULL
-- default for an added FK column), and the table-rebuild alternative is
-- prohibited (0042 header). This is option (a) of the amended spec.
--
-- AMPL TENANT RECONCILIATION
-- --------------------------
-- The `ampl` tenant (UUID 8d235621-..., "Archives, Memory, and
-- Preservation Lab") was inserted into PRODUCTION D1 by hand via
-- `wrangler d1 execute --remote` during phase 32 and was never captured
-- in a migration or seed, so it is absent from local/CI D1. The AMPL
-- federation's lead_tenant_id FK needs it to exist, and on production
-- the ampl tenant must also receive a federation_id (else it violates
-- "every tenant has a federation"). The `INSERT OR IGNORE` below
-- reconciles the gap: a no-op on production (row already present, by
-- PK/slug), and the missing seed on local/CI. Shape mirrors the phase-32
-- production insert byte-for-byte (slug 'ampl', all four capabilities
-- ON, descriptive_standard 'isadg', status 'active').
--
-- CIRCULAR FK NOTE
-- ----------------
-- tenants <-> federations is a circular FK pair (federations.lead_tenant_id
-- -> tenants.id; tenants.federation_id -> federations.id). D1 enforces
-- FKs per-statement with no DEFERRED support. This file sidesteps the
-- cycle by ordering: create + populate `federations` (its lead FKs point
-- at tenants that already exist) BEFORE adding tenants.federation_id, so
-- no statement ever references a not-yet-existing row.
--
-- The three federation UUIDs MUST match app/lib/tenant.ts
-- (NEOGRANADINA_FEDERATION_ID / AMPL_FEDERATION_ID / PLATFORM_FEDERATION_ID)
-- byte-for-byte; the tenant UUIDs match the 0034 seed literals.
--
-- Version: v0.4.2

CREATE TABLE federations (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lead_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  -- Operator-set gate on whether a federation can have MEMBERS at all
  -- (federation spec §5, ruled 2026-07-07). Default 0: every federation
  -- starts as a federation-of-one. Neogranadina and AMPL are enabled at
  -- provisioning (below); the platform federation-of-one stays 0.
  multi_member_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX federations_slug_idx ON federations(slug);
CREATE INDEX federations_lead_tenant_idx ON federations(lead_tenant_id);

-- Reconcile the hand-inserted production `ampl` tenant into local/CI D1.
-- No-op on production (PK/slug conflict -> ignored).
INSERT OR IGNORE INTO tenants (
  id, slug, name, kind, descriptive_standard, status,
  crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled,
  quota_storage_bytes, created_at, updated_at
) VALUES (
  '8d235621-ae3b-4751-a241-20341efd6d3a', 'ampl', 'Archives, Memory, and Preservation Lab', 'tenant', 'isadg', 'active',
  1, 1, 1, 1,
  NULL, 1778100000000, 1778100000000
);

-- Seed the three federations backing the current tenant set. Lead
-- tenants all exist by this point (neogranadina + platform from 0034,
-- ampl reconciled just above).
INSERT INTO federations (id, slug, name, lead_tenant_id, status, multi_member_enabled, created_at) VALUES
  ('b4462493-6170-44f8-ae07-24666606d1f1', 'neogranadina', 'Neogranadina', 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', 'active', 1, 1778100000000),
  ('113c1dab-e201-46fc-9620-0642131613ae', 'ampl',         'AMPL',         '8d235621-ae3b-4751-a241-20341efd6d3a', 'active', 1, 1778100000000),
  ('de8b3778-6aca-44f7-a849-f93efd27e542', 'platform',     'Platform',     '0391baa2-0bab-44ae-ac08-9fa7eb7c6145', 'active', 0, 1778100000000);

-- Add the scoping column (nullable + real FK, no default -- see header)
-- and back-fill every current tenant to its federation.
ALTER TABLE tenants ADD COLUMN federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT;

UPDATE tenants SET federation_id = 'b4462493-6170-44f8-ae07-24666606d1f1' WHERE id = 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'; -- neogranadina -> Neogranadina federation
UPDATE tenants SET federation_id = '113c1dab-e201-46fc-9620-0642131613ae' WHERE id = '8d235621-ae3b-4751-a241-20341efd6d3a'; -- ampl        -> AMPL federation
UPDATE tenants SET federation_id = 'de8b3778-6aca-44f7-a849-f93efd27e542' WHERE id = '0391baa2-0bab-44ae-ac08-9fa7eb7c6145'; -- platform    -> platform federation-of-one
