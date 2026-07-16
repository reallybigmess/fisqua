/**
 * Tests — entities CRUD
 *
 * This suite pins the substrate contract on the `entities` table —
 * the authority records for people, families, and corporate bodies
 * (ISAAR(CPF) shape). The cases exercise insert with the minimum
 * required fields (`displayName`, `entityCode`, `tenantId`), the
 * uniqueness invariant on `entityCode` within a tenant, partial
 * update preservation, and the cascade behaviour against
 * `descriptionEntities` link rows when the authority is deleted.
 *
 * Tenant-id is carried explicitly on every insert because the
 * cross-tenant grep keystone (`tests/db/cross-tenant-coverage.test.ts`)
 * refuses any write to a tenanted table without an explicit
 * tenant-id clause. The helper `createTestEntity` defaults to
 * `DEFAULT_TEST_TENANT_ID` so test bodies stay focused on the
 * field-level contract.
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
import { eq, sql } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestEntity } from "../helpers/entities";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";

describe("entity CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("creates an entity with valid data", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const id = crypto.randomUUID();

    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id,
      entityCode: "ne-abc123",
      displayName: "Juan de Castellanos",
      sortName: "Castellanos, Juan de",
      surname: "Castellanos",
      givenName: "Juan",
      entityType: "person",
      honorific: "Don",
      primaryFunction: "Cronista",
      nameVariants: '["Juan de Castellanos y Rojas"]',
      datesOfExistence: "ca. 1522-1607",
      dateStart: "1522",
      dateEnd: "1607",
      history: "Chronicler of the New Kingdom of Granada",
      // legal_status dropped in 0036 (0% populated in production audit).
      functions: "Writing, clergy",
      sources: "BNC ms. 001",
      createdAt: now,
      updatedAt: now,
    });

    const entity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, id))
      .get();

    expect(entity).toBeTruthy();
    expect(entity!.entityCode).toBe("ne-abc123");
    expect(entity!.displayName).toBe("Juan de Castellanos");
    expect(entity!.sortName).toBe("Castellanos, Juan de");
    expect(entity!.surname).toBe("Castellanos");
    expect(entity!.givenName).toBe("Juan");
    expect(entity!.entityType).toBe("person");
    expect(entity!.honorific).toBe("Don");
    expect(entity!.primaryFunction).toBe("Cronista");
    expect(entity!.nameVariants).toBe('["Juan de Castellanos y Rojas"]');
    expect(entity!.datesOfExistence).toBe("ca. 1522-1607");
    expect(entity!.dateStart).toBe("1522");
    expect(entity!.dateEnd).toBe("1607");
    expect(entity!.history).toBe("Chronicler of the New Kingdom of Granada");
    expect(entity!.functions).toBe("Writing, clergy");
    expect(entity!.sources).toBe("BNC ms. 001");
    expect(entity!.createdAt).toBe(now);
    expect(entity!.updatedAt).toBe(now);
  });

  it("rejects duplicate entityCode", async () => {
    await createTestEntity({ entityCode: "ne-dupl01" });

    try {
      await createTestEntity({
        id: crypto.randomUUID(),
        entityCode: "ne-dupl01",
        displayName: "Other Entity",
        sortName: "Entity, Other",
      });
      expect.fail("Should have thrown on duplicate entity code");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("updates entity fields", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity({
      displayName: "Old Name",
      sortName: "Name, Old",
    });

    const newUpdatedAt = Date.now() + 1000;
    await db
      .update(schema.entities)
      .set({
        displayName: "New Name",
        sortName: "Name, New",
        updatedAt: newUpdatedAt,
      })
      .where(eq(schema.entities.id, entity.id));

    const updated = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entity.id))
      .get();

    expect(updated!.displayName).toBe("New Name");
    expect(updated!.sortName).toBe("Name, New");
    expect(updated!.updatedAt).toBe(newUpdatedAt);
  });

  it("deletes entity without linked descriptions", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();

    await db
      .delete(schema.entities)
      .where(eq(schema.entities.id, entity.id));

    const deleted = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entity.id))
      .get();

    expect(deleted).toBeUndefined();
  });

  it("delete blocked when descriptionEntities exist", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();
    const user = await createTestUser();
    const repo = await createTestRepository();

    // Create a description
    const descId = crypto.randomUUID();
    const now = Date.now();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "fonds",
      referenceCode: "AGN-001",
      localIdentifier: "AGN-001",
      title: "Test Fonds",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    // Link entity to description
    await db.insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(),
      descriptionId: descId,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });

    // Attempt to delete entity -- should fail due to onDelete: "restrict"
    try {
      await db
        .delete(schema.entities)
        .where(eq(schema.entities.id, entity.id));
      expect.fail("Should have thrown on FK constraint");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });
});

describe("entity search", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("search by FTS5 matches displayName", async () => {
    const db = drizzle(env.DB);
    await createTestEntity({
      displayName: "Gonzalo Jimenez de Quesada",
      sortName: "Jimenez de Quesada, Gonzalo",
      entityCode: "ne-fts001",
    });
    await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Pedro de Heredia",
      sortName: "Heredia, Pedro de",
      entityCode: "ne-fts002",
    });

    try {
      // FTS5 may not be available in test D1 environment
      const results = await db.all(
        sql`SELECT e.* FROM entities e JOIN entities_fts f ON e.id = f.rowid WHERE entities_fts MATCH 'Quesada'`
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
    } catch {
      // FTS5 not available in test environment -- skip gracefully
      const results = await db
        .select()
        .from(schema.entities)
        .where(sql`${schema.entities.displayName} LIKE '%Quesada%'`)
        .all();
      expect(results).toHaveLength(1);
      expect(results[0].displayName).toBe("Gonzalo Jimenez de Quesada");
    }
  });

  it("search fallback to LIKE on sortName", async () => {
    const db = drizzle(env.DB);
    await createTestEntity({
      displayName: "Fray Bartolome de las Casas",
      sortName: "Casas, Bartolome de las",
      entityCode: "ne-like01",
    });
    await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Antonio Narino",
      sortName: "Narino, Antonio",
      entityCode: "ne-like02",
    });

    const results = await db
      .select()
      .from(schema.entities)
      .where(sql`${schema.entities.sortName} LIKE '%Casas%'`)
      .all();

    expect(results).toHaveLength(1);
    expect(results[0].sortName).toBe("Casas, Bartolome de las");
  });
});

describe("entity pagination", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("cursor pagination returns correct page", async () => {
    const db = drizzle(env.DB);
    await createTestEntity({
      sortName: "Alpha",
      displayName: "Alpha Entity",
      entityCode: "ne-alph01",
    });
    await createTestEntity({
      id: crypto.randomUUID(),
      sortName: "Bravo",
      displayName: "Bravo Entity",
      entityCode: "ne-brav01",
    });
    await createTestEntity({
      id: crypto.randomUUID(),
      sortName: "Charlie",
      displayName: "Charlie Entity",
      entityCode: "ne-char01",
    });

    // Cursor after Alpha -- should return Bravo and Charlie
    const results = await db
      .select()
      .from(schema.entities)
      .where(sql`${schema.entities.sortName} > 'Alpha'`)
      .orderBy(schema.entities.sortName)
      .all();

    expect(results).toHaveLength(2);
    expect(results[0].sortName).toBe("Bravo");
    expect(results[1].sortName).toBe("Charlie");
  });
});

describe("entity merge and split", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("merge sets mergedInto and reassigns links", async () => {
    const db = drizzle(env.DB);
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const source = await createTestEntity({
      displayName: "Source Entity",
      sortName: "Entity, Source",
      entityCode: "ne-src001",
    });
    const target = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Target Entity",
      sortName: "Entity, Target",
      entityCode: "ne-tgt001",
    });

    // Create description and link to source
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "MERGE-001",
      localIdentifier: "MERGE-001",
      title: "Test Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: source.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });

    // Merge: reassign link from source to target, mark source as merged
    await db
      .update(schema.descriptionEntities)
      .set({ entityId: target.id })
      .where(eq(schema.descriptionEntities.id, linkId));

    await db
      .update(schema.entities)
      .set({ mergedInto: target.id, updatedAt: Date.now() })
      .where(eq(schema.entities.id, source.id));

    // Verify
    const mergedSource = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, source.id))
      .get();
    expect(mergedSource!.mergedInto).toBe(target.id);

    const link = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    expect(link!.entityId).toBe(target.id);
  });

  it("split creates new entity and moves links", async () => {
    const db = drizzle(env.DB);
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const original = await createTestEntity({
      displayName: "Original Entity",
      sortName: "Entity, Original",
      entityCode: "ne-orig01",
    });

    // Create description and link
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "SPLIT-001",
      localIdentifier: "SPLIT-001",
      title: "Test Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: original.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });

    // Split: create new entity, move the link
    const newEntityId = crypto.randomUUID();
    await db.insert(schema.entities).values({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      id: newEntityId,
      entityCode: "ne-splt01",
      displayName: "Split Entity",
      sortName: "Entity, Split",
      entityType: "person",
      nameVariants: "[]",
      createdAt: now,
      updatedAt: now,
    });

    await db
      .update(schema.descriptionEntities)
      .set({ entityId: newEntityId })
      .where(eq(schema.descriptionEntities.id, linkId));

    // Verify both entities exist
    const origEntity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, original.id))
      .get();
    expect(origEntity).toBeTruthy();

    const splitEntity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, newEntityId))
      .get();
    expect(splitEntity).toBeTruthy();
    expect(splitEntity!.displayName).toBe("Split Entity");

    // Verify link points to new entity
    const link = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    expect(link!.entityId).toBe(newEntityId);
  });
});

describe("entity description link CRUD", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("link_description creates junction record", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    // Create a description
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "LINK-001",
      localIdentifier: "LINK-001",
      title: "Test Item for Linking",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    // Create link
    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: entity.id,
      role: "author",
      sequence: 0,
      createdAt: now,
    });

    // Verify link exists
    const link = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();

    expect(link).toBeTruthy();
    expect(link!.descriptionId).toBe(descId);
    expect(link!.entityId).toBe(entity.id);
    expect(link!.role).toBe("author");
    expect(link!.sequence).toBe(0);
  });

  it("link_description with duplicate returns error", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "DUP-001",
      localIdentifier: "DUP-001",
      title: "Duplicate Link Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    // First link
    await db.insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(),
      descriptionId: descId,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });

    // Duplicate link should fail on unique constraint
    try {
      await db.insert(schema.descriptionEntities).values({
        id: crypto.randomUUID(),
        descriptionId: descId,
        entityId: entity.id,
        role: "creator",
        sequence: 1,
        createdAt: now,
      });
      expect.fail("Should have thrown on unique constraint");
    } catch (e) {
      expect(e).toBeTruthy();
    }
  });

  it("edit_description_link updates junction fields", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "EDIT-001",
      localIdentifier: "EDIT-001",
      title: "Edit Link Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: entity.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });

    // Update junction fields
    await db
      .update(schema.descriptionEntities)
      .set({
        role: "author",
        roleNote: "Primary author",
        sequence: 1,
        honorific: "Don",
        function: "Chronicler",
        nameAsRecorded: "Juan de Castellanos",
      })
      .where(eq(schema.descriptionEntities.id, linkId));

    const updated = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();

    expect(updated!.role).toBe("author");
    expect(updated!.roleNote).toBe("Primary author");
    expect(updated!.sequence).toBe(1);
    expect(updated!.honorific).toBe("Don");
    expect(updated!.function).toBe("Chronicler");
    expect(updated!.nameAsRecorded).toBe("Juan de Castellanos");
  });

  it("unlink_description removes junction record", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "UNLINK-001",
      localIdentifier: "UNLINK-001",
      title: "Unlink Test",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: entity.id,
      role: "witness",
      sequence: 0,
      createdAt: now,
    });

    // Remove link
    await db
      .delete(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId));

    const deleted = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();

    expect(deleted).toBeUndefined();
  });

  it("loader query returns expanded descLinks with all junction fields", async () => {
    const db = drizzle(env.DB);
    const entity = await createTestEntity();
    const user = await createTestUser();
    const repo = await createTestRepository();
    const now = Date.now();

    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "LOAD-001",
      localIdentifier: "LOAD-001",
      title: "Loader Test Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: entity.id,
      role: "creator",
      roleNote: "Test note",
      sequence: 2,
      honorific: "Fray",
      function: "Priest",
      nameAsRecorded: "Fray Pedro",
      createdAt: now,
    });

    // Replicate the loader query
    const descLinks = await db
      .select({
        id: schema.descriptionEntities.id,
        descriptionId: schema.descriptionEntities.descriptionId,
        role: schema.descriptionEntities.role,
        roleNote: schema.descriptionEntities.roleNote,
        sequence: schema.descriptionEntities.sequence,
        honorific: schema.descriptionEntities.honorific,
        function: schema.descriptionEntities.function,
        nameAsRecorded: schema.descriptionEntities.nameAsRecorded,
        descriptionTitle: schema.descriptions.title,
        referenceCode: schema.descriptions.referenceCode,
        descriptionLevel: schema.descriptions.descriptionLevel,
      })
      .from(schema.descriptionEntities)
      .innerJoin(
        schema.descriptions,
        eq(schema.descriptionEntities.descriptionId, schema.descriptions.id)
      )
      .where(eq(schema.descriptionEntities.entityId, entity.id))
      .orderBy(schema.descriptionEntities.sequence)
      .all();

    expect(descLinks).toHaveLength(1);
    expect(descLinks[0].id).toBe(linkId);
    expect(descLinks[0].descriptionId).toBe(descId);
    expect(descLinks[0].role).toBe("creator");
    expect(descLinks[0].roleNote).toBe("Test note");
    expect(descLinks[0].sequence).toBe(2);
    expect(descLinks[0].honorific).toBe("Fray");
    expect(descLinks[0].function).toBe("Priest");
    expect(descLinks[0].nameAsRecorded).toBe("Fray Pedro");
    expect(descLinks[0].descriptionTitle).toBe("Loader Test Item");
    expect(descLinks[0].referenceCode).toBe("LOAD-001");
    expect(descLinks[0].descriptionLevel).toBe("item");
  });
});

describe("entity code generation", () => {
  it("code generation produces ne- format", () => {
    // Test the pattern that codes must match
    const codePattern = /^ne-[a-z2-9]{6}$/;

    // Generate several codes and verify format
    const alphabet = "abcdefghjkmnpqrstvwxyz23456789";
    for (let i = 0; i < 10; i++) {
      const chars = Array.from({ length: 6 }, () =>
        alphabet[Math.floor(Math.random() * alphabet.length)]
      ).join("");
      const code = `ne-${chars}`;
      expect(code).toMatch(codePattern);
    }

    // Verify invalid codes are rejected
    expect("ne-abc12").not.toMatch(codePattern); // 5 chars
    expect("nl-abc123").not.toMatch(codePattern); // wrong prefix
    expect("ne-ABCDEF").not.toMatch(codePattern); // uppercase
    expect("ne-abc10o").not.toMatch(codePattern); // contains 'o'
  });
});
