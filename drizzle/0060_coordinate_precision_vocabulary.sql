-- Controlled coordinate-precision vocabulary (authorities module spec §5,
-- record-page redesign follow-up ruling).
--
-- `coordinate_precision` arrived from the Django dump carrying six
-- legacy pipeline codes (v2_trn_H/M/L, v2_bnng_H/M/L) whose generating
-- code survives nowhere in the workspace. The 2026-07-12 empirical
-- characterisation (structural signatures plus a 90-sample geocoder
-- distance test) established: the prefix is the placement method
-- (`bnng` = precise gazetteer-grade point, 4.5+ decimals, all distinct;
-- `trn` = coarse contextual placement, 1-2 decimals, neighbouring
-- places sharing rounded points) and the H/M/L suffix is an honest
-- confidence grade (median distance to a modern geocoder match rises
-- monotonically H -> M -> L in both families).
--
-- The field becomes a four-value vocabulary enforced at the app-layer
-- Zod boundary (per the union-schema convention; no DB CHECK):
-- exact / approximate / centroid / uncertain, NULL = not recorded.
-- Mapping: both _H codes -> approximate (873 rows at authoring time);
-- all _M and _L codes -> uncertain (554 rows). Nothing maps to `exact`
-- or `centroid` automatically -- those are human judgements. Values
-- outside the six known codes are left untouched, never destroyed.
--
-- Each rewritten row first archives its original code as a
-- `zasqua-precision` entry in `legacy_ids`, so the mapping is fully
-- recoverable.
--
-- `needs_geocoding` is dropped: coordinate status is now derived
-- (no coords = unset; coords + uncertain = review worklist; coords
-- otherwise = located), and a stored flag alongside a derived status
-- is a drift pair. The places FTS triggers reference only the three
-- name columns, and no index, view, or CHECK touches the column, so
-- ALTER TABLE DROP COLUMN is safe.
--
-- Version: v0.4.3
UPDATE places
SET legacy_ids = json_insert(
  legacy_ids, '$[#]',
  json_object('provider', 'zasqua-precision', 'id', coordinate_precision)
)
WHERE coordinate_precision IN
  ('v2_trn_H', 'v2_trn_M', 'v2_trn_L', 'v2_bnng_H', 'v2_bnng_M', 'v2_bnng_L');
--> statement-breakpoint
UPDATE places SET coordinate_precision = 'approximate'
WHERE coordinate_precision IN ('v2_trn_H', 'v2_bnng_H');
--> statement-breakpoint
UPDATE places SET coordinate_precision = 'uncertain'
WHERE coordinate_precision IN
  ('v2_trn_M', 'v2_trn_L', 'v2_bnng_M', 'v2_bnng_L');
--> statement-breakpoint
ALTER TABLE places DROP COLUMN needs_geocoding;
