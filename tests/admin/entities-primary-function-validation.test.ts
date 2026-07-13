/**
 * Tests — entities update action: primaryFunctionId validation
 *
 * This suite pins the fix for the one route-vs-schema mismatch the
 * Stage 2 validation read found: the typeahead's hidden
 * `primaryFunctionId` field bypasses the Zod schema and feeds an FK
 * column, so a stale id (term merged/deleted since page load, or a
 * tampered field) used to fail the whole UPDATE on the FK constraint
 * and swallow the curator's entire edit into the generic error. The
 * action now verifies the term exists and fails field-scoped, leaving
 * the record untouched.
 *
 * Harness mirrors tests/admin/vocab-merge-split-action.test.ts.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_FEDERATION_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/_auth.admin.entities.$id";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function updateForm(entityId: string, fields: Record<string, string>): Request {
  const body = new URLSearchParams({
    _action: "update",
    displayName: "Juan de Castellanos",
    sortName: "Castellanos, Juan de",
    entityType: "person",
    nameVariants: "[]",
    ...fields,
  });
  return new Request(
    `http://neogranadina.fisqua.test/admin/entities/${entityId}`,
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
}

async function runUpdate(user: User, entityId: string, fields: Record<string, string>) {
  const { action } = await import(
    "../../app/routes/_auth.admin.entities.$id"
  );
  return (await action({
    request: updateForm(entityId, fields),
    context: buildContext(user),
    params: { id: entityId },
  } as any)) as any;
}

describe("entities update action — primaryFunctionId validation", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects a nonexistent primaryFunctionId with a field-scoped error and no partial write", async () => {
    const admin = makeUserContext({ isAdmin: true });
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.users).values({
      id: admin.id,
      tenantId: admin.tenantId,
      email: "admin-pfv@example.test",
      isAdmin: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const entityRow = await createTestEntity({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      displayName: "Original Name",
    });
    const entityId = entityRow.id;

    const res = await runUpdate(admin, entityId, {
      displayName: "Should Not Land",
      primaryFunction: "Escribano",
      primaryFunctionId: crypto.randomUUID(),
    });


    expect(res.ok).toBe(false);
    expect(res.errors?.primaryFunction?.[0]).toContain("no longer exists");
    expect(res.error).not.toBe("generic");

    const [row] = await db
      .select({ displayName: schema.entities.displayName })
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .all();
    expect(row.displayName).toBe("Original Name");
  });

  it("accepts an existing term id and links it", async () => {
    const admin = makeUserContext({ isAdmin: true });
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.users).values({
      id: admin.id,
      tenantId: admin.tenantId,
      email: "admin-pfv2@example.test",
      isAdmin: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const entityRow = await createTestEntity({
      federationId: DEFAULT_TEST_FEDERATION_ID,
      displayName: "Original Name",
    });
    const entityId = entityRow.id;
    const termId = crypto.randomUUID();
    await db.insert(schema.vocabularyTerms).values({
      id: termId,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Escribano",
      status: "approved",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await runUpdate(admin, entityId, {
      displayName: "Updated Name",
      primaryFunction: "Escribano",
      primaryFunctionId: termId,
    });

    expect(res.ok).not.toBe(false);

    const [row] = await db
      .select({
        displayName: schema.entities.displayName,
        primaryFunctionId: schema.entities.primaryFunctionId,
      })
      .from(schema.entities)
      .where(eq(schema.entities.id, entityId))
      .all();
    expect(row.displayName).toBe("Updated Name");
    expect(row.primaryFunctionId).toBe(termId);
  });
});
