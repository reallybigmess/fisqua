/**
 * Tests — entities
 *
 * This helper module wraps entity-row creation for the test suite.
 * Every entity row carries a federation_id NOT NULL FK to federations(id)
 * (migrations 0045-0048 lifted entities to federation scope), so tests must
 * call seedTenants() + seedFederations() before invoking this helper.
 * Defaults to DEFAULT_TEST_FEDERATION_ID.
 *
 * @version v0.4.3
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_FEDERATION_ID } from "./db";

export async function createTestEntity(overrides: Partial<{
  id: string;
  federationId: string;
  entityCode: string;
  displayName: string;
  sortName: string;
  surname: string;
  givenName: string;
  entityType: string;
  honorific: string;
  primaryFunction: string;
  nameVariants: string;
  datesOfExistence: string;
  dateStart: string;
  dateEnd: string;
  mergedInto: string;
  wikidataId: string;
  viafId: string;
  dbeId: string;
}> = {}) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  const values = {
    id,
    federationId: overrides.federationId ?? DEFAULT_TEST_FEDERATION_ID,
    entityCode: overrides.entityCode ?? "ne-test01",
    displayName: overrides.displayName ?? "Test Entity",
    sortName: overrides.sortName ?? "Entity, Test",
    surname: overrides.surname ?? undefined,
    givenName: overrides.givenName ?? undefined,
    entityType: (overrides.entityType ?? "person") as
      (typeof schema.entities.$inferInsert)["entityType"],
    honorific: overrides.honorific ?? undefined,
    primaryFunction: overrides.primaryFunction ?? undefined,
    nameVariants: overrides.nameVariants ?? "[]",
    datesOfExistence: overrides.datesOfExistence ?? undefined,
    dateStart: overrides.dateStart ?? undefined,
    dateEnd: overrides.dateEnd ?? undefined,
    mergedInto: overrides.mergedInto ?? undefined,
    wikidataId: overrides.wikidataId ?? undefined,
    viafId: overrides.viafId ?? undefined,
    dbeId: overrides.dbeId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.entities).values(values);
  return values;
}
