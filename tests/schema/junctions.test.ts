/**
 * Tests — junction-table schemas
 *
 * This suite pins the structural shape of the three junction tables that
 * thread the description spine to authority records: `descriptionEntities`
 * (description ↔ entity, with role), `descriptionPlaces` (description ↔
 * place, with role), and `entityFunctions` (entity ↔ function term, with
 * certainty). Each junction gets a basic insert test plus a constraint
 * test on the composite key that prevents duplicate role assignments.
 *
 * The composite-uniqueness pins matter because cataloguers can legitimately
 * link the same entity to the same description twice under different roles
 * (author + subject, for instance), but linking under the same role twice
 * is data corruption — the unique index is the structural guard. The
 * `entityFunctions.certainty` default of `'probable'` is also pinned here
 * because authority work rarely produces certain attributions, and the
 * default has to match the field's epistemic stance.
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
import { DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, applyMigrations, cleanDatabase } from "../helpers/db";

describe("junction tables", () => {
  let db: ReturnType<typeof drizzle>;
  let repositoryId: string;
  let descriptionId: string;
  let entityId: string;
  let placeId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    const now = Date.now();

    // Create prerequisite records
    repositoryId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: repositoryId,
      code: "test-repo",
      name: "Test Repository",
      createdAt: now,
      updatedAt: now,
    });

    descriptionId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descriptionId,
      repositoryId,
      descriptionLevel: "item",
      referenceCode: "CO-TEST-J01",
      localIdentifier: "J01",
      title: "Test Item",
      createdAt: now,
      updatedAt: now,
    });

    entityId = crypto.randomUUID();
    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: entityId,
      entityCode: "ne-jnct01",
      displayName: "Test Entity",
      sortName: "Entity, Test",
      entityType: "person",
      createdAt: now,
      updatedAt: now,
    });

    placeId = crypto.randomUUID();
    await db.insert(schema.places).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: placeId,
      placeCode: "nl-jnct01",
      label: "Test Place",
      displayName: "Test Place Display",
      createdAt: now,
      updatedAt: now,
    });
  });

  describe("descriptionEntities", () => {
    it("can insert a descriptionEntity with required fields", async () => {
      const id = crypto.randomUUID();
      const now = Date.now();

      await db.insert(schema.descriptionEntities).values({
        id,
        descriptionId,
        entityId,
        role: "author",
        createdAt: now,
      });

      const [row] = await db
        .select()
        .from(schema.descriptionEntities)
        .where(eq(schema.descriptionEntities.id, id));

      expect(row).toBeDefined();
      expect(row.descriptionId).toBe(descriptionId);
      expect(row.entityId).toBe(entityId);
      expect(row.role).toBe("author");
    });

    it("role accepts values from ENTITY_ROLES enum", async () => {
      const roles = ["author", "recipient", "scribe", "notary", "witness"];
      const now = Date.now();

      for (const role of roles) {
        await db.insert(schema.descriptionEntities).values({
          id: crypto.randomUUID(),
          descriptionId,
          entityId,
          role: role as (typeof schema.descriptionEntities.$inferInsert)["role"],
          createdAt: now,
        });
      }

      const rows = await db
        .select()
        .from(schema.descriptionEntities)
        .where(eq(schema.descriptionEntities.descriptionId, descriptionId));

      expect(rows.length).toBe(roles.length);
    });

    it("unique constraint on (descriptionId, entityId, role)", async () => {
      const now = Date.now();

      await db.insert(schema.descriptionEntities).values({
        id: crypto.randomUUID(),
        descriptionId,
        entityId,
        role: "author",
        createdAt: now,
      });

      await expect(
        db.insert(schema.descriptionEntities).values({
          id: crypto.randomUUID(),
          descriptionId,
          entityId,
          role: "author",
          createdAt: now,
        })
      ).rejects.toThrow();
    });
  });

  describe("descriptionPlaces", () => {
    it("can insert a descriptionPlace with required fields", async () => {
      const id = crypto.randomUUID();
      const now = Date.now();

      await db.insert(schema.descriptionPlaces).values({
        id,
        descriptionId,
        placeId,
        role: "origin" as (typeof schema.descriptionPlaces.$inferInsert)["role"],
        createdAt: now,
      });

      const [row] = await db
        .select()
        .from(schema.descriptionPlaces)
        .where(eq(schema.descriptionPlaces.id, id));

      expect(row).toBeDefined();
      expect(row.descriptionId).toBe(descriptionId);
      expect(row.placeId).toBe(placeId);
      expect(row.role).toBe("origin");
    });

    it("unique constraint on (descriptionId, placeId, role)", async () => {
      const now = Date.now();

      await db.insert(schema.descriptionPlaces).values({
        id: crypto.randomUUID(),
        descriptionId,
        placeId,
        role: "origin" as (typeof schema.descriptionPlaces.$inferInsert)["role"],
        createdAt: now,
      });

      await expect(
        db.insert(schema.descriptionPlaces).values({
          id: crypto.randomUUID(),
          descriptionId,
          placeId,
          role: "origin" as (typeof schema.descriptionPlaces.$inferInsert)["role"],
          createdAt: now,
        })
      ).rejects.toThrow();
    });
  });

  describe("entityFunctions", () => {
    it("can insert an entityFunction with required fields", async () => {
      const id = crypto.randomUUID();
      const now = Date.now();

      await db.insert(schema.entityFunctions).values({
        id,
        entityId,
        function: "Notario publico",
        createdAt: now,
        updatedAt: now,
      });

      const [row] = await db
        .select()
        .from(schema.entityFunctions)
        .where(eq(schema.entityFunctions.id, id));

      expect(row).toBeDefined();
      expect(row.entityId).toBe(entityId);
      expect(row.function).toBe("Notario publico");
    });

    it("certainty defaults to 'probable'", async () => {
      const id = crypto.randomUUID();
      const now = Date.now();

      await db.insert(schema.entityFunctions).values({
        id,
        entityId,
        function: "Escribano",
        createdAt: now,
        updatedAt: now,
      });

      const [row] = await db
        .select()
        .from(schema.entityFunctions)
        .where(eq(schema.entityFunctions.id, id));

      expect(row.certainty).toBe("probable");
    });
  });
});
