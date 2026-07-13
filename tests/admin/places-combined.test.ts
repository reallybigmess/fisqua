/**
 * Tests — places combined surface loader (spec §5)
 *
 * Pins the server-side behaviour the one-page list+map surface relies
 * on: search over display_name, name_variants (matched INSIDE the JSON
 * array text), and place_code; honest totals from real COUNT queries
 * (never capped array lengths); the search applying to the map points
 * too; the `_rows` JSON branch that "Load more" pages against; the
 * show-merged chip (spec §4: merged-away records stay findable in the
 * list with their survivor pointer, but never gain a map pin, and the
 * count line's merged suffix reads a real COUNT); the FTS5-backed
 * accent-insensitive search (the old list's documented behaviour —
 * `bogota` matches `Bogotá` — restored as a predicate arm that composes
 * with every filter, with the old catch-to-LIKE fallback for inputs
 * FTS5 MATCH rejects); and the restored filters — the place-type facet
 * (old `placeType` param), the TGN/HGIS/WHG presence tri-states with
 * their row badges, and lookup-by-external-id through the search bar.
 *
 * All reads are federation-scoped exactly as the loader is; the tenant
 * context resolves to DEFAULT_TEST_FEDERATION_ID via makeTenantContext.
 *
 * @version v0.4.3
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestPlace } from "../helpers/places";
import {
  tenantContext,
  userContext,
  type User,
} from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import "../../app/routes/_auth.admin.places";

function ctxFor(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function get(url: string): Request {
  return new Request(`http://neogranadina.fisqua.test${url}`);
}

describe("places combined — search over name / variants / code", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seed() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    // Matches only via display name.
    await createTestPlace({
      displayName: "Medellín",
      label: "Medellín",
      placeCode: "nl-sca001",
      latitude: 6.2442,
      longitude: -75.5812,
    });
    // Matches only via a name variant (token absent from the name).
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Santa Fe",
      label: "Santa Fe",
      placeCode: "nl-scb002",
      nameVariants: '["Bogotá", "Santafe de Bogota"]',
    });
    // Matches only via place code.
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Tunja",
      label: "Tunja",
      placeCode: "nl-zqx777",
      latitude: 5.5331,
      longitude: -73.3613,
    });
    return { ctxUser };
  }

  it("matches inside the name_variants JSON array", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?q=santafe"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toContain("Santa Fe");
    expect(names).not.toContain("Medellín");
    expect(names).not.toContain("Tunja");
    // No coordinates on the variant match → it is a coordinate-less total.
    expect(data.withCoords).toBe(0);
    expect(data.withoutCoords).toBe(1);
    expect(data.points).toHaveLength(0);
  });

  it("matches place_code and carries the located point into the map payload", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?q=zqx777"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toEqual(["Tunja"]);
    // The search filters the points too (spec point 8).
    expect(data.points).toHaveLength(1);
    expect(data.points[0].id).toBe(data.places[0].id);
    expect(data.withCoords).toBe(1);
    expect(data.withoutCoords).toBe(0);
  });

  it("matches display_name", async () => {
    const { ctxUser } = await seed();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?q=mede"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(data.places.map((p: any) => p.displayName)).toEqual(["Medellín"]);
  });
});

describe("places combined — totals honesty and load-more paging", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("totals count all matches beyond the first page, and the cursor pages via ?_rows", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });

    // 55 located places > PAGE_SIZE (50): totals must report 55, not 50,
    // and the first page must expose a nextCursor.
    const N = 55;
    for (let i = 0; i < N; i++) {
      await createTestPlace({
        id: crypto.randomUUID(),
        // Zero-pad so keyset order on label is deterministic.
        displayName: `Place ${String(i).padStart(3, "0")}`,
        label: `Place ${String(i).padStart(3, "0")}`,
        placeCode: `nl-pg${String(i).padStart(4, "0")}`,
        latitude: 4 + i * 0.001,
        longitude: -74 + i * 0.001,
      });
    }

    const { loader } = await import("../../app/routes/_auth.admin.places");
    const first: any = await loader({
      request: get("/admin/places"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);

    // Honest totals from COUNT, not the 50-row page cap.
    expect(first.withCoords).toBe(N);
    expect(first.withoutCoords).toBe(0);
    expect(first.places).toHaveLength(50);
    expect(first.nextCursor).toBeTruthy();
    // The map receives every filtered point, not just the page.
    expect(first.points).toHaveLength(N);

    // "Load more": the _rows branch returns the remaining 5 rows as JSON.
    const rowsRes: any = await loader({
      request: get(
        `/admin/places?_rows=true&cursor=${encodeURIComponent(first.nextCursor)}`,
      ),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const body = await rowsRes.json();
    expect(body.places).toHaveLength(5);
    expect(body.nextCursor).toBeNull();
    // No overlap between page one and page two.
    const firstIds = new Set(first.places.map((p: any) => p.id));
    for (const r of body.places) {
      expect(firstIds.has(r.id)).toBe(false);
      expect(typeof r.linkCount).toBe("number");
    }
  });
});

describe("places combined — show-merged chip (spec §4)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedMerged() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const survivor = await createTestPlace({
      displayName: "Survivor City",
      label: "Survivor City",
      placeCode: "nl-srv001",
      latitude: 4.6,
      longitude: -74.08,
    });
    // A merged-away place that STILL carries coordinates — it must
    // appear in the list under showMerged but never in the points.
    const merged = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Merged Away",
      label: "Merged Away",
      placeCode: "nl-mgd001",
      latitude: 5.0,
      longitude: -75.0,
      mergedInto: survivor.id,
    });
    return { ctxUser, survivor, merged };
  }

  it("excludes merged rows by default", async () => {
    const { ctxUser } = await seedMerged();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(data.showMerged).toBe(false);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toContain("Survivor City");
    expect(names).not.toContain("Merged Away");
    expect(data.mergedCount).toBe(0);
    // The type facet stays merged-free by default, like the list.
    expect(data.typeCounts).toEqual([{ type: "city", count: 1 }]);
  });

  it("includes merged rows with their survivor name under showMerged, with an honest mergedCount", async () => {
    const { ctxUser, survivor, merged } = await seedMerged();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?showMerged=true"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(data.showMerged).toBe(true);
    const row = data.places.find((p: any) => p.id === merged.id);
    expect(row).toBeTruthy();
    expect(row.mergedInto).toBe(survivor.id);
    expect(row.survivorName).toBe("Survivor City");
    // The suffix count is a real COUNT, not a page-derived number.
    expect(data.mergedCount).toBe(1);
    // Count-line honesty: the live coordinate totals stay merged-free —
    // the merged located row must not inflate withCoords.
    expect(data.withCoords).toBe(1);
    expect(data.withoutCoords).toBe(0);
    // The type facet follows the list's liveness: both seeded places are
    // cities, and under showMerged the merged one joins the facet count.
    expect(data.typeCounts).toEqual([{ type: "city", count: 2 }]);
  });

  it("never gives a merged place a pin, even when it has coordinates", async () => {
    const { ctxUser, survivor, merged } = await seedMerged();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?showMerged=true"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const pointIds = data.points.map((p: any) => p.id);
    expect(pointIds).toContain(survivor.id);
    expect(pointIds).not.toContain(merged.id);
  });

  it("composes showMerged with the search predicate", async () => {
    const { ctxUser, merged } = await seedMerged();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?showMerged=true&q=mgd001"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toEqual(["Merged Away"]);
    expect(data.places[0].id).toBe(merged.id);
    expect(data.mergedCount).toBe(1);
    // The survivor does not match the query, so the live totals are 0.
    expect(data.withCoords).toBe(0);
    expect(data.withoutCoords).toBe(0);
  });

  it("preserves showMerged through the ?view=map redirect", async () => {
    const { ctxUser } = await seedMerged();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const res: any = await loader({
      request: get("/admin/places?view=map&showMerged=true"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/admin/places?showMerged=true",
    );
  });
});

describe("places combined — FTS5 accent-insensitive search", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedAccents() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const bogota = await createTestPlace({
      displayName: "Bogotá",
      label: "Bogotá",
      placeCode: "nl-fts101",
      latitude: 4.6097,
      longitude: -74.0817,
    });
    // The old header's canonical example: `cordoba` finds both the
    // `Córdoba` place and the `Córdova` place (the latter through its
    // name_variants, which the FTS index covers).
    const cordoba = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Córdoba",
      label: "Córdoba",
      placeCode: "nl-fts102",
    });
    const cordova = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Córdova",
      label: "Córdova",
      placeCode: "nl-fts103",
      nameVariants: '["Córdoba"]',
    });
    return { ctxUser, bogota, cordoba, cordova };
  }

  it("matches an accented name from an accentless query, in the list AND the points", async () => {
    const { ctxUser, bogota } = await seedAccents();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?q=bogota"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toContain("Bogotá");
    // The map's points honour the same search.
    expect(data.points.map((p: any) => p.id)).toContain(bogota.id);
    expect(data.withCoords).toBe(1);
  });

  it("cordoba matches both Córdoba and Córdova (the latter via name_variants)", async () => {
    const { ctxUser, cordoba, cordova } = await seedAccents();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?q=cordoba"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const ids = data.places.map((p: any) => p.id);
    expect(ids).toContain(cordoba.id);
    expect(ids).toContain(cordova.id);
    expect(ids).toHaveLength(2);
    // Neither has coordinates — honest totals over the FTS matches.
    expect(data.withCoords).toBe(0);
    expect(data.withoutCoords).toBe(2);
  });

  it("composes the FTS match with showMerged and missing-coords, with honest counts", async () => {
    const { ctxUser, cordoba, cordova } = await seedAccents();
    // Merge Córdova away into Córdoba.
    const { drizzle } = await import("drizzle-orm/d1");
    const { eq } = await import("drizzle-orm");
    const schema = await import("../../app/db/schema");
    const db = drizzle(env.DB);
    await db
      .update(schema.places)
      .set({ mergedInto: cordoba.id })
      .where(eq(schema.places.id, cordova.id));

    const { loader } = await import("../../app/routes/_auth.admin.places");

    // Default: the merged Córdova drops out of the accentless match.
    const dflt: any = await loader({
      request: get("/admin/places?q=cordoba"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(dflt.places.map((p: any) => p.id)).toEqual([cordoba.id]);
    expect(dflt.mergedCount).toBe(0);

    // showMerged: both back, the merged one with its survivor name, and
    // the merged suffix count is a real COUNT scoped to the FTS match.
    const merged: any = await loader({
      request: get("/admin/places?q=cordoba&showMerged=true"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const mergedRow = merged.places.find((p: any) => p.id === cordova.id);
    expect(mergedRow).toBeTruthy();
    expect(mergedRow.survivorName).toBe("Córdoba");
    expect(merged.mergedCount).toBe(1);
    expect(merged.withoutCoords).toBe(1); // live Córdoba only

    // missing-coords worklist: the accentless match still applies.
    const worklist: any = await loader({
      request: get("/admin/places?q=cordoba&missingCoords=true"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(worklist.places.map((p: any) => p.id)).toEqual([cordoba.id]);
    expect(worklist.points).toHaveLength(0);
  });

  it("survives hostile MATCH input via the LIKE fallback (no 500)", async () => {
    const { ctxUser } = await seedAccents();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    for (const hostile of ['"bogota', "*", "-", '"']) {
      const data: any = await loader({
        request: get(`/admin/places?q=${encodeURIComponent(hostile)}`),
        context: ctxFor((ctxUser as any) as User),
        params: {},
      } as any);
      // The loader must resolve to the normal payload shape — the probe
      // catches the FTS syntax error and the LIKE arms stand alone.
      expect(Array.isArray(data.places)).toBe(true);
      expect(Array.isArray(data.points)).toBe(true);
      expect(typeof data.withCoords).toBe("number");
    }
  });
});

describe("places combined — restored filters (type, external ids, id lookup)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedFilters() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const popayan = await createTestPlace({
      displayName: "Popayán",
      label: "Popayán",
      placeCode: "nl-flt001",
      placeType: "city",
      tgnId: "7005273",
      latitude: 2.4419,
      longitude: -76.6074,
    });
    const cali = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Cali",
      label: "Cali",
      placeCode: "nl-flt002",
      placeType: "city",
      hgisId: "hg123",
      latitude: 3.4516,
      longitude: -76.532,
    });
    const guambia = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Guambía",
      label: "Guambía",
      placeCode: "nl-flt003",
      placeType: "town",
    });
    return { ctxUser, popayan, cali, guambia };
  }

  it("placeType filters list, points, and totals under the old param name", async () => {
    const { ctxUser } = await seedFilters();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?placeType=city"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const names = data.places.map((p: any) => p.displayName);
    expect(names).toEqual(["Cali", "Popayán"]);
    expect(data.points).toHaveLength(2);
    expect(data.withCoords).toBe(2);
    expect(data.withoutCoords).toBe(0);
    // The facet skips its own filter: town still offered with its count.
    expect(data.typeCounts).toEqual([
      { type: "city", count: 2 },
      { type: "town", count: 1 },
    ]);
  });

  it("ignores an off-vocabulary placeType value (old-link compatibility)", async () => {
    const { ctxUser } = await seedFilters();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places?placeType=bogus"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(data.placeType).toBeNull();
    expect(data.places).toHaveLength(3);
  });

  it("tri-state external-id filters compose and keep counts honest", async () => {
    const { ctxUser, popayan, cali, guambia } = await seedFilters();
    const { loader } = await import("../../app/routes/_auth.admin.places");

    const has: any = await loader({
      request: get("/admin/places?tgn=has"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(has.places.map((p: any) => p.id)).toEqual([popayan.id]);
    // The points payload honours the presence filter.
    expect(has.points.map((p: any) => p.id)).toEqual([popayan.id]);
    expect(has.withCoords).toBe(1);
    expect(has.withoutCoords).toBe(0);

    const missing: any = await loader({
      request: get("/admin/places?tgn=missing"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const missingIds = missing.places.map((p: any) => p.id);
    expect(missingIds).toContain(cali.id);
    expect(missingIds).toContain(guambia.id);
    expect(missingIds).not.toContain(popayan.id);
    expect(missing.withCoords).toBe(1); // Cali
    expect(missing.withoutCoords).toBe(1); // Guambía

    // Two tri-states compose: missing TGN AND has HGIS → Cali alone.
    const combo: any = await loader({
      request: get("/admin/places?tgn=missing&hgis=has"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(combo.places.map((p: any) => p.id)).toEqual([cali.id]);
    // And with the type facet: only city remains under these filters.
    expect(combo.typeCounts).toEqual([{ type: "city", count: 1 }]);
  });

  it("finds a place by pasting its external identifier, whitespace included", async () => {
    const { ctxUser, popayan } = await seedFilters();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const exact: any = await loader({
      request: get("/admin/places?q=7005273"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(exact.places.map((p: any) => p.id)).toEqual([popayan.id]);

    const padded: any = await loader({
      request: get(`/admin/places?q=${encodeURIComponent("  7005273  ")}`),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(padded.places.map((p: any) => p.id)).toEqual([popayan.id]);
  });

  it("treats an empty-string id as missing, in the filter AND the badge", async () => {
    // The has/missing tri-state must be a total partition: '' is not a
    // real identifier, so it must fall on the `missing` side everywhere
    // the predicate or the badge boolean is evaluated — never counting
    // as `has` while also escaping `missing`.
    const { ctxUser } = await seedFilters();
    const blank = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Blank Id",
      label: "Blank Id",
      placeCode: "nl-flt004",
      placeType: "town",
      tgnId: "",
    });
    const { loader } = await import("../../app/routes/_auth.admin.places");

    const has: any = await loader({
      request: get("/admin/places?tgn=has"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(has.places.map((p: any) => p.id)).not.toContain(blank.id);

    const missing: any = await loader({
      request: get("/admin/places?tgn=missing"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const row = missing.places.find((p: any) => p.id === blank.id);
    expect(row).toBeTruthy();
    expect(row.tgn).toBe(false);
  });

  it("finds a place by an HGIS id containing ':' and '_' without throwing", async () => {
    // The production HGIS ids look like `lugares13k_rel:176703`. In an
    // FTS5 MATCH the `:` reads as a column filter (`no such column`),
    // so the probe must reject it and the LIKE arms stand alone; the
    // `_` LIKE wildcard still matches its literal self, so the paste
    // resolves to the place.
    const { ctxUser } = await seedFilters();
    const hgisPlace = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Almaguer",
      label: "Almaguer",
      placeCode: "nl-flt005",
      hgisId: "lugares13k_rel:176703",
    });
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get(
        `/admin/places?q=${encodeURIComponent("lugares13k_rel:176703")}`,
      ),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(data.places.map((p: any) => p.id)).toEqual([hgisPlace.id]);
  });

  it("rows and points carry the identifier badge booleans", async () => {
    const { ctxUser, popayan, cali, guambia } = await seedFilters();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const data: any = await loader({
      request: get("/admin/places"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const byId = new Map(data.places.map((p: any) => [p.id, p]));
    expect(byId.get(popayan.id)).toMatchObject({
      tgn: true,
      hgis: false,
      whg: false,
    });
    expect(byId.get(cali.id)).toMatchObject({
      tgn: false,
      hgis: true,
      whg: false,
    });
    expect(byId.get(guambia.id)).toMatchObject({
      tgn: false,
      hgis: false,
      whg: false,
    });
    const pointById = new Map(data.points.map((p: any) => [p.id, p]));
    expect(pointById.get(popayan.id)).toMatchObject({ tgn: true, hgis: false });
    expect(pointById.get(cali.id)).toMatchObject({ tgn: false, hgis: true });
  });
});

describe("places combined — legacy advanced-search id params fold into q", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedIds() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const popayan = await createTestPlace({
      displayName: "Popayán",
      label: "Popayán",
      placeCode: "nl-leg001",
      tgnId: "7005273",
    });
    const cali = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Cali",
      label: "Cali",
      placeCode: "nl-leg002",
      hgisId: "hg123",
    });
    const tunja = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Tunja",
      label: "Tunja",
      placeCode: "nl-leg003",
      whgId: "whg456",
    });
    return { ctxUser, popayan, cali, tunja };
  }

  // One case per legacy param: the redirect folds the id into ?q=, and
  // following the redirect resolves the place through the search arms.
  const cases = [
    ["tgnId", "7005273", "Popayán"],
    ["hgisId", "hg123", "Cali"],
    ["whgId", "whg456", "Tunja"],
  ] as const;

  for (const [param, id, expected] of cases) {
    it(`redirects ?${param}= into ?q= and the id resolves`, async () => {
      const { ctxUser } = await seedIds();
      const { loader } = await import("../../app/routes/_auth.admin.places");
      const res: any = await loader({
        request: get(`/admin/places?${param}=${encodeURIComponent(id)}`),
        context: ctxFor((ctxUser as any) as User),
        params: {},
      } as any);
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe(`/admin/places?q=${encodeURIComponent(id)}`);

      // Follow the redirect: the id must resolve through the search arms.
      const data: any = await loader({
        request: get(location),
        context: ctxFor((ctxUser as any) as User),
        params: {},
      } as any);
      expect(data.places.map((p: any) => p.displayName)).toEqual([expected]);
    });
  }

  it("q wins when both q and a legacy id param arrive; the legacy param is dropped", async () => {
    const { ctxUser } = await seedIds();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const res: any = await loader({
      request: get("/admin/places?tgnId=7005273&q=cali"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/places?q=cali");
  });

  it("preserves the other params through the fold", async () => {
    const { ctxUser } = await seedIds();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    const res: any = await loader({
      request: get("/admin/places?hgisId=hg123&showMerged=true"),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    expect(res.status).toBe(302);
    const location = new URL(
      res.headers.get("location"),
      "http://neogranadina.fisqua.test",
    );
    expect(location.pathname).toBe("/admin/places");
    expect(location.searchParams.get("q")).toBe("hg123");
    expect(location.searchParams.get("showMerged")).toBe("true");
    expect(location.searchParams.has("hgisId")).toBe(false);
  });
});

describe("places combined — live viewport re-filter (bounds on the _rows branch)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  // Three located places far apart: Bogotá-ish, Cartagena-ish, and an
  // accented Medellín for the FTS composition case.
  async function seedGeo() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const south = await createTestPlace({
      displayName: "Bogotá",
      label: "Bogotá",
      placeCode: "nl-geo101",
      latitude: 4.6,
      longitude: -74.08,
      tgnId: "7005273",
    });
    const north = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Cartagena",
      label: "Cartagena",
      placeCode: "nl-geo102",
      latitude: 10.42,
      longitude: -75.53,
    });
    const west = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Medellín",
      label: "Medellín",
      placeCode: "nl-geo103",
      latitude: 6.24,
      longitude: -75.58,
    });
    return { ctxUser, south, north, west };
  }

  function rowsUrl(bounds: string, extra = ""): string {
    return `/admin/places?_rows=true&bounds=${encodeURIComponent(bounds)}${extra}`;
  }

  it("returns only in-bounds rows with an honest inViewCount, and a bounds change returns different rows", async () => {
    const { ctxUser, south, north, west } = await seedGeo();
    const { loader } = await import("../../app/routes/_auth.admin.places");

    // Bounds around the south + west pair (Bogotá, Medellín).
    const resA: any = await loader({
      request: get(rowsUrl("-76,4,-73,7")),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const bodyA = await resA.json();
    const idsA = bodyA.places.map((p: any) => p.id);
    expect(idsA).toContain(south.id);
    expect(idsA).toContain(west.id);
    expect(idsA).not.toContain(north.id);
    expect(bodyA.inViewCount).toBe(2);

    // The map settles somewhere else: bounds around Cartagena only.
    const resB: any = await loader({
      request: get(rowsUrl("-76,10,-75,11")),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const bodyB = await resB.json();
    expect(bodyB.places.map((p: any) => p.id)).toEqual([north.id]);
    expect(bodyB.inViewCount).toBe(1);
  });

  it("composes bounds with the accent-insensitive search and the presence filters", async () => {
    const { ctxUser, south, west } = await seedGeo();
    const { loader } = await import("../../app/routes/_auth.admin.places");

    // Accentless q inside wide bounds: only Medellín matches the search.
    const res: any = await loader({
      request: get(rowsUrl("-80,0,-70,12", "&q=medellin")),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const body = await res.json();
    expect(body.places.map((p: any) => p.id)).toEqual([west.id]);
    expect(body.inViewCount).toBe(1);

    // tgn=has inside the same bounds: only Bogotá carries a TGN id.
    const res2: any = await loader({
      request: get(rowsUrl("-80,0,-70,12", "&tgn=has")),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const body2 = await res2.json();
    expect(body2.places.map((p: any) => p.id)).toEqual([south.id]);
    expect(body2.inViewCount).toBe(1);
  });

  it("keeps merged places out of the viewport list even under showMerged", async () => {
    const { ctxUser, south, west } = await seedGeo();
    const { drizzle } = await import("drizzle-orm/d1");
    const { eq } = await import("drizzle-orm");
    const schema = await import("../../app/db/schema");
    const db = drizzle(env.DB);
    await db
      .update(schema.places)
      .set({ mergedInto: south.id })
      .where(eq(schema.places.id, west.id));

    const { loader } = await import("../../app/routes/_auth.admin.places");
    const res: any = await loader({
      request: get(rowsUrl("-80,0,-70,12", "&showMerged=true")),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const body = await res.json();
    const ids = body.places.map((p: any) => p.id);
    expect(ids).not.toContain(west.id);
    // Merged rows never count toward the in-view total either.
    expect(body.inViewCount).toBe(ids.length);
  });

  it("counts honestly past the page cap and pages within the bounds", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const N = 55;
    for (let i = 0; i < N; i++) {
      await createTestPlace({
        id: crypto.randomUUID(),
        displayName: `Viewport ${String(i).padStart(3, "0")}`,
        label: `Viewport ${String(i).padStart(3, "0")}`,
        placeCode: `nl-vw${String(i).padStart(4, "0")}`,
        latitude: 5 + i * 0.001,
        longitude: -74 + i * 0.001,
      });
    }
    // One located place OUTSIDE the bounds must not leak into the count.
    await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Outside",
      label: "Outside",
      placeCode: "nl-vwout1",
      latitude: 10.4,
      longitude: -75.5,
    });

    const { loader } = await import("../../app/routes/_auth.admin.places");
    const first: any = await loader({
      request: get(rowsUrl("-75,4,-73,6")),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const page1 = await first.json();
    expect(page1.places).toHaveLength(50);
    expect(page1.inViewCount).toBe(N);
    expect(page1.nextCursor).toBeTruthy();

    const second: any = await loader({
      request: get(
        rowsUrl("-75,4,-73,6") +
          `&cursor=${encodeURIComponent(page1.nextCursor)}`,
      ),
      context: ctxFor((ctxUser as any) as User),
      params: {},
    } as any);
    const page2 = await second.json();
    expect(page2.places).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
    const names2 = page2.places.map((p: any) => p.displayName);
    expect(names2).not.toContain("Outside");
  });

  it("ignores malformed bounds instead of erroring", async () => {
    const { ctxUser } = await seedGeo();
    const { loader } = await import("../../app/routes/_auth.admin.places");
    for (const bad of ["garbage", "1,2,3", "a,b,c,d", ""]) {
      const res: any = await loader({
        request: get(`/admin/places?_rows=true&bounds=${encodeURIComponent(bad)}`),
        context: ctxFor((ctxUser as any) as User),
        params: {},
      } as any);
      const body = await res.json();
      // Behaves like a plain rows request: all three seeds, no count.
      expect(body.places).toHaveLength(3);
      expect(body.inViewCount).toBeNull();
    }
  });
});
