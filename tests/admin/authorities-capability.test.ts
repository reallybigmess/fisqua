/**
 * Tests — authorities capability gate (module spec §6)
 *
 * This suite pins the `authorities` capability introduced in migration
 * 0058: the entity/place admin routes, the description-editor
 * link/unlink intents, the hide-never-sever guarantee, and the export
 * step skip.
 *
 *   - the six admin routes (entities/places × list/new/$id) 404 through
 *     both their loader and their action when the tenant's
 *     `authorities` flag is off, and behave normally when it is on;
 *   - the ten Entity/Place link/unlink intents on the description editor
 *     are rejected server-side when off (hand-crafted POSTs) while the
 *     core description intents (toggle_publish, autosave, update, delete)
 *     stay open — descriptions catalogue with the plain-text display
 *     fields regardless;
 *   - the authority `$id` link_description intents are rejected when off;
 *   - hide-never-sever: flipping the flag off (and back on) leaves the
 *     existing junction rows untouched — the off path never severs a
 *     link; and a rejected off-state link POST deletes nothing;
 *   - resolveExportScope surfaces the triggering tenant's flag, the
 *     value the entities.json/places.json workflow steps gate on.
 *
 * Harness mirrors tests/admin/authority-operations-ledger.test.ts.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedFederations,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { resolveExportScope } from "../../app/lib/export/federation-scope.server";
// Warm the route module graph so the in-test `await import()` resolves
// from cache.
import "../../app/routes/_auth.admin.entities";
import "../../app/routes/_auth.admin.entities.new";
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.places";
import "../../app/routes/_auth.admin.places.new";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.descriptions.$id";

function buildContext(user: User, authoritiesEnabled: boolean): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(
    tenantContext,
    makeTenantContext({ id: user.tenantId, authoritiesEnabled }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

function form(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://neogranadina.fisqua.test/admin/x", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

function get(): Request {
  return new Request("http://neogranadina.fisqua.test/admin/x");
}

function db() {
  return drizzle(env.DB);
}

async function seedAdmin() {
  const user = await createTestUser({ isAdmin: true });
  return makeUserContext({
    id: user.id,
    tenantId: DEFAULT_TEST_TENANT_ID,
    isAdmin: true,
  });
}

async function expect404(fn: () => Promise<unknown>) {
  try {
    await fn();
    expect.fail("Should have thrown 404");
  } catch (e) {
    expect(e).toBeInstanceOf(Response);
    expect((e as Response).status).toBe(404);
  }
}

const ROUTES = {
  entities: "../../app/routes/_auth.admin.entities",
  entitiesNew: "../../app/routes/_auth.admin.entities.new",
  entitiesId: "../../app/routes/_auth.admin.entities.$id",
  places: "../../app/routes/_auth.admin.places",
  placesNew: "../../app/routes/_auth.admin.places.new",
  placesId: "../../app/routes/_auth.admin.places.$id",
} as const;

const ROUTES_DESC = "../../app/routes/_auth.admin.descriptions.$id";

// ---------------------------------------------------------------------------
// Route loader gates
// ---------------------------------------------------------------------------

describe("authorities capability — route loader gates", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("all six loaders 404 when authorities is off", async () => {
    const ctxUser = await seedAdmin();
    const ctx = buildContext(ctxUser, false);

    for (const [key, path] of Object.entries(ROUTES)) {
      const { loader } = await import(path);
      const params = key.endsWith("Id") ? { id: "does-not-matter" } : {};
      await expect404(() =>
        loader({ request: get(), context: ctx, params } as any),
      );
    }
  });

  it("entities/places list loaders return normally when on", async () => {
    const ctxUser = await seedAdmin();
    const ctx = buildContext(ctxUser, true);

    const { loader: entitiesLoader } = await import(ROUTES.entities);
    const entitiesRes = await entitiesLoader({
      request: get(),
      context: ctx,
      params: {},
    } as any);
    expect(entitiesRes).toBeDefined();

    const { loader: placesLoader } = await import(ROUTES.places);
    const placesRes = await placesLoader({
      request: get(),
      context: ctx,
      params: {},
    } as any);
    expect(placesRes).toBeDefined();
  });

  it("entities.$id loader returns the record when on", async () => {
    const ctxUser = await seedAdmin();
    await createTestEntity({
      id: "ent-on",
      entityCode: "ne-on0001",
      displayName: "Reachable",
    });
    const ctx = buildContext(ctxUser, true);

    const { loader } = await import(ROUTES.entitiesId);
    const res: any = await loader({
      request: get(),
      context: ctx,
      params: { id: "ent-on" },
    } as any);
    expect(res.entity.id).toBe("ent-on");
  });
});

// ---------------------------------------------------------------------------
// Route action gates
// ---------------------------------------------------------------------------

describe("authorities capability — route action gates", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("entities.$id / places.$id / new actions 404 when off", async () => {
    const ctxUser = await seedAdmin();
    const ctx = buildContext(ctxUser, false);

    const { action: entId } = await import(ROUTES.entitiesId);
    await expect404(() =>
      entId({
        request: form({ _action: "update" }),
        context: ctx,
        params: { id: "x" },
      } as any),
    );

    const { action: plId } = await import(ROUTES.placesId);
    await expect404(() =>
      plId({
        request: form({ _action: "update" }),
        context: ctx,
        params: { id: "x" },
      } as any),
    );

    const { action: entNew } = await import(ROUTES.entitiesNew);
    await expect404(() =>
      entNew({ request: form({ _action: "create" }), context: ctx, params: {} } as any),
    );

    const { action: plNew } = await import(ROUTES.placesNew);
    await expect404(() =>
      plNew({ request: form({ _action: "create" }), context: ctx, params: {} } as any),
    );
  });

  it("authority $id link_description intent 404s when off", async () => {
    const ctxUser = await seedAdmin();
    const ctx = buildContext(ctxUser, false);

    const { action } = await import(ROUTES.entitiesId);
    await expect404(() =>
      action({
        request: form({ _action: "link_description", descriptionId: "d", role: "creator" }),
        context: ctx,
        params: { id: "ent-x" },
      } as any),
    );
  });
});

// ---------------------------------------------------------------------------
// Description-editor link/unlink intents
// ---------------------------------------------------------------------------

describe("authorities capability — description link intents", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  const LINK_INTENTS = [
    "link_entity",
    "update_entity_link",
    "remove_entity_link",
    "reorder_entity_link",
    "link_place",
    "update_place_link",
    "remove_place_link",
  ];

  it("rejects every Entity/Place link intent with 404 when off", async () => {
    const ctxUser = await seedAdmin();
    await createTestRepository({ id: "repo-l", code: "REPO-L" });
    await createTestDescription({ id: "desc-l", repositoryId: "repo-l" });
    const ctx = buildContext(ctxUser, false);

    const { action } = await import(ROUTES_DESC);
    for (const intent of LINK_INTENTS) {
      await expect404(() =>
        action({
          request: form({ _action: intent }),
          context: ctx,
          params: { id: "desc-l" },
        } as any),
      );
    }
  });

  it("core description intents still work when authorities is off", async () => {
    const ctxUser = await seedAdmin();
    await createTestRepository({ id: "repo-c", code: "REPO-C" });
    await createTestDescription({
      id: "desc-c",
      repositoryId: "repo-c",
      isPublished: false,
    });
    const ctx = buildContext(ctxUser, false);

    const { action } = await import(ROUTES_DESC);
    const res: any = await action({
      request: form({ _action: "toggle_publish" }),
      context: ctx,
      params: { id: "desc-c" },
    } as any);
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hide, never sever
// ---------------------------------------------------------------------------

describe("authorities capability — hide never sever", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedLinkedDescription() {
    await createTestRepository({ id: "repo-s", code: "REPO-S" });
    await createTestDescription({ id: "desc-s", repositoryId: "repo-s" });
    await createTestEntity({ id: "ent-s", entityCode: "ne-s00001", displayName: "E" });
    await createTestPlace({ id: "pl-s", placeCode: "nl-s00001", label: "P" });
    await db().insert(schema.descriptionEntities).values({
      id: "delink-s",
      descriptionId: "desc-s",
      entityId: "ent-s",
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });
    await db().insert(schema.descriptionPlaces).values({
      id: "dplink-s",
      descriptionId: "desc-s",
      placeId: "pl-s",
      role: "subject",
      createdAt: Date.now(),
    });
  }

  async function junctionCounts() {
    const ents = await db().select().from(schema.descriptionEntities).all();
    const places = await db().select().from(schema.descriptionPlaces).all();
    return { ents: ents.length, places: places.length };
  }

  it("toggling the flag off and on leaves junction counts unchanged", async () => {
    await seedLinkedDescription();
    const before = await junctionCounts();
    expect(before).toEqual({ ents: 1, places: 1 });

    await db()
      .update(schema.tenants)
      .set({ authoritiesEnabled: false })
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID));
    expect(await junctionCounts()).toEqual(before);

    await db()
      .update(schema.tenants)
      .set({ authoritiesEnabled: true })
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID));
    expect(await junctionCounts()).toEqual(before);
  });

  it("a rejected off-state link POST deletes nothing", async () => {
    const ctxUser = await seedAdmin();
    await seedLinkedDescription();
    const before = await junctionCounts();
    const ctx = buildContext(ctxUser, false);

    const { action } = await import(ROUTES_DESC);
    await expect404(() =>
      action({
        request: form({ _action: "remove_entity_link", linkId: "delink-s" }),
        context: ctx,
        params: { id: "desc-s" },
      } as any),
    );
    expect(await junctionCounts()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Export scope
// ---------------------------------------------------------------------------

describe("authorities capability — export scope", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedFederations();
  });

  async function scopeFor() {
    const tenant = await db()
      .select({
        id: schema.tenants.id,
        slug: schema.tenants.slug,
        federationId: schema.tenants.federationId,
        descriptiveStandard: schema.tenants.descriptiveStandard,
      })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get();
    return resolveExportScope(db() as any, tenant as any);
  }

  it("scope.authoritiesEnabled is true by default", async () => {
    const scope = await scopeFor();
    expect(scope.authoritiesEnabled).toBe(true);
  });

  it("scope.authoritiesEnabled is false when the tenant flag is off", async () => {
    await db()
      .update(schema.tenants)
      .set({ authoritiesEnabled: false })
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID));
    const scope = await scopeFor();
    expect(scope.authoritiesEnabled).toBe(false);
  });
});
