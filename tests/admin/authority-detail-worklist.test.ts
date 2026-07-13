/**
 * Tests — authority detail linked-descriptions worklist (spec §5)
 *
 * Pins the detail loaders' worklist contract for BOTH record types:
 * the loader ships ONE filtered/sorted page (never the whole link
 * set), role counts come from a real GROUP BY, totals come from real
 * COUNTs under every filter combination (the 3b honest-counts defect
 * class), search covers description title AND reference code, the
 * three sorts order as ruled (date newest-first with undated rows
 * last; title; reference code), page size is menu-validated, and a
 * superseded record still serves the worklist data alongside its
 * merge target (the dimming is client-side).
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
import {
  tenantContext,
  userContext,
  type User,
} from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.entities.$id";
import {
  linkYearLabel,
  worklistDisclosure,
} from "../../app/components/admin/linked-descriptions-worklist";
import { groupByRole } from "../../app/components/admin/linked-description-unfold";

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

/** Insert a description with controlled title/code/date fields. */
async function seedDescription(
  userId: string,
  repoId: string,
  fields: {
    title: string;
    referenceCode: string;
    dateStart?: string | null;
    dateExpression?: string | null;
  },
) {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.descriptions).values({
    tenantId: DEFAULT_TEST_TENANT_ID,
    id,
    repositoryId: repoId,
    descriptionLevel: "item",
    referenceCode: fields.referenceCode,
    localIdentifier: fields.referenceCode,
    title: fields.title,
    dateStart: fields.dateStart ?? null,
    dateExpression: fields.dateExpression ?? null,
    position: 0,
    depth: 0,
    childCount: 0,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("place detail — linked-descriptions worklist", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seed() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const place = await createTestPlace({
      displayName: "Tunja",
      label: "Tunja",
      placeCode: "nl-wrk001",
    });
    const db = drizzle(env.DB);
    const now = Date.now();
    // Four descriptions with distinct titles/codes/dates and roles:
    // venue ×2, mentioned ×1, subject ×1.
    const specs = [
      {
        title: "Acta de Cabildo sobre cuentas",
        referenceCode: "co-ahrb-cab-018",
        dateStart: "1650-01-01",
        role: "venue",
      },
      {
        title: "Poder especial para litigios",
        referenceCode: "co-ahrb-cab-041",
        dateStart: "1794-01-01",
        role: "venue",
      },
      {
        title: "Mortuoria de Luis Zarabia",
        referenceCode: "co-ahr-gob-t247",
        dateStart: "1894-01-01",
        role: "mentioned",
      },
      {
        title: "Padrón de vecinos",
        referenceCode: "co-ahr-pad-001",
        dateStart: null, // undated: must sort LAST under date sort
        role: "subject",
      },
    ] as const;
    for (const s of specs) {
      const descId = await seedDescription(user.id, repo.id, s);
      await db.insert(schema.descriptionPlaces).values({
        id: crypto.randomUUID(),
        descriptionId: descId,
        placeId: place.id,
        role: s.role,
        createdAt: now,
      });
    }
    return { ctxUser, place };
  }

  async function load(placeId: string, ctxUser: any, qs = "") {
    const { loader } = await import("../../app/routes/_auth.admin.places.$id");
    return (await loader({
      request: get(`/admin/places/${placeId}${qs}`),
      context: ctxFor((ctxUser as any) as User),
      params: { id: placeId },
    } as any)) as any;
  }

  it("serves one page with role counts from a real GROUP BY and honest totals", async () => {
    const { ctxUser, place } = await seed();
    const data = await load(place.id, ctxUser);
    expect(data.descLinkCount).toBe(4);
    expect(data.allCount).toBe(4);
    expect(data.total).toBe(4);
    // GROUP BY, ordered by count desc.
    expect(data.roleCounts[0]).toEqual({ role: "venue", count: 2 });
    const byRole = new Map(data.roleCounts.map((r: any) => [r.role, r.count]));
    expect(byRole.get("mentioned")).toBe(1);
    expect(byRole.get("subject")).toBe(1);
    expect(data.links).toHaveLength(4);
  });

  it("sorts by date newest-first with undated rows last (default)", async () => {
    const { ctxUser, place } = await seed();
    const data = await load(place.id, ctxUser);
    expect(data.wl.sort).toBe("date");
    const titles = data.links.map((l: any) => l.descriptionTitle);
    expect(titles).toEqual([
      "Mortuoria de Luis Zarabia",
      "Poder especial para litigios",
      "Acta de Cabildo sobre cuentas",
      "Padrón de vecinos", // undated last
    ]);
  });

  it("sorts by title and by reference code", async () => {
    const { ctxUser, place } = await seed();
    const byTitle = await load(place.id, ctxUser, "?sort=title");
    expect(byTitle.links.map((l: any) => l.descriptionTitle)).toEqual([
      "Acta de Cabildo sobre cuentas",
      "Mortuoria de Luis Zarabia",
      "Padrón de vecinos",
      "Poder especial para litigios",
    ]);
    const byCode = await load(place.id, ctxUser, "?sort=code");
    expect(byCode.links.map((l: any) => l.referenceCode)).toEqual([
      "co-ahr-gob-t247",
      "co-ahr-pad-001",
      "co-ahrb-cab-018",
      "co-ahrb-cab-041",
    ]);
  });

  it("searches title AND reference code, keeping role counts honest under the search", async () => {
    const { ctxUser, place } = await seed();
    // Title match.
    const byTitle = await load(place.id, ctxUser, "?dq=cabildo");
    expect(byTitle.total).toBe(1);
    expect(byTitle.links[0].referenceCode).toBe("co-ahrb-cab-018");
    // Code match: both cab codes.
    const byCode = await load(place.id, ctxUser, "?dq=ahrb-cab");
    expect(byCode.total).toBe(2);
    expect(byCode.allCount).toBe(2);
    // Role pills reflect the searched subset (both are venue links).
    expect(byCode.roleCounts).toEqual([{ role: "venue", count: 2 }]);
    // The record's unfiltered link total must NOT shrink under the
    // search — it names the whole link set (the worklist heading).
    expect(byCode.descLinkCount).toBe(4);
  });

  it("composes role filter with search, with an honest filtered total", async () => {
    const { ctxUser, place } = await seed();
    const data = await load(place.id, ctxUser, "?role=venue&dq=poder");
    expect(data.total).toBe(1);
    expect(data.links.map((l: any) => l.descriptionTitle)).toEqual([
      "Poder especial para litigios",
    ]);
    // The All pill still reflects the search across roles.
    expect(data.allCount).toBe(1);
  });

  it("ignores an off-vocabulary role instead of emptying the worklist", async () => {
    const { ctxUser, place } = await seed();
    const data = await load(place.id, ctxUser, "?role=bogus");
    expect(data.wl.role).toBeNull();
    expect(data.total).toBe(4);
  });

  it("paginates with a validated size and an honest total beyond the page", async () => {
    const { ctxUser, place } = await seed();
    // Off-menu size clamps to 25 (all four fit).
    const clamped = await load(place.id, ctxUser, "?size=37");
    expect(clamped.wl.size).toBe(25);
    // There is no 4-row menu size, so drive paging with dpage over the
    // full set: page 2 of size 25 is empty but the total stays honest.
    const page2 = await load(place.id, ctxUser, "?dpage=2");
    expect(page2.links).toHaveLength(0);
    expect(page2.total).toBe(4);
  });

  it("still serves the worklist and merge target on a superseded record", async () => {
    const { ctxUser, place } = await seed();
    const survivor = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Tunja Nueva",
      label: "Tunja Nueva",
      placeCode: "nl-wrk002",
    });
    const db = drizzle(env.DB);
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.places)
      .set({ mergedInto: survivor.id })
      .where(eq(schema.places.id, place.id));

    const data = await load(place.id, ctxUser);
    // The dimming/inertness is client-side; the loader keeps serving
    // the data the page renders behind it, plus the band's target.
    expect(data.mergeTarget?.id).toBe(survivor.id);
    expect(data.allCount).toBe(4);
    expect(data.links).toHaveLength(4);
  });
});

describe("entity detail — linked-descriptions worklist", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seed() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const entity = await createTestEntity({
      displayName: "Agustín Sánchez",
      entityCode: "ne-wrk001",
    });
    const db = drizzle(env.DB);
    const now = Date.now();
    const specs = [
      {
        title: "Causa criminal por hurto",
        referenceCode: "co-ent-001",
        dateStart: "1780-01-01",
        role: "defendant",
      },
      {
        title: "Carta al cabildo",
        referenceCode: "co-ent-002",
        dateStart: "1790-01-01",
        role: "creator",
      },
      {
        title: "Padrón general",
        referenceCode: "co-ent-003",
        dateStart: null,
        role: "mentioned",
      },
    ] as const;
    for (const s of specs) {
      const descId = await seedDescription(user.id, repo.id, s);
      await db.insert(schema.descriptionEntities).values({
        id: crypto.randomUUID(),
        descriptionId: descId,
        entityId: entity.id,
        role: s.role,
        sequence: 0,
        createdAt: now,
      });
    }
    return { ctxUser, entity };
  }

  async function load(entityId: string, ctxUser: any, qs = "") {
    const { loader } = await import(
      "../../app/routes/_auth.admin.entities.$id"
    );
    return (await loader({
      request: get(`/admin/entities/${entityId}${qs}`),
      context: ctxFor((ctxUser as any) as User),
      params: { id: entityId },
    } as any)) as any;
  }

  it("serves the worklist page with role counts and honest totals", async () => {
    const { ctxUser, entity } = await seed();
    const data = await load(entity.id, ctxUser);
    expect(data.descLinkCount).toBe(3);
    expect(data.allCount).toBe(3);
    expect(data.total).toBe(3);
    const roles = data.roleCounts.map((r: any) => r.role);
    expect(roles).toContain("defendant");
    expect(roles).toContain("creator");
    expect(roles).toContain("mentioned");
    // Date sort default: newest first, undated last.
    expect(data.links.map((l: any) => l.descriptionTitle)).toEqual([
      "Carta al cabildo",
      "Causa criminal por hurto",
      "Padrón general",
    ]);
    // Entity link rows carry the dialog's extra junction fields.
    expect(data.links[0]).toHaveProperty("sequence");
    expect(data.links[0]).toHaveProperty("nameAsRecorded");
  });

  it("filters by an entity role with an honest total", async () => {
    const { ctxUser, entity } = await seed();
    const data = await load(entity.id, ctxUser, "?role=creator");
    expect(data.total).toBe(1);
    expect(data.links.map((l: any) => l.role)).toEqual(["creator"]);
    // The All pill keeps the search-scoped whole.
    expect(data.allCount).toBe(3);
  });

  it("searches entity-linked descriptions by title and code", async () => {
    const { ctxUser, entity } = await seed();
    const byTitle = await load(entity.id, ctxUser, "?dq=cabildo");
    expect(byTitle.total).toBe(1);
    const byCode = await load(entity.id, ctxUser, "?dq=co-ent-003");
    expect(byCode.total).toBe(1);
    expect(byCode.links[0].descriptionTitle).toBe("Padrón general");
  });
});

// ---------------------------------------------------------------------------
// Round 3 — repository filter, cross-honest counts, disclosure, Show-all
// ---------------------------------------------------------------------------

describe("place detail — repository filter and progressive disclosure", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  /** Cúcuta with 6 links across TWO repositories:
   *   repo A "AGN"   — subject ×2, mentioned ×2   (4)
   *   repo B (AHRB, empty short_name → code fallback) — venue ×1, subject ×1 (2)
   */
  async function seedMultiRepo() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repoA = await createTestRepository({
      id: "repo-agn",
      code: "CO-AGN",
      name: "Archivo General de la Nación",
      shortName: "AGN",
    });
    const repoB = await createTestRepository({
      id: "repo-ahrb",
      code: "AHRB",
      name: "Archivo Histórico Regional de Boyacá",
      shortName: "", // empty short_name → labels fall back to the code
    });
    const place = await createTestPlace({
      displayName: "Cúcuta",
      label: "Cúcuta",
      placeCode: "nl-7tck3w",
    });
    const db = drizzle(env.DB);
    const now = Date.now();
    const rows = [
      { repo: repoA.id, role: "subject", code: "co-agn-001" },
      { repo: repoA.id, role: "subject", code: "co-agn-002" },
      { repo: repoA.id, role: "mentioned", code: "co-agn-003" },
      { repo: repoA.id, role: "mentioned", code: "co-agn-004" },
      { repo: repoB.id, role: "venue", code: "co-ahrb-001" },
      { repo: repoB.id, role: "subject", code: "co-ahrb-002" },
    ] as const;
    let seq = 0;
    for (const r of rows) {
      const descId = await seedDescription(user.id, r.repo, {
        title: `Doc ${r.code}`,
        referenceCode: r.code,
        dateStart: `18${10 + seq}-01-01`,
      });
      await db.insert(schema.descriptionPlaces).values({
        id: `dp-${seq}`,
        descriptionId: descId,
        placeId: place.id,
        role: r.role,
        createdAt: now + seq,
      });
      seq++;
    }
    return { ctxUser, place, repoA, repoB };
  }

  async function load(placeId: string, ctxUser: any, qs = "") {
    const { loader } = await import("../../app/routes/_auth.admin.places.$id");
    return (await loader({
      request: get(`/admin/places/${placeId}${qs}`),
      context: ctxFor((ctxUser as any) as User),
      params: { id: placeId },
    } as any)) as any;
  }

  it("exposes the repo span and labelled repo counts, code fallback on empty short_name", async () => {
    const { ctxUser, place } = await seedMultiRepo();
    const data = await load(place.id, ctxUser);
    expect(data.repoSpan).toBe(2);
    expect(data.descLinkCount).toBe(6);
    const byRepo = new Map<string, any>(
      data.repoCounts.map((r: any) => [r.repositoryId, r]),
    );
    expect(byRepo.get("repo-agn").label).toBe("AGN");
    expect(byRepo.get("repo-agn").count).toBe(4);
    // Empty short_name → the code, not the long name.
    expect(byRepo.get("repo-ahrb").label).toBe("AHRB");
    expect(byRepo.get("repo-ahrb").count).toBe(2);
  });

  it("computes role counts UNDER the repo filter and repo counts UNDER the role filter (cross-honest)", async () => {
    const { ctxUser, place } = await seedMultiRepo();

    // Role counts under repo=AGN: only AGN's rows (subject 2, mentioned 2).
    const byRepoA = await load(place.id, ctxUser, "?repo=repo-agn");
    expect(byRepoA.total).toBe(4);
    expect(byRepoA.allCount).toBe(4);
    const rolesA = new Map(
      byRepoA.roleCounts.map((r: any) => [r.role, r.count]),
    );
    expect(rolesA.get("subject")).toBe(2);
    expect(rolesA.get("mentioned")).toBe(2);
    expect(rolesA.has("venue")).toBe(false);
    // Repo pills stay full (role unfiltered): both repos present.
    expect(byRepoA.repoCounts).toHaveLength(2);

    // Repo counts under role=subject: AGN 2, AHRB 1 (venue-only rows drop).
    const bySubject = await load(place.id, ctxUser, "?role=subject");
    const reposS = new Map(
      bySubject.repoCounts.map((r: any) => [r.repositoryId, r.count]),
    );
    expect(reposS.get("repo-agn")).toBe(2);
    expect(reposS.get("repo-ahrb")).toBe(1);
    expect(bySubject.total).toBe(3); // subject across both repos
    // Role pills stay full (repo unfiltered).
    expect(bySubject.allCount).toBe(6);

    // Both filters compose to a single honest total.
    const both = await load(place.id, ctxUser, "?role=subject&repo=repo-ahrb");
    expect(both.total).toBe(1);
  });

  it("ignores a repo id that is not one of the record's own", async () => {
    const { ctxUser, place } = await seedMultiRepo();
    const data = await load(place.id, ctxUser, "?repo=repo-does-not-exist");
    expect(data.wl.repo).toBeNull();
    expect(data.total).toBe(6);
  });

  it("serves the full OCR transcript only on the &full=1 branch, ownership-scoped", async () => {
    const { ctxUser, place } = await seedMultiRepo();
    const db = drizzle(env.DB);
    // Attach a transcript to one of the place's descriptions.
    const owned = await db
      .select({ id: schema.descriptionPlaces.id, descriptionId: schema.descriptionPlaces.descriptionId })
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.placeId, place.id))
      .get();
    const transcript = "Huanuco ".repeat(500);
    await db
      .update(schema.descriptions)
      .set({ ocrText: transcript })
      .where(eq(schema.descriptions.id, owned!.descriptionId));

    // The card/full branch returns a bare Response (JSON), not the page
    // payload — parse it.
    const fullRes = await load(place.id, ctxUser, `?card=${owned!.id}&full=1`);
    const full = await (fullRes as Response).json();
    expect((full as any).ocrFull).toBe(transcript);

    // A foreign junction id → null, never a leak.
    const foreignPlace = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Otra",
      label: "Otra",
      placeCode: "nl-otra01",
    });
    const foreignRes = await load(
      foreignPlace.id,
      ctxUser,
      `?card=${owned!.id}&full=1`,
    );
    const foreign = await (foreignRes as Response).json();
    expect((foreign as any).ocrFull).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure row/panel helpers
// ---------------------------------------------------------------------------

describe("worklist row + unfold pure helpers", () => {
  it("formats dates year-granular: same-year, cross-year, undated", () => {
    expect(
      linkYearLabel({ dateExpression: null, dateStart: "1830-05-02", dateEnd: "1830-11-01" }),
    ).toBe("1830");
    expect(
      linkYearLabel({ dateExpression: null, dateStart: "1828-01-01", dateEnd: "1829-12-31" }),
    ).toBe("1828–1829");
    expect(
      linkYearLabel({ dateExpression: null, dateStart: "1794-06-01", dateEnd: null }),
    ).toBe("1794");
    // No structured range → the catalogued expression verbatim.
    expect(
      linkYearLabel({ dateExpression: "s. XVIII", dateStart: null, dateEnd: null }),
    ).toBe("s. XVIII");
    // Nothing at all.
    expect(
      linkYearLabel({ dateExpression: null, dateStart: null, dateEnd: null }),
    ).toBe("—");
  });

  it("gates the whole control row (search+sort AND role/repo pills) at ≤5 links", () => {
    // ≤5 links: the control row disappears entirely — even a multi-repo
    // record shows no pills (the few rows already carry their roles).
    const small = worklistDisclosure(5, 3);
    expect(small.showSearchSort).toBe(false);
    expect(small.showRepoPills).toBe(false);
    expect(small.showSizeSelect).toBe(false);

    // >5 links: search+sort and the role pills appear; repo pills still
    // require the links to span more than one repository.
    const singleRepo = worklistDisclosure(6, 1);
    expect(singleRepo.showSearchSort).toBe(true);
    expect(singleRepo.showRepoPills).toBe(false);

    const multiRepo = worklistDisclosure(6, 2);
    expect(multiRepo.showSearchSort).toBe(true);
    expect(multiRepo.showRepoPills).toBe(true);

    // Page-size select is its own, higher threshold (>25).
    expect(worklistDisclosure(25, 2).showSizeSelect).toBe(false);
    expect(worklistDisclosure(26, 2).showSizeSelect).toBe(true);
  });

  it("groups chips by role preserving first-appearance order, current flag intact", () => {
    const grouped = groupByRole([
      { name: "Santafé", role: "venue", isCurrent: false },
      { name: "Cúcuta", role: "subject", isCurrent: true },
      { name: "Pamplona", role: "venue" },
    ]);
    expect(grouped.map((g) => g.role)).toEqual(["venue", "subject"]);
    expect(grouped[0].items.map((i) => i.name)).toEqual(["Santafé", "Pamplona"]);
    expect(grouped[1].items[0].isCurrent).toBe(true);
    // The chips carry no role prefix in their names — the group label does.
    expect(grouped[1].items[0].name).toBe("Cúcuta");
  });
});
