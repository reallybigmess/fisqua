-- Authorities lift, file 2 of 4: entities federation_id backfill.
--
-- One statement, one /query call, its own 30s budget (see 0045's header
-- for the chunk-per-file rationale). 78,276 rows; the FTS AFTER-UPDATE
-- trigger was dropped in 0045, so this writes exactly one row per row
-- (no shadow-table churn). Each row's federation resolves through its
-- tenant -- the JOIN-backfill form, not a baked-in literal, so the
-- statement stays correct even if a second tenant's authorities existed.
-- Idempotent: WHERE federation_id IS NULL makes a failed-and-retried
-- file safe (already-backfilled rows are untouched).
--
-- Measured on local D1 (workerd) before landing: well under 1s wall
-- time -- see the 0045 header's ~1s-per-file budget.
--
-- Version: v0.4.2

UPDATE entities SET federation_id = (SELECT t.federation_id FROM tenants t WHERE t.id = entities.tenant_id) WHERE federation_id IS NULL;
