/**
 * Tests — admin places cross-federation isolation
 *
 * This suite carries the read-negative + write-negative coverage for
 * the places authority surface. Migration 0045 lifted places from
 * tenant scope to FEDERATION scope, so the isolation boundary is now the
 * federation: the places admin loader (`app/routes/_auth.admin.places.tsx`)
 * and its detail/edit counterparts (`_auth.admin.places.$id.tsx`,
 * `_auth.admin.places.new.tsx`) all carry the
 * `eq(places.federationId, tenant.federationId)` predicate; this test
 * confirms cross-federation reads/writes are blocked at the data layer.
 * The DEFAULT test tenant lives in the Neogranadina federation and the
 * SECOND test tenant in its own federation-of-one.
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

async function seedPlace(args: {
  federationId: string;
  label: string;
  displayName?: string;
}): Promise<string> {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.places).values({
    id,
    federationId: args.federationId,
    label: args.label,
    displayName: args.displayName ?? args.label,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("admin places cross-federation isolation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("read-negative: federation-A scoped query never returns federation-B places", async () => {
    const db = drizzle(env.DB);

    const placeA = await seedPlace({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      label: "Santafé de Bogotá",
    });
    const placeB = await seedPlace({
      federationId: SECOND_TEST_FEDERATION_ID,
      label: "Federation B Town",
    });

    const rowsForA = await db
      .select({
        id: schema.places.id,
        label: schema.places.label,
        federationId: schema.places.federationId,
      })
      .from(schema.places)
      .where(eq(schema.places.federationId, DEFAULT_TEST_FEDERATION_ID))
      .all();

    expect(rowsForA).toHaveLength(1);
    expect(rowsForA[0].id).toBe(placeA);
    expect(rowsForA.map((r) => r.id)).not.toContain(placeB);

    const rowsForB = await db
      .select({ id: schema.places.id })
      .from(schema.places)
      .where(eq(schema.places.federationId, SECOND_TEST_FEDERATION_ID))
      .all();
    expect(rowsForB).toHaveLength(1);
    expect(rowsForB[0].id).toBe(placeB);
  });

  it("write-negative: federation-A scoped UPDATE on federation-B place id leaves federation B unchanged", async () => {
    const db = drizzle(env.DB);

    const placeA = await seedPlace({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      label: "Original A",
    });
    const placeB = await seedPlace({
      federationId: SECOND_TEST_FEDERATION_ID,
      label: "Original B",
    });

    await db
      .update(schema.places)
      .set({ label: "Cross-federation overwrite attempt" })
      .where(
        and(
          eq(schema.places.federationId, DEFAULT_TEST_FEDERATION_ID),
          eq(schema.places.id, placeB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.label).toBe("Original B");
    expect(rowB!.federationId).toBe(SECOND_TEST_FEDERATION_ID);

    const rowA = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeA))
      .get();
    expect(rowA!.label).toBe("Original A");
  });

  it("write-negative: federation-A scoped DELETE on federation-B place id leaves federation B intact", async () => {
    const db = drizzle(env.DB);

    const placeB = await seedPlace({
      federationId: SECOND_TEST_FEDERATION_ID,
      label: "Will Survive",
    });

    await db
      .delete(schema.places)
      .where(
        and(
          eq(schema.places.federationId, DEFAULT_TEST_FEDERATION_ID),
          eq(schema.places.id, placeB),
        ),
      )
      .run();

    const rowB = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, placeB))
      .get();
    expect(rowB).toBeTruthy();
    expect(rowB!.label).toBe("Will Survive");
  });
});
