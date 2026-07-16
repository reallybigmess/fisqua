-- Per-tenant draft uniqueness: (tenant_id, record_id, record_type)
--
-- Federation step-4 amendment (adversarial review, 2026-07-08).
-- Draft uniqueness was GLOBAL on (record_id, record_type) -- a
-- cross-tenant collision the moment two tenants autosave against the
-- same record id. That moment arrives at federation step 6: entities
-- and places are federation-SHARED authorities (migrations 0045-0048),
-- their autosave path is deliberately not steward-gated, so a member
-- tenant's admin autosaving on a shared entity would UPDATE (clobber
-- and effectively re-tenant) the lead tenant's draft on the same
-- record, and any (record_id, record_type) lookup would read another
-- tenant's in-progress edits. Scoping the uniqueness domain to the
-- tenant lets each tenant hold its own draft on a shared authority
-- record; the drafts helpers gain the matching tenant_id predicate in
-- the same change.
--
-- WHY A TABLE REBUILD (and why it is legal HERE despite 0042's header)
-- --------------------------------------------------------------------
-- The old uniqueness is NOT a named index: 0016 declared it as a
-- table-level `UNIQUE(record_id, record_type)` constraint, backed by
-- an unnamed sqlite_autoindex that SQLite refuses to DROP. (The name
-- `drafts_record_idx` existed only in app/db/schema.ts and the test
-- harness -- verified against live sqlite_master before this file was
-- written.) A table constraint can only be changed by rebuilding the
-- table. 0042's header prohibits the rebuild pattern for populated
-- tables WITH CASCADE CHILDREN, because inside D1's per-file
-- transaction `DROP TABLE` (implicit DELETE) fires child ON DELETE
-- CASCADE actions that defer_foreign_keys does not defer. `drafts` has
-- NO children of any kind: a sqlite_master scan for '%drafts%' outside
-- the table itself returns nothing (no FKs reference it, no trigger or
-- view mentions it), so no cascade can fire and the rebuild is safe.
-- Its own outgoing FK (user_id -> users) is unaffected -- deleting
-- child-side rows never violates or actions a FK.
--
-- The rebuilt table keeps the current production column shape
-- byte-for-byte, including the inert `tenant_id ... DEFAULT
-- '<neogranadina-uuid>'` that 0042 appended (writers all set tenant_id
-- explicitly since step 4; keeping the default preserves the
-- nine-table uniformity that 0042's header documents). The uniqueness
-- moves from a table constraint to the NAMED index
-- `drafts_record_idx` so app/db/schema.ts's uniqueIndex declaration
-- matches by name from here on.
--
-- The new composite (tenant_id, record_id, record_type) is strictly
-- weaker than the old (record_id, record_type), so no existing rows
-- can violate it. drafts is a small autosave scratch table; the whole
-- file runs in single-digit milliseconds on local D1, far under the
-- ~1s/file budget (0045 header). The copy INSERT uses an explicit
-- column list, so it is immune to column-order drift. Each migration
-- file is one atomic /query call with rollback-on-error (atomicity
-- pre-flight confirmed against production before 0042), so no partial
-- state (e.g. table dropped, rename missing) can survive a failure.
--
-- Version: v0.4.2

CREATE TABLE drafts_new (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  snapshot TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b'
);

INSERT INTO drafts_new (id, record_id, record_type, user_id, snapshot, updated_at, tenant_id)
  SELECT id, record_id, record_type, user_id, snapshot, updated_at, tenant_id FROM drafts;

DROP TABLE drafts;

ALTER TABLE drafts_new RENAME TO drafts;

CREATE UNIQUE INDEX drafts_record_idx ON drafts(tenant_id, record_id, record_type);
CREATE INDEX drafts_user_idx ON drafts(user_id);
