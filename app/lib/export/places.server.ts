/**
 * Place Formatter
 *
 * This module deals with mapping one Drizzle row off `places` into
 * the shape the published JSON expects. It filters each place to the
 * descriptions that reference it and are themselves publishable.
 *
 * Seven historical-administration columns
 * (historical_gobernacion, historical_partido, historical_region,
 * country_code, admin_level_1, admin_level_2, wikidata_id) were
 * dropped from the `places` table because the production-data audit
 * (../docs/fisqua/releases/0.4/0.4.0/production-data-audit.md)
 * confirmed 0% population on each. To preserve the public-export
 * JSON shape (consumers may have stored snapshots), the formatter
 * still emits these fields as `null`. The `fclass` column is now
 * sourced from the new `places.fclass` column (5-value GeoNames
 * feature class) rather than aliased from `place_type`.
 *
 * @version v0.4.0
 */

import type { ExportPlace } from "./types";

/**
 * Map a D1 place row to ExportPlace.
 * Key mapping: placeType -> place_type. fclass now reads from the
 * dedicated 0036 `fclass` column (5-value GeoNames feature class).
 */
export function formatPlace(row: {
  placeCode: string | null;
  label: string;
  displayName: string;
  placeType: string | null;
  fclass: string | null;
  nameVariants: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatePrecision: string | null;
  tgnId: string | null;
  hgisId: string | null;
  whgId: string | null;
}): ExportPlace {
  return {
    label: row.label,
    place_code: row.placeCode,
    display_name: row.displayName,
    place_type: row.placeType,
    fclass: row.fclass,
    name_variants: JSON.parse(row.nameVariants ?? "[]"),
    // Dropped in 0036; preserved as null in the export shape so
    // downstream consumers see a stable schema.
    historical_gobernacion: null,
    historical_partido: null,
    historical_region: null,
    country_code: null,
    admin_level_1: null,
    admin_level_2: null,
    latitude: row.latitude,
    longitude: row.longitude,
    coordinate_precision: row.coordinatePrecision,
    tgn_id: row.tgnId,
    hgis_id: row.hgisId,
    whg_id: row.whgId,
    // wikidata_id dropped on places in 0036 (0% populated); kept
    // as null in export shape for snapshot continuity.
    wikidata_id: null,
  };
}

/**
 * Filter places to only those linked to at least one published description.
 * The caller computes linkedPlaceIds from descriptionPlaces where
 * the description has isPublished=true.
 */
export function filterLinkedPlaces<T extends { id: string }>(
  places: T[],
  linkedPlaceIds: Set<string>
): T[] {
  return places.filter((p) => linkedPlaceIds.has(p.id));
}
