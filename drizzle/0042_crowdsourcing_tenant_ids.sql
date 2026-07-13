-- Crowdsourcing-subtree tenant_id hardening (federation step 1)
--
-- Adds a NOT NULL `tenant_id` column to the nine crowdsourcing tables
-- (projects, volumes, volume_pages, entries, qc_flags, comments,
-- resegmentation_flags, activity_log, drafts) and back-fills every
-- existing row to the seeded `neogranadina` tenant. Previously these
-- tables were scoped only transitively through the project creator,
-- which no longer holds once a second real tenant catalogues.
--
-- WHY ADD COLUMN INSTEAD OF 0035's TABLE REBUILD
-- ----------------------------------------------
-- 0035 rebuilt its five domain tables (CREATE _new / copy / DROP old /
-- RENAME) to add a NOT NULL tenant_id FK. That pattern is UNSAFE for this
-- cluster and was verified to fail on local D1:
--
--   * D1's migration runner sends every file as a single atomic query
--     with rollback-on-error. Inside it `PRAGMA foreign_keys=OFF` is
--     silently a no-op, and `PRAGMA defer_foreign_keys=ON` defers
--     constraint CHECKS but NOT ON DELETE CASCADE ACTIONS. So
--     `DROP TABLE volumes` (implicit DELETE) cascade-deletes its
--     children -- volume_pages, comments, qc_flags -- mid-migration,
--     before their own copies complete. (Observed locally: volume_pages
--     2 -> 0 after a defer_foreign_keys DROP TABLE volumes.)
--   * comments and qc_flags have a circular ON DELETE CASCADE / SET NULL
--     relationship, so any per-table drop of one cascade-deletes populated
--     rows of the other. 0035 only survived because its cascade children
--     were empty at v0.4 bootstrap; these tables are not.
--
-- `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT` is a metadata-only,
-- fully additive operation: it neither rewrites the table nor issues any
-- DELETE, so no cascade can fire. Existing rows are populated with the
-- default (the Neogranadina tenant), which IS the required back-fill.
--
-- DELIBERATE DIVERGENCES FROM 0035 (both forced by the constraint above):
--   1. No REFERENCES tenants(id) FK on these columns. ADD COLUMN cannot
--      combine NOT NULL with a foreign-key clause (SQLite requires a NULL
--      default for an added FK column). Tenancy is enforced in the loader
--      layer regardless (there is no RLS in D1 -- see federation spec I1);
--      the loader-predicate test harness is the structural backstop.
--   2. A column DEFAULT of the Neogranadina UUID. This performs the
--      back-fill and, in v0.4 (all crowdsourcing belongs to Neogranadina),
--      is a safe net. Follow-up at federation sequence step 4, when every
--      crowdsourcing writer sets tenant_id explicitly: remove the
--      `.default(...)` from the Drizzle schema declaration ONLY, so that
--      tenantId becomes required in the insert type and TypeScript forces
--      explicit writers. The DB-level default declared here stays in place
--      as inert metadata -- SQLite cannot alter a column default without
--      the table rebuild this file exists to avoid, and once no writer
--      omits the column the default is never consulted.
--
-- The back-fill literal is NEOGRANADINA_TENANT_ID from app/lib/tenant.ts
-- and must match byte-for-byte; it appears exactly nine times below.
--
-- Version: v0.4.2

ALTER TABLE projects             ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE volumes              ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE volume_pages         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE entries              ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE qc_flags             ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE comments             ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE resegmentation_flags ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE activity_log         ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
ALTER TABLE drafts               ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b';
