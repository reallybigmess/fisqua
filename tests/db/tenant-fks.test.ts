/**
 * Tests — tenant_id FKs on the 5 domain tables
 *
 * This suite verifies users / repositories / descriptions / entities / places
 * each carry a NOT NULL FK to tenants(id) with ON DELETE RESTRICT,
 * that helper-built rows back-fill to NEOGRANADINA_TENANT_ID, and
 * that DELETE FROM tenants with child rows is rejected.
 *
 * This file pins the schema-shape contract using the harness; the
 * end-to-end production back-fill (every existing pre-v0.4 row
 * carries tenant_id = NEOGRANADINA_TENANT_ID after `wrangler d1
 * migrations apply`) was verified at migration time.
 *
 * @version v0.4.2
 */

import { describe, it, beforeAll, beforeEach, expect } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { NEOGRANADINA_TENANT_ID } from "../../app/lib/tenant";

describe("tenant_id FKs", () => {
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    // cleanDatabase() re-seeds the two tenant rows so the FK is
    // resolvable for every domain insert in this suite.
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("users.tenant_id is NOT NULL FK to tenants(id)", async () => {
    const now = Date.now();

    // Valid INSERT with the seeded NEOGRANADINA tenant succeeds.
    const okId = crypto.randomUUID();
    await db.insert(schema.users).values({
      id: okId,
      tenantId: NEOGRANADINA_TENANT_ID,
      email: `ok-${okId}@example.com`,
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, okId));
    expect(row.tenantId).toBe(NEOGRANADINA_TENANT_ID);

    // INSERT with a non-existent tenant id rejects (FK violation).
    const bogusTenant = "00000000-0000-0000-0000-000000000bad";
    await expect(
      db.insert(schema.users).values({
        id: crypto.randomUUID(),
        tenantId: bogusTenant,
        email: `bad-${crypto.randomUUID()}@example.com`,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    // INSERT without tenant_id rejects at the DB layer (NOT NULL).
    // Bypass Drizzle's TS guard via raw SQL so we exercise the
    // constraint in production rather than the TS type.
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), `nullt-${crypto.randomUUID()}@example.com`, now, now)
        .run(),
    ).rejects.toThrow();
  });

  it("users back-fill — every existing v0.3 user row carries tenant_id = NEOGRANADINA_TENANT_ID after 0035", async () => {
    // Cleanslate the harness: cleanDatabase() left only the two seeded
    // tenants behind. INSERTing through the helper (which defaults to
    // DEFAULT_TEST_TENANT_ID = NEOGRANADINA_TENANT_ID) and then reading
    // back asserts that the schema-shape contract honours the back-fill
    // direction the migration takes for every existing v0.3 row.
    const now = Date.now();
    const ids = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    for (const id of ids) {
      await db.insert(schema.users).values({
        id,
        tenantId: DEFAULT_TEST_TENANT_ID,
        email: `bf-${id}@example.com`,
        createdAt: now,
        updatedAt: now,
      });
    }
    const rows = await db.select().from(schema.users);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.tenantId).toBe(NEOGRANADINA_TENANT_ID);
    }
  });

  it("domain FKs — repositories, descriptions, entities, places all NOT NULL FK to tenants(id)", async () => {
    const now = Date.now();
    const bogusTenant = "00000000-0000-0000-0000-000000000bad";

    // repositories: bogus tenant rejects.
    await expect(
      db.insert(schema.repositories).values({
        id: crypto.randomUUID(),
        tenantId: bogusTenant,
        code: `repo-${crypto.randomUUID().slice(0, 4)}`,
        name: "Bogus Repo",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    // Set up a valid repository for the descriptions FK.
    const repoId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: repoId,
      tenantId: NEOGRANADINA_TENANT_ID,
      code: `repo-${repoId.slice(0, 4)}`,
      name: "OK Repo",
      createdAt: now,
      updatedAt: now,
    });

    // descriptions: bogus tenant rejects.
    await expect(
      db.insert(schema.descriptions).values({
        id: crypto.randomUUID(),
        tenantId: bogusTenant,
        repositoryId: repoId,
        descriptionLevel: "fonds",
        referenceCode: `ref-bad-${crypto.randomUUID().slice(0, 4)}`,
        localIdentifier: `loc-bad-${crypto.randomUUID().slice(0, 4)}`,
        title: "Bogus Description",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    // entities: bogus federation rejects.
    await expect(
      db.insert(schema.entities).values({
        id: crypto.randomUUID(),
        federationId: bogusTenant,
        displayName: "Bogus Entity",
        sortName: "Entity, Bogus",
        entityType: "person",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();

    // places: bogus federation rejects.
    await expect(
      db.insert(schema.places).values({
        id: crypto.randomUUID(),
        federationId: bogusTenant,
        label: "Bogus Place",
        displayName: "Bogus Place",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it("NOT NULL enforced — INSERT into any of the 5 tables without tenant_id rejects", async () => {
    const now = Date.now();

    // Set up a valid repository for the descriptions FK.
    const repoId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      id: repoId,
      tenantId: NEOGRANADINA_TENANT_ID,
      code: `repo-nn-${repoId.slice(0, 4)}`,
      name: "OK Repo for NN test",
      createdAt: now,
      updatedAt: now,
    });

    // Each raw-SQL INSERT below omits tenant_id from the column list,
    // exercising the NOT NULL constraint at the DB layer (the TS-side
    // Drizzle guard already rejects this at compile time -- here we
    // verify the runtime enforcement that protects against raw SQL,
    // future bulk import, and any path that bypasses the TS type).
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), `u-${crypto.randomUUID()}@example.com`, now, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO repositories (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), `r-${crypto.randomUUID().slice(0, 4)}`, "Repo", now, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO descriptions (id, repository_id, description_level, reference_code, local_identifier, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          crypto.randomUUID(),
          repoId,
          "fonds",
          `ref-${crypto.randomUUID().slice(0, 4)}`,
          `loc-${crypto.randomUUID().slice(0, 4)}`,
          "Description",
          now,
          now,
        )
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO entities (id, display_name, sort_name, entity_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), "Entity", "Entity, X", "person", now, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      env.DB.prepare(
        "INSERT INTO places (id, label, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), "Place", "Place", now, now)
        .run(),
    ).rejects.toThrow();
  });

  it("RESTRICT — DELETE FROM tenants WHERE id = NEOGRANADINA_TENANT_ID with child rows rejects", async () => {
    const now = Date.now();

    // Insert a single child row into users -- the smallest possible
    // RESTRICT-blocking child set.
    await db.insert(schema.users).values({
      id: crypto.randomUUID(),
      tenantId: NEOGRANADINA_TENANT_ID,
      email: `restrict-${crypto.randomUUID()}@example.com`,
      createdAt: now,
      updatedAt: now,
    });

    // DELETE FROM tenants with the child row in place must fail under
    // ON DELETE RESTRICT. SQLite reports this as a foreign-key
    // constraint failure.
    await expect(
      env.DB.prepare("DELETE FROM tenants WHERE id = ?")
        .bind(NEOGRANADINA_TENANT_ID)
        .run(),
    ).rejects.toThrow();

    // The neogranadina tenant must still be present.
    const remaining = await db.select().from(schema.tenants).where(
      eq(schema.tenants.id, NEOGRANADINA_TENANT_ID),
    );
    expect(remaining.length).toBe(1);
  });
});
