/**
 * Tests — entities schema
 *
 * This suite pins the structural shape of the `entities` table — the
 * authority spine for persons, families, and corporate bodies referenced
 * across descriptions. Four columns carry load-bearing invariants and
 * each gets its own pin: required fields on insert (`entityCode`,
 * `displayName`, `sortName`, `entityType`), the unique constraint on
 * `entityCode` that the public URL space depends on, the nullable
 * `mergedInto` column that authority-deduplication uses to redirect
 * stale references, and the `nameVariants` JSON column that defaults
 * to `'[]'` so consumers can `JSON.parse` blindly without nullguards.
 *
 * The `entityCode` uniqueness test mirrors the same posture as the
 * `descriptions.referenceCode` test — every entity code becomes a
 * stable external identifier in the entity browser, so collisions
 * would silently overwrite authority work.
 *
 * @version v0.4.2
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

describe("entities table", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("can insert an entity with required fields", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id,
      entityCode: "ne-abc234",
      displayName: "Juan de Castellanos",
      sortName: "Castellanos, Juan de",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id));

    expect(row).toBeDefined();
    expect(row.entityCode).toBe("ne-abc234");
    expect(row.displayName).toBe("Juan de Castellanos");
    expect(row.sortName).toBe("Castellanos, Juan de");
    expect(row.entityType).toBe("person");
  });

  it("entityCode has unique constraint", async () => {
    const now = Date.now();

    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: crypto.randomUUID(),
      entityCode: "ne-xxxxxx",
      displayName: "First Entity",
      sortName: "Entity, First",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      db.insert(schema.entities).values({
        federationId: DEFAULT_TEST_FEDERATION_ID,
        id: crypto.randomUUID(),
        entityCode: "ne-xxxxxx",
        displayName: "Second Entity",
        sortName: "Entity, Second",
        entityType: "person",
        createdAt: now,
        updatedAt: now,
      })
    ).rejects.toThrow();
  });

  it("mergedInto column exists and accepts a UUID", async () => {
    const mainId = crypto.randomUUID();
    const mergedId = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: mainId,
      entityCode: "ne-main01",
      displayName: "Main Entity",
      sortName: "Entity, Main",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: mergedId,
      entityCode: "ne-mrgd01",
      displayName: "Merged Entity",
      sortName: "Entity, Merged",
      entityType: "person",
      mergedInto: mainId,
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, mergedId));

    expect(row.mergedInto).toBe(mainId);
  });

  it("nameVariants defaults to '[]'", async () => {
    const id = crypto.randomUUID();
    const now = Date.now();

    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id,
      entityCode: "ne-defvar",
      displayName: "Default Variants",
      sortName: "Variants, Default",
      entityType: "corporate",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id));

    expect(row.nameVariants).toBe("[]");
  });
});
