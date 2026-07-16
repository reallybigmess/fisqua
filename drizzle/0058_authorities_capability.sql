-- Authorities capability flag (authorities module spec §6).
--
-- Adds the `authorities_enabled` capability column to `tenants`, the
-- gate on the entity/place authority surface: the admin routes, the
-- sidebar entries, the description-form Entity/Place pickers, the
-- link/unlink intents, and the entities.json/places.json export steps.
--
-- Additive ADD COLUMN with DEFAULT 1, mirroring the
-- crowdsourcing/vocabulary_hub/publish_pipeline/multi_repository
-- precedent: the default makes the rollout behaviour-neutral -- every
-- existing tenant keeps the authority surface it has today. SQLite
-- cannot later drop a column default without the prohibited table
-- rebuild, but DEFAULT 1 is the correct back-fill for every current AND
-- future tenant (authorities on is the norm; the two exceptions below
-- are set explicitly), so unlike federation_id (0044 header) there is a
-- safe default here.
--
-- The two greenfield member tenants launch strings-only (spec §7 ruling
-- 5): komuni and sbmal catalogue with the plain-text creator/place
-- display fields and opt into authorities later when they have
-- authority-cataloguing capacity. They are matched by their stable slug
-- (local/CI and production share slugs but NOT tenant UUIDs -- the
-- 0056 email-keyed lesson), so each UPDATE is a correct no-op in any
-- environment where that member is absent and correct where present.
--
-- Version: v0.4.2
ALTER TABLE tenants ADD COLUMN authorities_enabled INTEGER NOT NULL DEFAULT 1;

UPDATE tenants SET authorities_enabled = 0, updated_at = 1780000000000 WHERE slug = 'komuni';
UPDATE tenants SET authorities_enabled = 0, updated_at = 1780000000000 WHERE slug = 'sbmal';
