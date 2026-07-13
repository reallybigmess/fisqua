/**
 * Tests — entities list loader (filter round, spec §5)
 *
 * Pins the server-side behaviour behind the redesigned entities index:
 *   - attested-year filtering by interval overlap (date_start <= to AND
 *     date_end >= from) — in-range, out-of-range, either bound open; a
 *     missing date bound is open-ended (no date_end extends forward, no
 *     date_start extends backward) and only rows with no dates at all
 *     are excluded while the filter is active;
 *   - pure-search count honesty: in FTS fast-path mode the total and
 *     the pill counts derive from the same MATCH population as the
 *     listed rows (a LIKE-substring-only match contributes to neither);
 *   - the primary-function combobox filter, resolved accent-insensitively
 *     to exact stored values through the shared `normaliseName` idiom;
 *   - the three type-pill counts computed under the OTHER active filters
 *     (cross-honest: a year filter narrows the pill counts too);
 *   - the per-row Links count and the correlated-subquery Links sort;
 *   - the legacy `entityType=` param shim (old bookmarks keep working);
 *   - the honest total count that feeds the "Showing X of Y" line, and
 *     the bare (post-Reset) request returning the full live set.
 *
 * Fixtures use colonial-shaped names, ISO floruit dates, and real
 * primary_function values (Presbítero, Capitán) — never invented
 * archival metadata. All reads are federation-scoped exactly as the
 * loader is; the tenant context resolves to the seeded federation.
 *
 * @version v0.4.3
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { createTestRepository } from "../helpers/repositories";
import {
  tenantContext,
  userContext,
  type User,
} from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import "../../app/routes/_auth.admin.entities";

beforeAll(async () => {
  await applyMigrations();
});

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

async function runLoader(url: string, user: User): Promise<any> {
  const { loader } = await import("../../app/routes/_auth.admin.entities");
  return loader({
    request: get(url),
    context: ctxFor(user),
    params: {},
  } as any);
}

let codeSeq = 0;
async function entity(overrides: Record<string, any>) {
  codeSeq += 1;
  return createTestEntity({
    id: crypto.randomUUID(),
    entityCode: `ne-lst${String(codeSeq).padStart(3, "0")}`,
    ...overrides,
  });
}

/** Insert `n` linked descriptions against an entity; returns nothing. */
async function linkDescriptions(
  entityId: string,
  userId: string,
  repoId: string,
  n: number,
) {
  const db = drizzle(env.DB);
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repoId,
      descriptionLevel: "item",
      referenceCode: `REF-${entityId.slice(0, 6)}-${i}`,
      localIdentifier: `REF-${entityId.slice(0, 6)}-${i}`,
      title: `Descripción ${i}`,
      position: i,
      depth: 0,
      childCount: 0,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(),
      descriptionId: descId,
      entityId,
      role: "mentioned",
      sequence: 0,
      createdAt: now,
    });
  }
}

// ---------------------------------------------------------------------------

describe("entities list — attested-year overlap filter", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedYears() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    await entity({
      displayName: "Early",
      sortName: "Early",
      dateStart: "1500-01-01",
      dateEnd: "1550-12-31",
    });
    await entity({
      displayName: "Mid",
      sortName: "Mid",
      dateStart: "1560-01-01",
      dateEnd: "1590-12-31",
    });
    await entity({
      displayName: "Late",
      sortName: "Late",
      dateStart: "1600-01-01",
      dateEnd: "1650-12-31",
    });
    // Open start: no date_start, only date_end — extends backward.
    await entity({
      displayName: "OpenStart",
      sortName: "OpenStart",
      dateEnd: "1580-12-31",
    });
    // Open end: no date_end, only date_start — extends forward.
    await entity({
      displayName: "OpenEnd",
      sortName: "OpenEnd",
      dateStart: "1620-01-01",
    });
    await entity({ displayName: "Undated", sortName: "Undated" });
    return ctxUser;
  }

  it("returns only overlapping rows for a closed range (in-range / out-of-range)", async () => {
    const ctxUser = await seedYears();
    const data = await runLoader(
      "/admin/entities?yearFrom=1555&yearTo=1595",
      ctxUser,
    );
    const names = data.entities.map((e: any) => e.displayName);
    // Mid (1560–1590) overlaps outright; OpenStart extends backward from
    // 1580, so it also reaches into 1555–1595. Early ends 1550, Late
    // starts 1600, OpenEnd starts 1620: all out.
    expect(names).toEqual(["Mid", "OpenStart"]);
    expect(data.totalCount).toBe(2);
  });

  it("open upper bound (from only) matches every later end date and keeps open-ended rows", async () => {
    const ctxUser = await seedYears();
    const data = await runLoader("/admin/entities?yearFrom=1610", ctxUser);
    const names = data.entities.map((e: any) => e.displayName);
    // OpenEnd has date_start but no date_end: the range extends forward,
    // so it overlaps every from-only filter.
    expect(names).toEqual(["Late", "OpenEnd"]);
  });

  it("open lower bound (to only) matches every earlier start date and keeps open-start rows", async () => {
    const ctxUser = await seedYears();
    const data = await runLoader("/admin/entities?yearTo=1520", ctxUser);
    const names = data.entities.map((e: any) => e.displayName);
    // OpenStart has no date_start: the range extends backward, so it
    // overlaps every to-only filter. OpenEnd starts 1620 > 1520: out.
    expect(names).toEqual(["Early", "OpenStart"]);
  });

  it("the open-ended bound still respects the opposite bound", async () => {
    const ctxUser = await seedYears();
    // Closed range before OpenEnd's start: its forward-open range cannot
    // reach back past date_start, so it is excluded; a closed range after
    // OpenStart's end likewise excludes it.
    const early = await runLoader(
      "/admin/entities?yearFrom=1555&yearTo=1595",
      ctxUser,
    );
    const earlyNames = early.entities.map((e: any) => e.displayName);
    expect(earlyNames).not.toContain("OpenEnd");
    expect(earlyNames).toContain("OpenStart");
    const late = await runLoader(
      "/admin/entities?yearFrom=1640&yearTo=1660",
      ctxUser,
    );
    const lateNames = late.entities.map((e: any) => e.displayName);
    expect(lateNames).toContain("OpenEnd");
    expect(lateNames).not.toContain("OpenStart");
  });

  it("excludes only fully undated rows while a year filter is active", async () => {
    const ctxUser = await seedYears();
    const data = await runLoader("/admin/entities?yearFrom=1400", ctxUser);
    const names = data.entities.map((e: any) => e.displayName);
    expect(names).not.toContain("Undated");
    // Both half-dated rows survive a from-only filter: OpenStart ends
    // 1580 >= 1400, OpenEnd extends forward.
    expect(names).toContain("OpenStart");
    expect(names).toContain("OpenEnd");
    expect(names).toContain("Early");
    expect(data.totalCount).toBe(5);
  });
});

describe("entities list — function combobox filter", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedFunctions() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    await entity({
      displayName: "Juan de Castellanos",
      sortName: "Castellanos, Juan de",
      primaryFunction: "Presbítero",
    });
    await entity({
      displayName: "Gonzalo Jiménez de Quesada",
      sortName: "Quesada, Gonzalo Jiménez de",
      primaryFunction: "Capitán",
    });
    await entity({
      displayName: "Anónimo",
      sortName: "Anónimo",
    });
    return ctxUser;
  }

  it("matches the exact stored value accent-insensitively", async () => {
    const ctxUser = await seedFunctions();
    const data = await runLoader("/admin/entities?fn=presbitero", ctxUser);
    expect(data.entities.map((e: any) => e.displayName)).toEqual([
      "Juan de Castellanos",
    ]);
    expect(data.totalCount).toBe(1);
  });

  it("ships the datalist options with real counts", async () => {
    const ctxUser = await seedFunctions();
    const data = await runLoader("/admin/entities", ctxUser);
    const opts = new Map(
      data.functionOptions.map((o: any) => [o.value, o.count]),
    );
    expect(opts.get("Presbítero")).toBe(1);
    expect(opts.get("Capitán")).toBe(1);
  });

  it("an unresolvable function filters to zero rows (never to everything)", async () => {
    const ctxUser = await seedFunctions();
    const data = await runLoader("/admin/entities?fn=Escribano", ctxUser);
    expect(data.entities).toHaveLength(0);
    expect(data.totalCount).toBe(0);
  });
});

describe("entities list — type-pill counts under other filters (cross-honesty)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedTypes() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    // Two persons, one corporate, one family — spanning two eras.
    await entity({
      displayName: "Person Early",
      sortName: "Person Early",
      entityType: "person",
      dateStart: "1550-01-01",
      dateEnd: "1600-12-31",
    });
    await entity({
      displayName: "Person Late",
      sortName: "Person Late",
      entityType: "person",
      dateStart: "1700-01-01",
      dateEnd: "1750-12-31",
    });
    await entity({
      displayName: "Cabildo de Tunja",
      sortName: "Cabildo de Tunja",
      entityType: "corporate",
      dateStart: "1550-01-01",
      dateEnd: "1600-12-31",
    });
    await entity({
      displayName: "Familia Berrío",
      sortName: "Berrío, Familia",
      entityType: "family",
      dateStart: "1700-01-01",
      dateEnd: "1750-12-31",
    });
    return ctxUser;
  }

  it("counts every type with no filter", async () => {
    const ctxUser = await seedTypes();
    const data = await runLoader("/admin/entities", ctxUser);
    expect(data.typeCounts).toEqual({ person: 2, corporate: 1, family: 1 });
    expect(data.totalCount).toBe(4);
  });

  it("recomputes the pill counts under an active year filter", async () => {
    const ctxUser = await seedTypes();
    const data = await runLoader(
      "/admin/entities?yearFrom=1560&yearTo=1580",
      ctxUser,
    );
    // Only the early person and the early corporate overlap 1560–1580.
    expect(data.typeCounts).toEqual({ person: 1, corporate: 1, family: 0 });
    expect(data.totalCount).toBe(2);
  });

  it("skips the type filter itself when counting the pills", async () => {
    const ctxUser = await seedTypes();
    // Selecting a type must not zero the sibling pills — they keep
    // offering their counts under the remaining filters.
    const data = await runLoader("/admin/entities?type=person", ctxUser);
    expect(data.typeCounts).toEqual({ person: 2, corporate: 1, family: 1 });
    // The list itself is narrowed to persons.
    expect(
      data.entities.every((e: any) => e.entityType === "person"),
    ).toBe(true);
    expect(data.totalCount).toBe(2);
  });
});

describe("entities list — Links count and correlated-subquery sort", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedLinks() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const many = await entity({ displayName: "Many links", sortName: "AAA" });
    const few = await entity({ displayName: "Few links", sortName: "BBB" });
    const none = await entity({ displayName: "No links", sortName: "CCC" });
    await linkDescriptions(many.id, user.id, repo.id, 3);
    await linkDescriptions(few.id, user.id, repo.id, 1);
    return { ctxUser, many, few, none };
  }

  it("attaches the real per-row link count", async () => {
    const { ctxUser, many, few, none } = await seedLinks();
    const data = await runLoader("/admin/entities", ctxUser);
    const byId = new Map(data.entities.map((e: any) => [e.id, e.linkCount]));
    expect(byId.get(many.id)).toBe(3);
    expect(byId.get(few.id)).toBe(1);
    expect(byId.get(none.id)).toBe(0);
  });

  it("sorts descending by link count with an offset cursor", async () => {
    const { ctxUser } = await seedLinks();
    const data = await runLoader(
      "/admin/entities?sort=links&sortDir=desc",
      ctxUser,
    );
    const counts = data.entities.map((e: any) => e.linkCount);
    expect(counts).toEqual([3, 1, 0]);
    expect(data.sort).toBe("links");
  });

  it("sorts ascending by link count", async () => {
    const { ctxUser } = await seedLinks();
    const data = await runLoader(
      "/admin/entities?sort=links&sortDir=asc",
      ctxUser,
    );
    expect(data.entities.map((e: any) => e.linkCount)).toEqual([0, 1, 3]);
  });

  it("pages the computed sort by offset without overlap", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    // 55 rows > page size (50) so the first links-sort page exposes a
    // numeric offset cursor and the second page carries the remainder.
    for (let i = 0; i < 55; i++) {
      await entity({
        displayName: `Bulk ${String(i).padStart(3, "0")}`,
        sortName: `Bulk ${String(i).padStart(3, "0")}`,
      });
    }
    const first = await runLoader(
      "/admin/entities?sort=links&sortDir=desc",
      ctxUser,
    );
    expect(first.entities).toHaveLength(50);
    expect(first.nextCursor).toBe("50");
    const second = await runLoader(
      "/admin/entities?sort=links&sortDir=desc&cursor=50",
      ctxUser,
    );
    expect(second.entities).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(second.prevCursor).toBe("0");
    const firstIds = new Set(first.entities.map((e: any) => e.id));
    for (const e of second.entities) {
      expect(firstIds.has(e.id)).toBe(false);
    }
  });
});

describe("entities list — legacy entityType shim and Reset", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedMixed() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    await entity({
      displayName: "A Person",
      sortName: "A Person",
      entityType: "person",
    });
    await entity({
      displayName: "A Corporate",
      sortName: "A Corporate",
      entityType: "corporate",
    });
    return ctxUser;
  }

  it("honours the legacy entityType= param", async () => {
    const ctxUser = await seedMixed();
    const data = await runLoader("/admin/entities?entityType=person", ctxUser);
    expect(data.entityType).toBe("person");
    expect(data.entities.map((e: any) => e.displayName)).toEqual(["A Person"]);
  });

  it("lets the new type= param win when both are present", async () => {
    const ctxUser = await seedMixed();
    const data = await runLoader(
      "/admin/entities?entityType=person&type=corporate",
      ctxUser,
    );
    expect(data.entityType).toBe("corporate");
    expect(data.entities.map((e: any) => e.displayName)).toEqual([
      "A Corporate",
    ]);
  });

  it("ignores an off-vocabulary type value (old-link compatibility)", async () => {
    const ctxUser = await seedMixed();
    const data = await runLoader("/admin/entities?entityType=bogus", ctxUser);
    expect(data.entityType).toBeNull();
    expect(data.entities).toHaveLength(2);
  });

  it("a bare request (post-Reset state) returns the full live set with an honest total", async () => {
    const ctxUser = await seedMixed();
    const data = await runLoader("/admin/entities", ctxUser);
    expect(data.entities).toHaveLength(2);
    expect(data.totalCount).toBe(2);
    expect(data.entityType).toBeNull();
    expect(data.sort).toBeNull();
    expect(data.yearFrom).toBe("");
    expect(data.yearTo).toBe("");
    expect(data.fn).toBe("");
  });
});

describe("entities list — pure-search count honesty (FTS population)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("a LIKE-substring-only match is absent from both the rows and the counts", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    // "Ana Rodríguez" is reachable by the prefix-MATCH token `ana*`;
    // "Juana Pérez" only by the LIKE `%ana%` substring arm (no token of
    // hers starts with "ana"). In pure-search mode the list is
    // MATCH-driven, so Juana must be missing from the rows AND from the
    // total and the pill counts — the numbers match the rows.
    await entity({
      displayName: "Ana Rodríguez",
      sortName: "Rodríguez, Ana",
      entityType: "person",
    });
    await entity({
      displayName: "Juana Pérez",
      sortName: "Pérez, Juana",
      entityType: "person",
    });
    const data = await runLoader("/admin/entities?q=ana", ctxUser);
    expect(data.entities.map((e: any) => e.displayName)).toEqual([
      "Ana Rodríguez",
    ]);
    expect(data.totalCount).toBe(1);
    expect(data.typeCounts).toEqual({ person: 1, corporate: 0, family: 0 });
  });

  it("search-mode counts compose with the symmetric year filter", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    // Both match the search; only the open-ended dated row survives the
    // from-only year filter (a fully undated row is excluded).
    await entity({
      displayName: "Ana Rodríguez",
      sortName: "Rodríguez, Ana",
      entityType: "person",
      dateStart: "1600-01-01",
    });
    await entity({
      displayName: "Ana de Torres",
      sortName: "Torres, Ana de",
      entityType: "person",
    });
    const data = await runLoader(
      "/admin/entities?q=ana&yearFrom=1650",
      ctxUser,
    );
    expect(data.entities.map((e: any) => e.displayName)).toEqual([
      "Ana Rodríguez",
    ]);
    expect(data.totalCount).toBe(1);
    expect(data.typeCounts.person).toBe(1);
  });
});
