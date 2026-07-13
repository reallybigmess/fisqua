/**
 * Tests for Fonds List Lookup
 *
 * This suite deals with pinning the multi-tenant scoping contract of
 * `getFondsList` — the helper that powers the publish dashboard's
 * fonds selector dropdown and the validation layer in the
 * `api.publish` action. The single behaviour under test is that the
 * `tenant: ExportTenant` argument is honoured at the SQL boundary:
 * cataloguers on Tenant A must never see Tenant B's fonds in their
 * selector dropdown, regardless of how the underlying tables are
 * joined or filtered. The suite seeds rows under
 * `DEFAULT_TEST_TENANT_ID` plus a second tenant id, then asserts that
 * each tenant's call returns only its own root reference codes.
 *
 * @version v0.4.2
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { DEFAULT_TEST_TENANT_ID, DEFAULT_TEST_FEDERATION_ID, applyMigrations, cleanDatabase } from "../../../tests/helpers/db";
import { getFondsList } from "./fonds-list.server";
import type { ExportTenant } from "./types";

const TEST_TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

describe("getFondsList", () => {
  let db: ReturnType<typeof drizzle>;
  let repositoryId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    repositoryId = crypto.randomUUID();
    await db.insert(schema.repositories).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: repositoryId,
      code: "test-repo",
      name: "Test Repository",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  it("returns reference codes of root descriptions (parentId IS NULL) sorted alphabetically", async () => {
    const now = Date.now();

    // Insert root descriptions (parentId = null)
    await db.insert(schema.descriptions).values([
      {
        tenantId: DEFAULT_TEST_TENANT_ID,
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: "co-ahr-not",
        localIdentifier: "003",
        title: "Notariales",
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId: DEFAULT_TEST_TENANT_ID,
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: "co-ahr-gob",
        localIdentifier: "001",
        title: "Gobierno",
        createdAt: now,
        updatedAt: now,
      },
      {
        tenantId: DEFAULT_TEST_TENANT_ID,
        id: crypto.randomUUID(),
        repositoryId,
        descriptionLevel: "fonds",
        referenceCode: "co-ahr-jud",
        localIdentifier: "002",
        title: "Judicial",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await getFondsList(db, TEST_TENANT);
    expect(result).toEqual(["co-ahr-gob", "co-ahr-jud", "co-ahr-not"]);
  });

  it("returns empty array when no root descriptions exist", async () => {
    const result = await getFondsList(db, TEST_TENANT);
    expect(result).toEqual([]);
  });

  it("excludes descriptions that have a parentId", async () => {
    const now = Date.now();
    const rootId = crypto.randomUUID();

    // Insert a root description
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: rootId,
      repositoryId,
      descriptionLevel: "fonds",
      referenceCode: "co-ahr-gob",
      localIdentifier: "001",
      title: "Gobierno",
      createdAt: now,
      updatedAt: now,
    });

    // Insert a child description (has parentId)
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: crypto.randomUUID(),
      repositoryId,
      parentId: rootId,
      descriptionLevel: "series",
      referenceCode: "co-ahr-gob-s1",
      localIdentifier: "001-s1",
      title: "Serie 1",
      createdAt: now,
      updatedAt: now,
    });

    const result = await getFondsList(db, TEST_TENANT);
    expect(result).toEqual(["co-ahr-gob"]);
  });
});
