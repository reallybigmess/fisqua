-- Notes fields for the two authority tables (authorities module spec §5,
-- record-page redesign follow-up ruling).
--
-- `descriptions` has carried the ISAD 3.6 pair (`notes` public,
-- `internal_notes` never published) since the union schema; the two
-- authority tables had neither, so cataloguers placing coordinates or
-- adjudicating merges had nowhere to record their reasoning. This adds
-- the same pair to `places` and `entities`. The export pipeline emits
-- neither column until a later ruling adds `notes` explicitly --
-- `internal_notes` must never reach a public artefact.
--
-- Additive nullable ADD COLUMNs: no backfill, no default, safe on every
-- environment.
--
-- Version: v0.4.3
ALTER TABLE places ADD COLUMN notes TEXT;
--> statement-breakpoint
ALTER TABLE places ADD COLUMN internal_notes TEXT;
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN notes TEXT;
--> statement-breakpoint
ALTER TABLE entities ADD COLUMN internal_notes TEXT;
