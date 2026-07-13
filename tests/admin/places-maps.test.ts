/**
 * Tests — places maps + coordinates (phase 4)
 *
 * Covers the places list loader's map-view points branch (federation
 * scoping, located-only, minimal fields, link counts, MapTiler key
 * pass-through, capability gate), the missing-coordinates filter (the
 * geocoding worklist), the coordinate-save path on the place update
 * action (range validation, NaN rejection, precision persistence), and
 * the detail loader's preview payload. Coordinate status is DERIVED,
 * not stored (migration 0060 dropped needs_geocoding): a save persists
 * the precision vocabulary value and never touches a flag. MapLibre
 * itself is client-only and untested here — these tests pin the DATA
 * contracts the map components consume.
 *
 * The MapTiler key is asserted structurally (present, non-empty) —
 * never against its literal value.
 *
 * The combined-surface loader (spec §5) retires the `view=map` param:
 * points are always computed for the located set, `?view=map` normalises
 * to the plain route with a redirect, and the missing-coordinates chip
 * empties the points so the map dims.
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
import { PLATFORM_FEDERATION_ID } from "../../app/lib/tenant";
import { createTestUser } from "../helpers/auth";
import { createTestPlace } from "../helpers/places";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User, type Tenant } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import "../../app/routes/_auth.admin.places";
import "../../app/routes/_auth.admin.places.$id";

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

function updateForm(fields: Record<string, string>): Request {
  return new Request("http://neogranadina.fisqua.test/admin/places/x", {
    method: "POST",
    body: new URLSearchParams({ _action: "update", ...fields }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

describe("places list — combined surface loader", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seed() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const located = await createTestPlace({
      displayName: "Medellín",
      label: "Medellín",
      placeCode: "nl-map001",
      placeType: "city",
      latitude: 6.2442,
      longitude: -75.5812,
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Unlocated",
      label: "Unlocated",
      placeCode: "nl-map002",
    });
    return { user, ctxUser, located };
  }

  it("returns only located, non-merged places of this federation with the point shape (incl. type)", async () => {
    const { user, ctxUser, located } = await seed();
    // A merged-away located place and a foreign-federation located
    // place must both be excluded.
    const survivor = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Survivor",
      label: "Survivor",
      placeCode: "nl-map003",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Merged Located",
      label: "Merged Located",
      placeCode: "nl-map004",
      latitude: 4.6,
      longitude: -74.08,
      mergedInto: survivor.id,
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      federationId: PLATFORM_FEDERATION_ID,
      displayName: "Foreign Located",
      label: "Foreign Located",
      placeCode: "nl-map005",
      latitude: 10.4,
      longitude: -75.5,
    });

    // One linked description drives the link count.
    const db = drizzle(env.DB);
    const repo = await createTestRepository();
    const now = Date.now();
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "MAP-001",
      localIdentifier: "MAP-001",
      title: "Mapped Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.descriptionPlaces).values({
      id: crypto.randomUUID(),
      descriptionId: descId,
      placeId: located.id,
      role: "mentioned",
      createdAt: now,
    });

    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places"),
      context: buildContext(ctxUser),
      params: {},
    } as any);

    expect(data.points).toHaveLength(1);
    const point = data.points[0];
    expect(point).toEqual({
      id: located.id,
      name: "Medellín",
      code: "nl-map001",
      type: "city",
      count: 1,
      lat: 6.2442,
      lng: -75.5812,
      // External-identifier badge booleans (restored filters).
      tgn: false,
      hgis: false,
      whg: false,
    });
    // The MapTiler key rides the loader payload — assert structurally,
    // never against a literal value.
    expect(typeof data.maptilerKey).toBe("string");
    expect(data.maptilerKey.length).toBeGreaterThan(0);
    // Honest totals (not capped array lengths): one located, two
    // coordinate-less (the unlocated seed + the survivor).
    expect(data.withCoords).toBe(1);
    expect(data.withoutCoords).toBe(2);
  });

  it("normalises ?view=map to the plain route with a redirect, preserving q", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const res: any = await loader({
      request: get("/admin/places?view=map&q=med"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/places?q=med");
  });

  it("empties the points under the missing-coordinates filter and lists coordinate-less places", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?missingCoords=true"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(data.missingCoords).toBe(true);
    expect(data.points).toHaveLength(0);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toContain("Unlocated");
    expect(names).not.toContain("Medellín");
  });

  it("filters to located-uncertain places under the review chip with an honest count", async () => {
    const { ctxUser } = await seed();
    // Medellín (located, precision null) and Unlocated already seeded.
    // Add one located-uncertain place (the review target) and one
    // located-exact place (must be excluded).
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Uncertain Town",
      label: "Uncertain Town",
      placeCode: "nl-unc001",
      latitude: 4.6,
      longitude: -74.08,
      coordinatePrecision: "uncertain",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Exact City",
      label: "Exact City",
      placeCode: "nl-exa001",
      latitude: 10.4,
      longitude: -75.5,
      coordinatePrecision: "exact",
    });

    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?reviewCoords=true"),
      context: buildContext(ctxUser),
      params: {},
    } as any);

    expect(data.reviewCoords).toBe(true);
    // Honest COUNT (not a capped array length): exactly one uncertain.
    expect(data.uncertainCount).toBe(1);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toEqual(["Uncertain Town"]);
    // The map narrows to the same uncertain set.
    expect(data.points.map((p: any) => p.name)).toEqual(["Uncertain Town"]);
  });

  it("makes the two coordinate-status chips mutually exclusive (missing wins)", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?reviewCoords=true&missingCoords=true"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    expect(data.missingCoords).toBe(true);
    expect(data.reviewCoords).toBe(false);
  });

  it("applies the review predicate to mergedCount under showMerged + reviewCoords", async () => {
    const { ctxUser } = await seed();
    // The merged-suffix count must count the SAME population the list
    // shows: under the review chip, only merged rows that are located
    // AND flagged uncertain. A mergedCount without the review predicate
    // would report 2 here (a mixed-population count).
    const survivor = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Survivor",
      label: "Survivor",
      placeCode: "nl-mrg001",
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Merged Uncertain",
      label: "Merged Uncertain",
      placeCode: "nl-mrg002",
      latitude: 4.6,
      longitude: -74.08,
      coordinatePrecision: "uncertain",
      mergedInto: survivor.id,
    });
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Merged Exact",
      label: "Merged Exact",
      placeCode: "nl-mrg003",
      latitude: 10.4,
      longitude: -75.5,
      coordinatePrecision: "exact",
      mergedInto: survivor.id,
    });

    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?reviewCoords=true&showMerged=true"),
      context: buildContext(ctxUser),
      params: {},
    } as any);

    expect(data.reviewCoords).toBe(true);
    // Only the located-uncertain merged row matches the review filter.
    expect(data.mergedCount).toBe(1);
    // The list itself shows the same population — the uncertain merged
    // row and nothing else (no live place here is located-uncertain).
    expect(data.places.map((p: any) => p.displayName)).toEqual([
      "Merged Uncertain",
    ]);
  });

  it("404s the places surface when the authorities capability is off", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    await expect(
      loader({
        request: get("/admin/places"),
        context: buildContext(ctxUser, makeTenantContext({ authoritiesEnabled: false })),
        params: {},
      } as any),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("place coordinate save", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedPlace() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const place = await createTestPlace({
      displayName: "Geocode Me",
      label: "Geocode Me",
      placeCode: "nl-geo001",
    });
    return { ctxUser, place };
  }

  it("writes coordinates and the precision vocabulary value", async () => {
    const { ctxUser, place } = await seedPlace();
    const db = drizzle(env.DB);
    const before = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();
    // No stored geocoding flag any more — status is derived from
    // (coordinates, precision). A fresh seed has neither.
    expect(before!.latitude).toBeNull();
    expect(before!.coordinatePrecision).toBeNull();

    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm({
        label: "Geocode Me",
        displayName: "Geocode Me",
        latitude: "6.2442",
        longitude: "-75.5812",
        coordinatePrecision: "approximate",
        _updatedAt: String(place.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    expect(result).toMatchObject({ ok: true, message: "updated" });

    const after = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();
    expect(after!.latitude).toBe(6.2442);
    expect(after!.longitude).toBe(-75.5812);
    expect(after!.coordinatePrecision).toBe("approximate");
  });

  it("coerces an empty precision select to null (not recorded)", async () => {
    const { ctxUser, place } = await seedPlace();
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm({
        label: "Geocode Me",
        displayName: "Geocode Me",
        latitude: "6.2442",
        longitude: "-75.5812",
        coordinatePrecision: "",
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
    expect(after!.coordinatePrecision).toBeNull();
  });

  it("rejects an out-of-vocabulary precision value", async () => {
    const { ctxUser, place } = await seedPlace();
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm({
        label: "Geocode Me",
        displayName: "Geocode Me",
        latitude: "6.2442",
        longitude: "-75.5812",
        // "settlement" was a legacy free-text value; it is not in the
        // 0060 vocabulary and must be rejected, not stored.
        coordinatePrecision: "settlement",
        _updatedAt: String(place.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.errors.coordinatePrecision).toBeTruthy();
  });

  it("rejects out-of-range coordinates", async () => {
    const { ctxUser, place } = await seedPlace();
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm({
        label: "Geocode Me",
        displayName: "Geocode Me",
        latitude: "91",
        longitude: "-200",
        _updatedAt: String(place.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.errors.latitude).toBeTruthy();
    expect(result.errors.longitude).toBeTruthy();

    // Nothing was written.
    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, place.id))
      .get();
    expect(after!.latitude).toBeNull();
  });

  it("rejects unparseable coordinate input instead of silently nulling it", async () => {
    const { ctxUser, place } = await seedPlace();
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm({
        label: "Geocode Me",
        displayName: "Geocode Me",
        latitude: "abc",
        longitude: "-75.5",
        _updatedAt: String(place.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.errors.latitude).toBeTruthy();
  });

  it("leaves coordinates and precision untouched on a rename-only save", async () => {
    // Seed a located, uncertain place, then rename it without touching
    // coordinates: the derived status inputs must survive unchanged.
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const place = await createTestPlace({
      displayName: "Before",
      label: "Before",
      placeCode: "nl-keep01",
      latitude: 4.6,
      longitude: -74.08,
      coordinatePrecision: "uncertain",
    });
    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const result: any = await action({
      request: updateForm({
        label: "After",
        displayName: "After",
        latitude: "4.6",
        longitude: "-74.08",
        coordinatePrecision: "uncertain",
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
    expect(after!.displayName).toBe("After");
    expect(after!.latitude).toBe(4.6);
    expect(after!.coordinatePrecision).toBe("uncertain");
  });
});

describe("place detail — map preview payload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns coordinates, precision, and the MapTiler key", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const place = await createTestPlace({
      displayName: "Located",
      label: "Located",
      placeCode: "nl-prev01",
      latitude: 6.2442,
      longitude: -75.5812,
      coordinatePrecision: "approximate",
    });
    const { loader } = await import("../../app/routes/_auth.admin.places.$id");
    const data: any = await loader({
      request: get(`/admin/places/${place.id}`),
      context: buildContext(ctxUser),
      params: { id: place.id },
    } as any);
    expect(data.place.latitude).toBe(6.2442);
    expect(data.place.longitude).toBe(-75.5812);
    expect(data.place.coordinatePrecision).toBe("approximate");
    expect(typeof data.maptilerKey).toBe("string");
    expect(data.maptilerKey.length).toBeGreaterThan(0);
  });
});
