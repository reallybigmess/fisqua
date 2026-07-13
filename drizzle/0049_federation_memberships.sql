-- Federation memberships (federation migration sequence step 4)
--
-- Introduces `federation_memberships`: the join table that lets a
-- federation-lead staff member reach into the federation's member
-- tenants via a grant, generalising the platform -> tenant
-- impersonation pattern one scoping level down (federation spec §3/§4).
-- A row `(userId, federationId, role)` says "this user, whose HOME
-- tenant is elsewhere, may act in every tenant of this federation at
-- the effective role its `role` maps to" (steward = admin-equivalent;
-- staff = cataloguer/editor-equivalent, never member-tenant admin --
-- invariant I6).
--
-- WHY THIS IS PURELY ADDITIVE AND FAST
-- ------------------------------------
-- A single `CREATE TABLE` plus its indexes. It writes no existing row,
-- issues no UPDATE/DELETE, and touches none of the populated
-- crowdsourcing or authority tables, so none of the D1 cascade hazards
-- the 0042/0045 headers document can fire here. Local wall time is a
-- few milliseconds -- far under the ~1s/file budget 0045's header sets.
--
-- FK DELETE BEHAVIOUR
-- -------------------
-- Both FKs are `ON DELETE CASCADE`: a membership is meaningless once
-- either its user or its federation is gone, and neither users nor
-- federations are deleted in normal operation (users are soft-managed;
-- federations RESTRICT on their lead tenant). CASCADE keeps the join
-- table self-cleaning if a hard delete ever occurs, with no orphan
-- rows and no RESTRICT block on an otherwise-legal delete.
--
-- UNIQUENESS
-- ----------
-- `UNIQUE (user_id, federation_id)` -- at most one membership row per
-- (user, federation) pair, so a user's role in a federation is
-- single-valued. Role changes are an UPDATE of the existing row, not a
-- second row.
--
-- No rows are seeded here. Every federation is a federation-of-one
-- until a member tenant is provisioned (steps 6-7); the first real
-- membership rows are minted by the steward/operator provisioning
-- surfaces, not by this migration.
--
-- Version: v0.4.2

CREATE TABLE federation_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('steward','staff')),
  created_at INTEGER NOT NULL
);

-- Named to match app/db/schema.ts's uniqueIndex/index declarations. The
-- composite UNIQUE both enforces one membership per (user, federation)
-- pair and serves user_id-prefix lookups; the federation_id index serves
-- "all memberships in this federation" scans (member-roster surfaces).
CREATE UNIQUE INDEX fed_memberships_user_federation_idx ON federation_memberships(user_id, federation_id);
CREATE INDEX fed_memberships_federation_idx ON federation_memberships(federation_id);
