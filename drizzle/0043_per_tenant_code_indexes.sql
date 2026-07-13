-- Per-tenant unique indexes on descriptions.reference_code and repositories.code
--
-- Federation-migration sequence step 5. The two code indexes were
-- global UNIQUE (a latent cross-tenant collision bug: reference codes
-- and repository codes collide the moment a second real tenant
-- catalogues). Both descriptions and repositories already carry a
-- NOT NULL tenant_id (migration 0035), so the collision domain is
-- correctly the tenant, not the platform.
--
--   - descriptions.reference_code: UNIQUE (reference_code)  -> UNIQUE (tenant_id, reference_code)
--   - repositories.code:           UNIQUE (code)            -> UNIQUE (tenant_id, code)
--
-- The index names are preserved (desc_ref_code_idx, repo_code_idx) so
-- app/db/schema.ts's uniqueIndex declarations continue to match by
-- name; only the indexed column tuple changes.
--
-- Additive and non-destructive: dropping and recreating a secondary
-- index touches no table rows. No table rebuild is needed because both
-- tables already have tenant_id.
--
-- Collision safety: the new composite (tenant_id, X) is strictly weaker
-- than the pre-existing single-column UNIQUE(X), so no pair of rows that
-- satisfied the old constraint can violate the new one. A duplicate
-- pre-check on local D1 (GROUP BY tenant_id, X HAVING COUNT(*) > 1)
-- returned zero rows for both tables before this migration was written.
--
-- Version: v0.4.2

DROP INDEX desc_ref_code_idx;
CREATE UNIQUE INDEX desc_ref_code_idx ON descriptions(tenant_id, reference_code);

DROP INDEX repo_code_idx;
CREATE UNIQUE INDEX repo_code_idx ON repositories(tenant_id, code);
