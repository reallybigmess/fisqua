/**
 * Tests — places
 *
 * This helper module wraps place-row creation for the test suite.
 * Every place row carries a federation_id NOT NULL FK to federations(id)
 * (migrations 0045-0048 lifted places to federation scope), so tests must call
 * seedTenants() + seedFederations() before invoking this helper.
 * Defaults to DEFAULT_TEST_FEDERATION_ID.
 *
 * historical_* columns, country_code, admin_level_1, admin_level_2,
 * and wikidata_id were dropped from the places table (0% populated
 * in production audit). The new `fclass` column (5-value GeoNames
 * feature class with CHECK constraint) is exposed on the helper.
 *
 * @version v0.4.2
 */
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_FEDERATION_ID } from "./db";

export async function createTestPlace(overrides: Partial<{
  id: string;
  federationId: string;
  placeCode: string;
  label: string;
  displayName: string;
  placeType: string;
  nameVariants: string;
  parentId: string;
  fclass: "P" | "H" | "A" | "T" | "S";
  latitude: number;
  longitude: number;
  coordinatePrecision: string;
  mergedInto: string;
  tgnId: string;
  hgisId: string;
  whgId: string;
}> = {}) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  const values = {
    id,
    federationId: overrides.federationId ?? DEFAULT_TEST_FEDERATION_ID,
    placeCode: overrides.placeCode ?? "nl-test01",
    label: overrides.label ?? "Test Place",
    displayName: overrides.displayName ?? "Test Place",
    placeType: (overrides.placeType ?? "city") as
      (typeof schema.places.$inferInsert)["placeType"],
    nameVariants: overrides.nameVariants ?? "[]",
    parentId: overrides.parentId ?? undefined,
    fclass: overrides.fclass ?? undefined,
    latitude: overrides.latitude ?? undefined,
    longitude: overrides.longitude ?? undefined,
    coordinatePrecision: overrides.coordinatePrecision ?? undefined,
    mergedInto: overrides.mergedInto ?? undefined,
    tgnId: overrides.tgnId ?? undefined,
    hgisId: overrides.hgisId ?? undefined,
    whgId: overrides.whgId ?? undefined,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(schema.places).values(values);
  return values;
}
