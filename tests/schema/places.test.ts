/**
 * Tests — places schema
 *
 * This suite pins the structural shape of the `places` table — the
 * geographic authority spine for locations referenced across descriptions.
 * Five pins cover the column shape: required fields on insert, the
 * unique constraint on `placeCode` (the stable external identifier
 * mirroring `entities.entityCode`), floating-point storage for the
 * `latitude`/`longitude` pair, the nullable `mergedInto` column for
 * deduplication redirects, and the `coordinatePrecision` column.
 *
 * Coordinate status is DERIVED, not stored: migration 0060 dropped
 * `needs_geocoding` and made `coordinate_precision` a controlled
 * vocabulary (exact/approximate/centroid/uncertain, NULL = not
 * recorded). A located place carrying `uncertain` is the "to review"
 * state; a place with no coordinates is "missing". The column accepts
 * any of the vocabulary values and NULL — the enum is enforced at the
 * Zod boundary, not by a DB CHECK, since legacy rows may still hold
 * out-of-vocabulary values.
 *
 * @version v0.4.3
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_FEDERATION_ID, applyMigrations, cleanDatabase } from "../helpers/db";

describe("places table", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("can insert a place with required fields", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id,
      placeCode: "nl-abc234",
      label: "Tunja",
      displayName: "Tunja, Boyaca, Colombia",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, id));

    expect(row).toBeDefined();
    expect(row.placeCode).toBe("nl-abc234");
    expect(row.label).toBe("Tunja");
    expect(row.displayName).toBe("Tunja, Boyaca, Colombia");
  });

  it("placeCode has unique constraint", async () => {
    const now = Date.now();

    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: crypto.randomUUID(),
      placeCode: "nl-xxxxxx",
      label: "Place A",
      displayName: "Place A Display",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.places).values({
        federationId: DEFAULT_TEST_FEDERATION_ID,
        id: crypto.randomUUID(),
        placeCode: "nl-xxxxxx",
        label: "Place B",
        displayName: "Place B Display",
        createdAt: now,
        updatedAt: now,
      })
    ).rejects.toThrow();
  });

  it("latitude and longitude accept real (floating-point) values", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id,
      placeCode: "nl-coords",
      label: "Tunja",
      displayName: "Tunja, Boyaca",
      latitude: 5.5353,
      longitude: -73.3678,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, id));

    expect(row.latitude).toBeCloseTo(5.5353);
    expect(row.longitude).toBeCloseTo(-73.3678);
  });

  it("mergedInto column exists", async () => {
    const mainId = crypto.randomUUID();
    const mergedId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: mainId,
      placeCode: "nl-main01",
      label: "Main Place",
      displayName: "Main Place Display",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: mergedId,
      placeCode: "nl-mrgd01",
      label: "Merged Place",
      displayName: "Merged Place Display",
      mergedInto: mainId,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, mergedId));

    expect(row.mergedInto).toBe(mainId);
  });

  it("coordinatePrecision stores a vocabulary value and defaults to null", async () => {
    const now = Date.now();

    // No precision supplied → NULL (not recorded).
    const unrecordedId = crypto.randomUUID();
    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: unrecordedId,
      placeCode: "nl-geoco",
      label: "Unrecorded Place",
      displayName: "Unrecorded Place Display",
      createdAt: now,
      updatedAt: now,
    });
    const [unrecorded] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, unrecordedId));
    expect(unrecorded.coordinatePrecision).toBeNull();

    // A located, uncertain place — the derived "to review" state.
    const uncertainId = crypto.randomUUID();
    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: uncertainId,
      placeCode: "nl-uncrt",
      label: "Uncertain Place",
      displayName: "Uncertain Place Display",
      latitude: 5.53,
      longitude: -73.36,
      coordinatePrecision: "uncertain",
      createdAt: now,
      updatedAt: now,
    });
    const [uncertain] = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, uncertainId));
    expect(uncertain.coordinatePrecision).toBe("uncertain");
    expect(uncertain.latitude).toBeCloseTo(5.53);
  });
});
