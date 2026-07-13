/**
 * Tests — authority detail round 2 (notes, unfold card, IDOR)
 *
 * Pins the data contracts behind the second detail-page round:
 *   - the click-to-unfold context card loader branch (`?card=<junctionId>`)
 *     on both detail routes, INCLUDING its ownership check — a junction
 *     id belonging to another record must resolve to `card: null`, never
 *     leak a foreign record's scope text (an IDOR surface);
 *   - the notes / internal_notes round-trip through both update actions;
 *   - the guarantee that internal_notes never appears in export output
 *     (the export formatters have no such column).
 *
 * @version v0.4.3
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
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestPlace } from "../helpers/places";
import { createTestEntity } from "../helpers/entities";
import { createTestRepository } from "../helpers/repositories";
import { userContext, tenantContext, type User, type Tenant } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.entities.$id";

function buildContext(user: User, tenant?: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant ?? makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function get(url: string): Request {
  return new Request(`http://neogranadina.fisqua.test${url}`);
}

function updateForm(path: string, fields: Record<string, string>): Request {
  return new Request(`http://neogranadina.fisqua.test${path}`, {
    method: "POST",
    body: new URLSearchParams({ _action: "update", ...fields }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function makeDescription(
  repoId: string,
  userId: string,
  title: string,
  ref: string,
) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const id = crypto.randomUUID();
  await db.insert(schema.descriptions).values({
    tenantId: DEFAULT_TEST_TENANT_ID,
    id,
    repositoryId: repoId,
    descriptionLevel: "item",
    referenceCode: ref,
    localIdentifier: ref,
    title,
    scopeContent: "Autos sobre el litigio en la parroquia de San Agustin.",
    position: 0,
    depth: 0,
    childCount: 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("place detail — unfold card loader (?card=)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns the context card for a junction owned by the place", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const place = await createTestPlace({
      displayName: "San Agustin",
      label: "San Agustin",
      placeCode: "nl-crd001",
    });
    const descId = await makeDescription(repo.id, user.id, "Litigio", "CARD-1");
    const junctionId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(schema.descriptionPlaces).values({
      id: junctionId,
      descriptionId: descId,
      placeId: place.id,
      role: "mentioned",
      createdAt: Date.now(),
    });

    const { loader } = await import("../../app/routes/_auth.admin.places.$id");
    const res: any = await loader({
      request: get(`/admin/places/${place.id}?card=${junctionId}`),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    const body = await res.json();
    expect(body.card).not.toBeNull();
    expect(body.card.descriptionId).toBe(descId);
    expect(body.card.title).toBe("Litigio");
    expect(body.card.roles.map((r: any) => r.role)).toContain("mentioned");
  });

  it("returns null for a junction that belongs to another place (IDOR)", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const place = await createTestPlace({
      displayName: "Tunja",
      label: "Tunja",
      placeCode: "nl-crd002",
    });
    const other = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Other",
      label: "Other",
      placeCode: "nl-crd003",
    });
    const descId = await makeDescription(repo.id, user.id, "Foreign", "CARD-2");
    const foreignJunction = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(schema.descriptionPlaces).values({
      id: foreignJunction,
      descriptionId: descId,
      placeId: other.id,
      role: "mentioned",
      createdAt: Date.now(),
    });

    const { loader } = await import("../../app/routes/_auth.admin.places.$id");
    // Ask `place` for a junction that belongs to `other`.
    const res: any = await loader({
      request: get(`/admin/places/${place.id}?card=${foreignJunction}`),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    const body = await res.json();
    expect(body.card).toBeNull();
  });
});

describe("entity detail — unfold card loader (?card=)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns the context card for a junction owned by the entity", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const entity = await createTestEntity({
      displayName: "Agustin Sanchez",
      sortName: "Sanchez, Agustin",
    });
    const descId = await makeDescription(repo.id, user.id, "Escritura", "ECARD-1");
    const junctionId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(schema.descriptionEntities).values({
      id: junctionId,
      descriptionId: descId,
      entityId: entity.id,
      role: "mentioned",
      sequence: 0,
      createdAt: Date.now(),
    });

    const { loader } = await import("../../app/routes/_auth.admin.entities.$id");
    const res: any = await loader({
      request: get(`/admin/entities/${entity.id}?card=${junctionId}`),
      context: buildContext(ctxUser),
      params: { id: entity.id },
    } as any);
    const body = await res.json();
    expect(body.card).not.toBeNull();
    expect(body.card.descriptionId).toBe(descId);
    expect(body.card.title).toBe("Escritura");
  });

  it("returns null for a junction that belongs to another entity (IDOR)", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const entity = await createTestEntity({
      displayName: "Entity One",
      sortName: "One, Entity",
      entityCode: "ne-ent001",
    });
    const other = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Entity Two",
      sortName: "Two, Entity",
      entityCode: "ne-ent002",
    });
    const descId = await makeDescription(repo.id, user.id, "Foreign", "ECARD-2");
    const foreignJunction = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(schema.descriptionEntities).values({
      id: foreignJunction,
      descriptionId: descId,
      entityId: other.id,
      role: "mentioned",
      sequence: 0,
      createdAt: Date.now(),
    });

    const { loader } = await import("../../app/routes/_auth.admin.entities.$id");
    const res: any = await loader({
      request: get(`/admin/entities/${entity.id}?card=${foreignJunction}`),
      context: buildContext(ctxUser),
      params: { id: entity.id },
    } as any);
    const body = await res.json();
    expect(body.card).toBeNull();
  });
});

describe("notes round-trip", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists notes and internal_notes on a place update", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const place = await createTestPlace({
      displayName: "Notable Place",
      label: "Notable Place",
      placeCode: "nl-note01",
    });
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm(`/admin/places/${place.id}`, {
        label: "Notable Place",
        displayName: "Notable Place",
        notes: "Public note.",
        internalNotes: "Staff-only note.",
        _updatedAt: String(place.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    expect(result).toMatchObject({ ok: true });

    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();
    expect(after!.notes).toBe("Public note.");
    expect(after!.internalNotes).toBe("Staff-only note.");
  });

  it("persists notes and internal_notes on an entity update", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const entity = await createTestEntity({
      displayName: "Notable Entity",
      sortName: "Entity, Notable",
    });
    const { action } = await import("../../app/routes/_auth.admin.entities.$id");
    const result: any = await action({
      request: updateForm(`/admin/entities/${entity.id}`, {
        displayName: "Notable Entity",
        sortName: "Entity, Notable",
        entityType: "person",
        notes: "Public note.",
        internalNotes: "Staff-only note.",
        _updatedAt: String(entity.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: entity.id },
    } as any);
    expect(result).toMatchObject({ ok: true });

    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entity.id))
      .get();
    expect(after!.notes).toBe("Public note.");
    expect(after!.internalNotes).toBe("Staff-only note.");
  });
});

describe("internal notes are never exported", () => {
  it("the place export shape carries neither notes nor internal_notes", async () => {
    const { formatPlace } = await import("../../app/lib/export/places.server");
    const out: any = formatPlace({
      placeCode: "nl-exp001",
      label: "Exported",
      displayName: "Exported Place",
      placeType: "city",
      fclass: null,
      nameVariants: "[]",
      latitude: 1,
      longitude: 2,
      coordinatePrecision: "exact",
      tgnId: null,
      hgisId: null,
      whgId: null,
    });
    expect("internal_notes" in out).toBe(false);
    expect("internalNotes" in out).toBe(false);
    expect("notes" in out).toBe(false);
  });

  it("the entity export shape carries neither notes nor internal_notes", async () => {
    const { formatEntity } = await import("../../app/lib/export/entities.server");
    const out: any = formatEntity({
      entityCode: "ne-exp001",
      displayName: "Exported Entity",
      sortName: "Entity, Exported",
      givenName: null,
      surname: null,
      entityType: "person",
      honorific: null,
      primaryFunction: null,
      nameVariants: "[]",
      datesOfExistence: null,
      dateStart: null,
      dateEnd: null,
      history: null,
      functions: null,
      sources: null,
      wikidataId: null,
      viafId: null,
    });
    expect("internal_notes" in out).toBe(false);
    expect("internalNotes" in out).toBe(false);
    expect("notes" in out).toBe(false);
  });
});
