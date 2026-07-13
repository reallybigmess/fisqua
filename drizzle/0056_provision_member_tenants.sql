-- Provision the member tenants (federation migration sequence step 7).
--
-- WHAT STEP 7 DOES
-- ----------------
-- Greenfield provisioning of the three member tenants ruled in the
-- federation design spec §9 step 7 (CONCRETE PARAMETERS, 2026-07-08).
-- No data movement -- this file only grants a capability, creates two
-- new tenants, and grants federation access:
--
--   A. ahr (already exists, Neogranadina federation, created by 0051):
--      grant vocabulary_hub access to the Neogranadina federation's
--      shared authority space (vocabulary_hub_enabled 0 -> 1). Its other
--      three flags stay OFF (crowdsourcing ruled off; publish_pipeline
--      and multi_repository off).
--   B. sbmal (NEW, AMPL federation): Santa Barbara Mission
--      Archive-Library, descriptive_standard DACS. vocabulary_hub ON
--      (AMPL's own authority space -- see Part E), the other three OFF.
--   C. komuni (NEW, Neogranadina federation): Komuni, descriptive_standard
--      ISAD(G). Capability profile identical to ahr (vocabulary_hub ON,
--      the other three OFF).
--   D. juan@neogranadina.org gets a `steward` federation_memberships row
--      in BOTH the Neogranadina and AMPL federations -- this single pair
--      of grants covers all three member tenants (ahr + komuni via the
--      Neogranadina grant, sbmal via the AMPL grant). No other users are
--      provisioned yet.
--
-- WHY THIS IS PURELY ADDITIVE AND HAS NO CIRCULAR-FK PROBLEM
-- ---------------------------------------------------------
-- Unlike 0044 (which had to sequence around the tenants <-> federations
-- circular FK when the federations themselves were being created), BOTH
-- target federations already exist (Neogranadina + AMPL, seeded by 0044,
-- both multi_member_enabled=1). The new tenant rows reference federations
-- that are already present, so every FK resolves at insert time with no
-- ordering dance. One UPDATE + two INSERTs + two guarded membership
-- INSERTs; no schema change, no table rebuild, no DROP, no backfill of an
-- existing populated table -- none of the D1 cascade / 30s-budget hazards
-- the 0042/0045/0051 headers document can fire here. Local wall time is a
-- few milliseconds.
--
-- IDEMPOTENCY
-- -----------
-- Every statement is safe to re-apply (whole file or a manual re-exec):
--   * Part A is a plain SET on one known row -- re-running writes the same
--     value.
--   * Parts B/C are INSERT OR IGNORE (PK/slug conflict -> ignored).
--   * Part D inserts via SELECT ... WHERE NOT EXISTS a membership for that
--     (user, federation), so it is a no-op both when juan is absent (the
--     SELECT yields no row) and when the grant already exists (the guard
--     fails) -- and it respects the (user_id, federation_id) unique index
--     (fed_memberships_user_federation_idx) rather than relying on the
--     constraint to swallow a duplicate.
--
-- WHY PART D KEYS ON EMAIL, NOT A HARDCODED USER UUID
-- --------------------------------------------------
-- User rows are seeded per-environment (local/CI vs production do NOT
-- share user UUIDs), exactly the lesson step 6 applied to repository
-- codes. A hardcoded user UUID would be a silent NO-OP in whichever
-- environment does not have that literal. The stable cross-environment
-- identifier is the email address, so each grant resolves juan's id
-- through `FROM users u WHERE u.email = 'juan@neogranadina.org'`. This is
-- correctly a no-op in any environment where that user is absent (e.g.
-- local D1 today has no such user) and correct where present.
--
-- E. AMPL VOCABULARY SEED -- DELIBERATELY DEFERRED (NOT DONE HERE)
-- ---------------------------------------------------------------
-- The spec rules that AMPL's authority space is "seeded by copying
-- Neogranadina's canonical terms" at provisioning. That copy is NOT
-- expressed in this migration, for two reasons:
--
--   1. It is a 0-row no-op today: production `vocabulary_terms` is empty
--      (0 rows -- verified 2026-07-08, and again on local D1). There is
--      nothing to copy right now.
--   2. A CORRECT copy is not cleanly expressible in pure SQL. It is not a
--      plain `INSERT ... SELECT` with fresh UUIDs:
--        - vocabulary_terms.merged_into is a self-referential pointer to
--          another vocabulary_terms.id. Copied rows would need every
--          merged_into remapped from the source term id to its NEW copy
--          id -- which requires an old-id -> new-id mapping table, and
--          SQLite cannot both mint a fresh v4 UUID per row AND reference
--          that same generated value again to build the mapping in one
--          statement. A pure-SQL version is a multi-statement temp-table
--          dance that is easy to get subtly wrong.
--        - entity_count must RESET to 0 on the copies (AMPL has no
--          entities referencing these terms yet), not carry Neogranadina's
--          counts.
--        - proposed_by / reviewed_by are user FKs into Neogranadina users
--          who are not AMPL/steward users; whether to null them or keep
--          them as provenance is an application-level decision.
--      Faking a half-correct copy (fresh UUIDs but stale merged_into /
--      entity_count) would corrupt AMPL's authority space the moment
--      canonical terms exist. Per the spec's own instruction, we do NOT
--      fake it.
--
-- The AMPL vocabulary seed is therefore DEFERRED to the steward
-- provisioning flow (the steward primitives landed in step 4). It will
-- copy Neogranadina's canonical terms -- with correct fresh ids,
-- merged_into remapping, entity_count reset, and a proposed_by/reviewed_by
-- provenance rule -- when canonical terms actually exist. Wiring the copy
-- mechanism there (not here) keeps this migration honest: it grants AMPL
-- the vocabulary_hub capability (sbmal.vocabulary_hub_enabled = 1) so the
-- space is reachable, and leaves the (currently empty) copy to code that
-- can do it correctly.
--
-- The sbmal + komuni tenant UUIDs MUST match app/lib/tenant.ts
-- (SBMAL_TENANT_ID / KOMUNI_TENANT_ID) byte-for-byte; NEOGRANADINA /
-- AMPL federation UUIDs match the 0044 seed literals; the two membership
-- UUIDs are fixed literals minted for this migration.
--
-- Version: v0.4.2

-- A. Grant the existing ahr tenant vocabulary_hub access to the
-- Neogranadina federation's shared authority space. Plain SET on the one
-- known row (idempotent). The other three capability flags are left
-- unchanged (all OFF).
UPDATE tenants
SET vocabulary_hub_enabled = 1, updated_at = 1780000000000
WHERE id = 'c82525bd-13d5-46dd-9c1b-e258507b966c';

-- B. Create the sbmal tenant (AMPL federation, DACS). INSERT OR IGNORE
-- for idempotency; the AMPL federation row already exists from 0044.
INSERT OR IGNORE INTO tenants (
  id, slug, name, kind, descriptive_standard, status,
  crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled,
  quota_storage_bytes, federation_id, created_at, updated_at
) VALUES (
  'a0412263-176c-45be-96c7-6421c9d2ad51', 'sbmal', 'Santa Barbara Mission Archive-Library', 'tenant', 'dacs', 'active',
  0, 1, 0, 0,
  NULL, '113c1dab-e201-46fc-9620-0642131613ae', 1780000000000, 1780000000000
);

-- C. Create the komuni tenant (Neogranadina federation, ISAD(G)).
-- Capability profile identical to ahr. INSERT OR IGNORE for idempotency;
-- the Neogranadina federation row already exists from 0044.
INSERT OR IGNORE INTO tenants (
  id, slug, name, kind, descriptive_standard, status,
  crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled,
  quota_storage_bytes, federation_id, created_at, updated_at
) VALUES (
  '7f17a2e6-a673-454a-ad35-9e06acc02d90', 'komuni', 'Komuni', 'tenant', 'isadg', 'active',
  0, 1, 0, 0,
  NULL, 'b4462493-6170-44f8-ae07-24666606d1f1', 1780000000000, 1780000000000
);

-- D. Grant juan@neogranadina.org a steward membership in the Neogranadina
-- federation. Keyed on email (stable across environments); guarded on
-- NOT EXISTS so it is a no-op when the user is absent OR the grant already
-- exists. Respects fed_memberships_user_federation_idx.
INSERT INTO federation_memberships (id, user_id, federation_id, role, created_at)
SELECT '6255b2b0-0293-421a-ab00-636b78a98ca7', u.id, 'b4462493-6170-44f8-ae07-24666606d1f1', 'steward', 1780000000000
FROM users u
WHERE u.email = 'juan@neogranadina.org'
  AND NOT EXISTS (
    SELECT 1 FROM federation_memberships m
    WHERE m.user_id = u.id
      AND m.federation_id = 'b4462493-6170-44f8-ae07-24666606d1f1'
  );

-- D. Grant juan@neogranadina.org a steward membership in the AMPL
-- federation (covers sbmal). Same email-keyed, NOT EXISTS-guarded shape.
INSERT INTO federation_memberships (id, user_id, federation_id, role, created_at)
SELECT 'aa7f00ed-cee4-42e9-8170-2534c2d181af', u.id, '113c1dab-e201-46fc-9620-0642131613ae', 'steward', 1780000000000
FROM users u
WHERE u.email = 'juan@neogranadina.org'
  AND NOT EXISTS (
    SELECT 1 FROM federation_memberships m
    WHERE m.user_id = u.id
      AND m.federation_id = '113c1dab-e201-46fc-9620-0642131613ae'
  );
