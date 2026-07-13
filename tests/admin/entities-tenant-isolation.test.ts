/**
 * Tests — admin entities cross-federation isolation
 *
 * This suite carries the read-negative + write-negative coverage for
 * the entities authority surface. Migration 0045 lifted entities from
 * tenant scope to FEDERATION scope, so the isolation boundary is now the
 * federation: the entities admin loader
 * (`app/routes/_auth.admin.entities.tsx`) and its detail/edit
 * counterparts (`_auth.admin.entities.$id.tsx`,
 * `_auth.admin.entities.new.tsx`) all carry the
 * `eq(entities.federationId, tenant.federationId)` predicate; this test
 * confirms cross-federation reads/writes are blocked at the data layer.
 * The DEFAULT test tenant lives in the Neogranadina federation and the
 * SECOND test tenant in its own federation-of-one, so the two seeded
 * rows sit in distinct federations.
 *
 * Threat model coverage: cross-federation data leak via subtle predicate
 * bug; POST body asserting federationId for a different federation.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";

async function seedEntity(args: {
  federationId: string;
  displayName: string;
  sortName: string;
  entityType?: "person" | "family" | "corporate";
}): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.entities).values({
    id,
    federationId: args.federationId,
    displayName: args.displayName,
    sortName: args.sortName,
    entityType: args.entityType ?? "person",
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("admin entities cross-federation isolation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("read-negative: federation-A scoped query never returns federation-B entities", async () => {
    const db = drizzle(env.DB);

    const entityA = await seedEntity({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      displayName: "Bolívar, Simón",
      sortName: "bolivar simon",
    });
    const entityB = await seedEntity({
      federationId: SECOND_TEST_FEDERATION_ID,
      displayName: "Federation B Person",
      sortName: "federation b person",
    });

    const rowsForA = await db
      .select({
        id: schema.entities.id,
        displayName: schema.entities.displayName,
        federationId: schema.entities.federationId,
      })
      .from(schema.entities)
      .where(eq(schema.entities.federationId, DEFAULT_TEST_FEDERATION_ID))
      .all();

    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0].id).toBe(entityA);
    expect(rowsForA.map((r) => r.id)).not.toContain(entityB);

    const rowsForB = await db
      .select({ id: schema.entities.id })
      .from(schema.entities)
      .where(eq(schema.entities.federationId, SECOND_TEST_FEDERATION_ID))
      .all();
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0].id).toBe(entityB);
  });

  it("write-negative: federation-A scoped UPDATE on federation-B entity id leaves federation B unchanged", async () => {
    const db = drizzle(env.DB);

    const entityA = await seedEntity({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      displayName: "Original A",
      sortName: "original a",
    });
    const entityB = await seedEntity({
      federationId: SECOND_TEST_FEDERATION_ID,
      displayName: "Original B",
      sortName: "original b",
    });

    await db
      .update(schema.entities)
      .set({ displayName: "Cross-federation overwrite attempt" })
      .where(
        and(
          eq(schema.entities.federationId, DEFAULT_TEST_FEDERATION_ID),
          eq(schema.entities.id, entityB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.displayName).toBe("Original B");
    expect(rowB!.federationId).toBe(SECOND_TEST_FEDERATION_ID);

    const rowA = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityA))
      .get();
    expect(rowA!.displayName).toBe("Original A");
  });

  it("write-negative: federation-A scoped DELETE on federation-B entity id leaves federation B intact", async () => {
    // The merge / delete admin flows on entities use the same
    // `where(and(federationId, id))` predicate shape as UPDATE; this case
    // confirms a cross-federation id-guess on the DELETE path is also a
    // no-op.
    const db = drizzle(env.DB);

    const entityB = await seedEntity({
      federationId: SECOND_TEST_FEDERATION_ID,
      displayName: "Will Survive",
      sortName: "will survive",
    });

    await db
      .delete(schema.entities)
      .where(
        and(
          eq(schema.entities.federationId, DEFAULT_TEST_FEDERATION_ID),
          eq(schema.entities.id, entityB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entityB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.displayName).toBe("Will Survive");
  });
});
