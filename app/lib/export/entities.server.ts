/**
 * Entity Formatter
 *
 * This module deals with mapping one Drizzle row off `entities` into
 * the shape the published JSON expects. It filters each entity to the
 * descriptions that reference it and are themselves publishable, so
 * unpublished work never leaks through the entity index.
 *
 * @version v0.4.0
 */

import type { ExportEntity } from "./types";

/**
 * Map a D1 entity row to ExportEntity.
 * Key mappings:
 * - entityCode -> entity_code
 * - dateStart -> date_start AND date_earliest (legacy frontend alias)
 * - dateEnd -> date_end AND date_latest (legacy frontend alias)
 * - particle is always null (no D1 column — research assumption A4)
 *
 * `legal_status` was dropped from the entities table (0% populated in
 * production). Preserved as `null` in the export shape for snapshot
 * continuity.
 */
export function formatEntity(row: {
  entityCode: string | null;
  displayName: string;
  sortName: string;
  givenName: string | null;
  surname: string | null;
  entityType: string;
  honorific: string | null;
  primaryFunction: string | null;
  primaryFunctionCanonical?: string | null;
  nameVariants: string | null;
  datesOfExistence: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  history: string | null;
  functions: string | null;
  sources: string | null;
  wikidataId: string | null;
  viafId: string | null;
}): ExportEntity {
  return {
    entity_code: row.entityCode,
    display_name: row.displayName,
    sort_name: row.sortName,
    given_name: row.givenName,
    particle: null,
    surname: row.surname,
    entity_type: row.entityType,
    honorific: row.honorific,
    primary_function: row.primaryFunctionCanonical ?? row.primaryFunction,
    name_variants: JSON.parse(row.nameVariants ?? "[]"),
    dates_of_existence: row.datesOfExistence,
    date_earliest: row.dateStart,
    date_latest: row.dateEnd,
    date_start: row.dateStart,
    date_end: row.dateEnd,
    history: row.history,
    // Dropped in 0036 (0% populated); preserved as null in export shape.
    legal_status: null,
    functions: row.functions,
    sources: row.sources,
    wikidata_id: row.wikidataId,
    viaf_id: row.viafId,
  };
}

/**
 * Filter entities to only those linked to at least one published description.
 * The caller computes linkedEntityIds from descriptionEntities where
 * the description has isPublished=true.
 */
export function filterLinkedEntities<T extends { id: string }>(
  entities: T[],
  linkedEntityIds: Set<string>
): T[] {
  return entities.filter((e) => linkedEntityIds.has(e.id));
}
