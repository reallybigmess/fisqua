/**
 * Tests — union schema
 *
 * This suite verifies the 9 confirmed-dead columns are dropped; the 6 new
 * columns + 3 legacyIds JSON columns are added; places.fclass CHECK
 * rejects values outside P/H/A/T/S; anticipatory bibliographic +
 * external-authority columns survive drizzle/0036; descriptions
 * carries the union of ISAD(G) + DACS + RAD with per-standard fields
 * nullable in DB. `local_identifier` is nullable so descriptions can
 * omit it; per-standard validators live in
 * `app/lib/validation/standard-aware-description.ts`.
 *
 * @version v0.4.2
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { LegacyIdsSchema } from "../../app/lib/validation/legacy-ids";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function columnExists(table: string, column: string): Promise<boolean> {
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM pragma_table_info(?) WHERE name = ?",
  )
    .bind(table, column)
    .first<{ c: number }>();
  return (result?.c ?? 0) > 0;
}

describe("union schema", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    db = drizzle(env.DB, { schema });
  });

  it("drops — historicalGobernacion, historicalPartido, historicalRegion, countryCode, adminLevel1, adminLevel2, wikidataId on places; legalStatus on entities; relatedMaterials on descriptions all gone", async () => {
    // 9 confirmed-dead columns gone from D1 per migration 0036.
    expect(await columnExists("places", "historical_gobernacion")).toBe(false);
    expect(await columnExists("places", "historical_partido")).toBe(false);
    expect(await columnExists("places", "historical_region")).toBe(false);
    expect(await columnExists("places", "country_code")).toBe(false);
    expect(await columnExists("places", "admin_level_1")).toBe(false);
    expect(await columnExists("places", "admin_level_2")).toBe(false);
    expect(await columnExists("places", "wikidata_id")).toBe(false);
    expect(await columnExists("entities", "legal_status")).toBe(false);
    expect(await columnExists("descriptions", "related_materials")).toBe(false);
  });

  it("adds — places.fclass, descriptions.publicationTitle, descriptions/places/entities.legacyIds, entities.dbeId all exist", async () => {
    // 6 new columns + 3 legacy_ids JSON columns.
    expect(await columnExists("places", "fclass")).toBe(true);
    expect(await columnExists("places", "legacy_ids")).toBe(true);
    expect(await columnExists("descriptions", "publication_title")).toBe(true);
    expect(await columnExists("descriptions", "legacy_ids")).toBe(true);
    expect(await columnExists("entities", "dbe_id")).toBe(true);
    expect(await columnExists("entities", "legacy_ids")).toBe(true);
  });

  it("fclass CHECK — INSERT into places with fclass='Z' rejects", async () => {
    const baseId = crypto.randomUUID();
    const now = Date.now();

    // Sanity: a legal value (P) inserts cleanly.
    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: baseId,
      placeCode: "nl-fclok1",
      label: "Legal fclass",
      displayName: "Legal fclass",
      placeType: "city",
      fclass: "P",
      createdAt: now,
      updatedAt: now,
    });

    // NULL fclass also inserts cleanly (CHECK guards `IS NULL OR IN (...)`).
    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: crypto.randomUUID(),
      placeCode: "nl-fclnul",
      label: "Null fclass",
      displayName: "Null fclass",
      placeType: "city",
      // fclass omitted -> defaults to NULL.
      createdAt: now,
      updatedAt: now,
    });

    // Illegal value 'Z' must be rejected by the DB CHECK.
    await expect(
      env.DB.prepare(
        "INSERT INTO places (id, tenant_id, place_code, label, display_name, place_type, fclass, name_variants, needs_geocoding, legacy_ids, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          crypto.randomUUID(),
          DEFAULT_TEST_TENANT_ID,
          "nl-fclbad",
          "Bad fclass",
          "Bad fclass",
          "city",
          "Z",
          "[]",
          1,
          "[]",
          now,
          now,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("preserved — volumeNumber, issueNumber, dimensions, medium, dateCertainty, translatedTitle, resourceType, genre, viafId, wikidataId on entities, history on entities, provenance on descriptions all survive drizzle/0036", async () => {
    const repo = await createTestRepository();
    const now = Date.now();

    // Anticipatory bibliographic + external-authority refs all preserved.
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PRES-001",
      localIdentifier: "PRES-001",
      title: "Preservation round-trip",
      // Anticipatory fields:
      volumeNumber: "12",
      issueNumber: "3",
      dimensions: "21 cm",
      medium: "manuscrito",
      dateCertainty: "approximate",
      translatedTitle: "Preservation roundtrip",
      resourceType: "text",
      genre: '["epistolario"]',
      // Aspirational external-authority ref on descriptions:
      provenance: "Donación 2020",
      createdAt: now,
      updatedAt: now,
    });

    const fetchedDesc = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();

    expect(fetchedDesc!.volumeNumber).toBe("12");
    expect(fetchedDesc!.issueNumber).toBe("3");
    expect(fetchedDesc!.dimensions).toBe("21 cm");
    expect(fetchedDesc!.medium).toBe("manuscrito");
    expect(fetchedDesc!.dateCertainty).toBe("approximate");
    expect(fetchedDesc!.translatedTitle).toBe("Preservation roundtrip");
    expect(fetchedDesc!.resourceType).toBe("text");
    expect(fetchedDesc!.genre).toBe('["epistolario"]');
    expect(fetchedDesc!.provenance).toBe("Donación 2020");

    // Entity-side aspirational refs:
    const entityId = crypto.randomUUID();
    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: entityId,
      entityCode: "ne-pres01",
      displayName: "Preserved Person",
      sortName: "Preserved Person",
      entityType: "person",
      history: "biographical history that the v0.4 schema preserves",
      viafId: "12345678",
      wikidataId: "Q123456",
      createdAt: now,
      updatedAt: now,
    });

    const fetchedEntity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .get();

    expect(fetchedEntity!.viafId).toBe("12345678");
    expect(fetchedEntity!.wikidataId).toBe("Q123456");
    expect(fetchedEntity!.history).toBe(
      "biographical history that the v0.4 schema preserves",
    );
  });

  it("union — descriptions has the union of ISAD(G)+DACS+RAD; per-standard fields nullable; universal NOT NULL set is id, tenant_id, repository_id, description_level, reference_code, title, created_at, updated_at", async () => {
    const repo = await createTestRepository();
    const now = Date.now();
    const descId = crypto.randomUUID();

    // Minimal universal-NOT-NULL insert: omit local_identifier (RELAXED in
    // drizzle/0036) and every per-standard nullable field.
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "fonds",
      referenceCode: "UNION-001",
      title: "Union-schema minimal description",
      // local_identifier omitted (RELAXED to nullable in 0036).
      createdAt: now,
      updatedAt: now,
    });

    const fetched = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();

    expect(fetched).toBeTruthy();
    expect(fetched!.localIdentifier).toBeNull();

    // DACS/RAD union additions all present and nullable in 0036:
    expect(await columnExists("descriptions", "admin_biog_history")).toBe(true);
    expect(await columnExists("descriptions", "preferred_citation")).toBe(true);
    expect(await columnExists("descriptions", "acquisition_info")).toBe(true);
    expect(await columnExists("descriptions", "system_of_arrangement")).toBe(true);
    expect(await columnExists("descriptions", "physical_characteristics")).toBe(true);

    // Universal-NOT-NULL invariants are enforced: omitting reference_code
    // must reject. We use raw SQL because Drizzle's typed insert refuses
    // to omit a NOT NULL column at compile time.
    await expect(
      env.DB.prepare(
        "INSERT INTO descriptions (id, tenant_id, repository_id, description_level, title, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          crypto.randomUUID(),
          DEFAULT_TEST_TENANT_ID,
          repo.id,
          "item",
          "no reference code",
          now,
          now,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("legacyIds round-trip — JSON shape Array<{provider, id}> writes and reads cleanly", async () => {
    const repo = await createTestRepository();
    const now = Date.now();
    const descId = crypto.randomUUID();

    const legacyIdsValue = JSON.stringify([
      { provider: "django-zasqua", id: 42 },
      { provider: "ca", id: "object-123" },
    ]);

    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "LEGACY-001",
      title: "legacyIds round-trip",
      legacyIds: legacyIdsValue,
      createdAt: now,
      updatedAt: now,
    });

    const fetched = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();

    expect(fetched!.legacyIds).toBe(legacyIdsValue);

    // Zod-validate the JSON shape against LegacyIdsSchema.
    const parsed = LegacyIdsSchema.parse(JSON.parse(fetched!.legacyIds!));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ provider: "django-zasqua", id: 42 });
    expect(parsed[1]).toEqual({ provider: "ca", id: "object-123" });

    // entities and places carry the same shape; round-trip on entities.
    const entityId = crypto.randomUUID();
    const entityLegacy = JSON.stringify([{ provider: "viaf-import-2026", id: 999 }]);
    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: entityId,
      entityCode: "ne-legac1",
      displayName: "Legacy Entity",
      sortName: "Legacy Entity",
      entityType: "person",
      legacyIds: entityLegacy,
      createdAt: now,
      updatedAt: now,
    });
    const fetchedEntity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .get();
    expect(LegacyIdsSchema.parse(JSON.parse(fetchedEntity!.legacyIds))).toEqual([
      { provider: "viaf-import-2026", id: 999 },
    ]);
  });
});
