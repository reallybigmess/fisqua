/**
 * Tests — authority operations ledger + hardening
 *
 * This suite drives real `FormData` through the authority mutation
 * actions and pins the `authority_operations` ledger contract added in
 * migration 0057. As of phase 3a the canonical entity/place merge and
 * split sites are the full-page workbench routes
 * (`entities.$id.merge`, `entities.$id.split`, and the place
 * counterparts) — the old `$id` intents were removed (review round 1,
 * DEFECT 1) because they wrote reason-less ledger rows. Delete remains
 * on the `$id` detail actions. The contract pinned:
 *
 *   - one ledger row per operation, with the right
 *     record_type / operation / source_id / target_id / user_id /
 *     federation_id, for entity + place merge/split/delete and vocab
 *     merge — through BOTH live vocab merge paths (the functions.$id
 *     detail action and the review-queue action): every steward-gated
 *     merge site must write the ledger, so each is driven here through
 *     its own real action;
 *   - the conflict-dedup capture: a merge whose moved link collides with
 *     an existing target link records the dropped row's FULL content in
 *     `detail.droppedLinks` and removes it from the junction table (the
 *     fix for the silent junction deletion);
 *   - delete carries a full-row `detail.snapshot`;
 *   - the append-only triggers reject UPDATE and DELETE;
 *   - the operation CHECK enum admits the reserved provenance-backfill
 *     values (resolve, separate — spec §10) and rejects anything else;
 *   - the optimistic-lock guard now covers merge/split: a stale
 *     `_updatedAt` is rejected with the update intent's conflict shape,
 *     and `_force` proceeds;
 *   - the split ownership guard: a submitted linkId that belongs to a
 *     DIFFERENT record is skipped, never repointed, and the ledger's
 *     movedLinks counts only verified rows (mirrors the merge action's
 *     ownership discipline).
 *
 * Harness mirrors tests/admin/vocab-merge-split-action.test.ts: a
 * RouterContextProvider carrying userContext + tenantContext with
 * cloudflare.env attached, plus a real users row so the ledger FK
 * (user_id NOT NULL REFERENCES users(id)) is satisfiable. The acting
 * user is a lead-tenant admin, i.e. a federation steward, so the
 * requireFederationSteward gate on every mutation passes.
 *
 * @version v0.4.3
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Warm the route module graph so the in-test `await import()` resolves
// from cache (see the note in vocab-merge-split-action.test.ts).
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.entities.$id.merge";
import "../../app/routes/_auth.admin.entities.$id.split";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.places.$id.merge";
import "../../app/routes/_auth.admin.places.$id.split";
import "../../app/routes/_auth.admin.vocabularies.functions.$id";
import "../../app/routes/_auth.admin.vocabularies.review";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
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

async function seedAdmin() {
  const user = await createTestUser({ isAdmin: true });
  const ctxUser = makeUserContext({
    id: user.id,
    tenantId: DEFAULT_TEST_TENANT_ID,
    isAdmin: true,
  });
  return { user, ctxUser };
}

async function seedDescription(id: string) {
  await createTestRepository({ id: "repo-led", code: "REPO-LED" });
  return createTestDescription({ id, repositoryId: "repo-led" });
}

function db() {
  return drizzle(env.DB);
}

async function ledgerRows() {
  return db().select().from(schema.authorityOperations).all();
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

describe("authority_operations — entities", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("entity merge writes one ledger row (source=loser, target=winner)", async () => {
    const { ctxUser } = await seedAdmin();
    const source = await createTestEntity({
      id: "ent-src",
      entityCode: "ne-src001",
      displayName: "Loser",
    });
    await createTestEntity({
      id: "ent-tgt",
      entityCode: "ne-tgt001",
      displayName: "Winner",
    });
    await seedDescription("desc-1");
    await db().insert(schema.descriptionEntities).values({
      id: "link-1",
      descriptionId: "desc-1",
      entityId: source.id,
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    const res = (await action({
      request: form({
        _action: "merge",
        reason: "ledger contract merge",
        survivorId: "ent-tgt",
        linkIds: JSON.stringify(["link-1"]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "ent-src" },
    } as any)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/entities/ent-tgt");

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.recordType).toBe("entity");
    expect(row.operation).toBe("merge");
    expect(row.sourceId).toBe("ent-src");
    expect(row.targetId).toBe("ent-tgt");
    expect(row.userId).toBe(ctxUser.id);
    expect(row.federationId).toBe(DEFAULT_TEST_FEDERATION_ID);
    const detail = JSON.parse(row.detail!);
    expect(detail.movedLinks).toBe(1);
    expect(detail.droppedLinks).toEqual([]);

    // Link actually reassigned to the winner.
    const moved = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, "link-1"))
      .get();
    expect(moved!.entityId).toBe("ent-tgt");
  });

  it("entity merge captures conflict-dropped junction rows in detail.droppedLinks", async () => {
    const { ctxUser } = await seedAdmin();
    const source = await createTestEntity({ id: "ent-src", entityCode: "ne-src002", displayName: "Loser" });
    await createTestEntity({ id: "ent-tgt", entityCode: "ne-tgt002", displayName: "Winner" });
    await seedDescription("desc-2");
    // Source link that will collide with the target's existing link on
    // (desc-2, creator). Give it distinctive content to assert capture.
    await db().insert(schema.descriptionEntities).values({
      id: "link-src",
      descriptionId: "desc-2",
      entityId: "ent-src",
      role: "creator",
      roleNote: "verbatim source note",
      sequence: 3,
      honorific: "Don",
      function: "escribano",
      nameAsRecorded: "Juan el viejo",
      createdAt: Date.now(),
    });
    // Pre-existing target link — the merge collision.
    await db().insert(schema.descriptionEntities).values({
      id: "link-tgt",
      descriptionId: "desc-2",
      entityId: "ent-tgt",
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    await action({
      request: form({
        _action: "merge",
        reason: "collision capture merge",
        survivorId: "ent-tgt",
        linkIds: JSON.stringify(["link-src"]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "ent-src" },
    } as any);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    const detail = JSON.parse(rows[0].detail!);
    expect(detail.movedLinks).toBe(0);
    expect(detail.droppedLinks.length).toBe(1);
    const dropped = detail.droppedLinks[0];
    expect(dropped.id).toBe("link-src");
    expect(dropped.roleNote).toBe("verbatim source note");
    expect(dropped.sequence).toBe(3);
    expect(dropped.honorific).toBe("Don");
    expect(dropped.function).toBe("escribano");
    expect(dropped.nameAsRecorded).toBe("Juan el viejo");

    // The colliding source row is gone from the junction table.
    const goneLink = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, "link-src"))
      .get();
    expect(goneLink).toBeUndefined();
  });

  it("entity split writes one ledger row (source=parent, target=new)", async () => {
    const { ctxUser } = await seedAdmin();
    const parent = await createTestEntity({ id: "ent-p", entityCode: "ne-p00001", displayName: "Parent" });
    await seedDescription("desc-3");
    await db().insert(schema.descriptionEntities).values({
      id: "link-3",
      descriptionId: "desc-3",
      entityId: "ent-p",
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const res = (await action({
      request: form({
        _action: "split",
        reason: "ledger contract split",
        nameA: "Parent",
        nameB: "Parent (new)",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "original",
          viafId: "original",
          dbeId: "original",
        }),
        linkIds: JSON.stringify(["link-3"]),
        _updatedAt: String(parent.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "ent-p" },
    } as any)) as Response;
    // The workbench split lands on the ORIGINAL (spec §4); the new
    // record's id comes from the ledger row.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/entities/ent-p");

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].recordType).toBe("entity");
    expect(rows[0].operation).toBe("split");
    expect(rows[0].sourceId).toBe("ent-p");
    expect(rows[0].userId).toBe(ctxUser.id);
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);

    // targetId points at the newly created record.
    const created = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, rows[0].targetId!))
      .get();
    expect(created).toBeTruthy();
    expect(created!.displayName).toBe("Parent (new)");
  });

  it("entity split skips foreign junction ids and counts only verified rows", async () => {
    const { ctxUser } = await seedAdmin();
    const parent = await createTestEntity({
      id: "ent-idor",
      entityCode: "ne-idor01",
      displayName: "Split Me",
    });
    await createTestEntity({
      id: "ent-other",
      entityCode: "ne-othr01",
      displayName: "Untouched Other",
    });
    await seedDescription("desc-idor");
    // The parent's own link — legitimately movable.
    await db().insert(schema.descriptionEntities).values({
      id: "link-own",
      descriptionId: "desc-idor",
      entityId: "ent-idor",
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });
    // A DIFFERENT entity's junction row, submitted by a crafted client.
    await db().insert(schema.descriptionEntities).values({
      id: "link-foreign",
      descriptionId: "desc-idor",
      entityId: "ent-other",
      role: "witness",
      sequence: 0,
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const res = (await action({
      request: form({
        _action: "split",
        reason: "IDOR regression split",
        nameA: "Split Me",
        nameB: "Split Me (new)",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "original",
          viafId: "original",
          dbeId: "original",
        }),
        linkIds: JSON.stringify(["link-own", "link-foreign"]),
        _updatedAt: String(parent.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "ent-idor" },
    } as any)) as Response;
    expect(res.status).toBe(302);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    const newId = rows[0].targetId!;
    // Only the owned link was moved and counted.
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);
    const own = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, "link-own"))
      .get();
    expect(own!.entityId).toBe(newId);
    // The foreign junction row was never reassigned.
    const foreign = await db()
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, "link-foreign"))
      .get();
    expect(foreign!.entityId).toBe("ent-other");
  });

  it("entity delete writes one ledger row with a full-row snapshot", async () => {
    const { ctxUser } = await seedAdmin();
    await createTestEntity({
      id: "ent-del",
      entityCode: "ne-del001",
      displayName: "To Delete",
      surname: "Delete",
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id"
    );
    const res = (await action({
      request: form({ _action: "delete" }),
      context: buildContext(ctxUser),
      params: { id: "ent-del" },
    } as any)) as Response;
    expect(res.status).toBe(302);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].operation).toBe("delete");
    expect(rows[0].sourceId).toBe("ent-del");
    expect(rows[0].targetId).toBeNull();
    const detail = JSON.parse(rows[0].detail!);
    expect(detail.snapshot.id).toBe("ent-del");
    expect(detail.snapshot.entityCode).toBe("ne-del001");
    expect(detail.snapshot.displayName).toBe("To Delete");
    expect(detail.snapshot.surname).toBe("Delete");

    // Record is gone.
    const gone = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, "ent-del"))
      .get();
    expect(gone).toBeUndefined();
  });

  it("entity merge with a stale _updatedAt is rejected; _force proceeds", async () => {
    const { ctxUser } = await seedAdmin();
    const source = await createTestEntity({
      id: "ent-lock",
      entityCode: "ne-lock01",
      displayName: "Loser",
    });
    await createTestEntity({ id: "ent-lw", entityCode: "ne-lw0001", displayName: "Winner" });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );

    // Stale value — rejected with the conflict shape, no ledger row.
    const stale = (await action({
      request: form({
        _action: "merge",
        reason: "stale merge attempt",
        survivorId: "ent-lw",
        linkIds: "[]",
        _updatedAt: String(source.updatedAt - 1),
      }),
      context: buildContext(ctxUser),
      params: { id: "ent-lock" },
    } as any)) as any;
    expect(stale.error).toBe("conflict");
    expect((await ledgerRows()).length).toBe(0);

    // _force overrides the guard and proceeds.
    const forced = (await action({
      request: form({
        _action: "merge",
        reason: "forced merge",
        survivorId: "ent-lw",
        linkIds: "[]",
        _updatedAt: String(source.updatedAt - 1),
        _force: "true",
      }),
      context: buildContext(ctxUser),
      params: { id: "ent-lock" },
    } as any)) as Response;
    expect(forced.status).toBe(302);
    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].operation).toBe("merge");
  });
});

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

describe("authority_operations — places", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("place merge writes one ledger row", async () => {
    const { ctxUser } = await seedAdmin();
    const source = await createTestPlace({ id: "pl-src", placeCode: "nl-src001", label: "Loser" });
    await createTestPlace({ id: "pl-tgt", placeCode: "nl-tgt001", label: "Winner" });
    await seedDescription("desc-p1");
    await db().insert(schema.descriptionPlaces).values({
      id: "plink-1",
      descriptionId: "desc-p1",
      placeId: "pl-src",
      role: "subject",
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id.merge"
    );
    const res = (await action({
      request: form({
        _action: "merge",
        reason: "place ledger contract merge",
        survivorId: "pl-tgt",
        linkIds: JSON.stringify(["plink-1"]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "pl-src" },
    } as any)) as Response;
    expect(res.status).toBe(302);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].recordType).toBe("place");
    expect(rows[0].operation).toBe("merge");
    expect(rows[0].sourceId).toBe("pl-src");
    expect(rows[0].targetId).toBe("pl-tgt");
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);
  });

  it("place merge captures conflict-dropped junction rows (with role_note)", async () => {
    const { ctxUser } = await seedAdmin();
    const source = await createTestPlace({ id: "pl-s2", placeCode: "nl-s20001", label: "Loser" });
    await createTestPlace({ id: "pl-t2", placeCode: "nl-t20001", label: "Winner" });
    await seedDescription("desc-p2");
    await db().insert(schema.descriptionPlaces).values({
      id: "plink-src",
      descriptionId: "desc-p2",
      placeId: "pl-s2",
      role: "subject",
      roleNote: "place verbatim note",
      createdAt: Date.now(),
    });
    await db().insert(schema.descriptionPlaces).values({
      id: "plink-tgt",
      descriptionId: "desc-p2",
      placeId: "pl-t2",
      role: "subject",
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id.merge"
    );
    await action({
      request: form({
        _action: "merge",
        reason: "place collision capture merge",
        survivorId: "pl-t2",
        linkIds: JSON.stringify(["plink-src"]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "pl-s2" },
    } as any);

    const detail = JSON.parse((await ledgerRows())[0].detail!);
    expect(detail.movedLinks).toBe(0);
    expect(detail.droppedLinks.length).toBe(1);
    expect(detail.droppedLinks[0].id).toBe("plink-src");
    expect(detail.droppedLinks[0].roleNote).toBe("place verbatim note");

    const gone = await db()
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, "plink-src"))
      .get();
    expect(gone).toBeUndefined();
  });

  it("place split writes one ledger row (source=parent, target=new)", async () => {
    const { ctxUser } = await seedAdmin();
    const parent = await createTestPlace({ id: "pl-p", placeCode: "nl-p00001", label: "Parent" });
    await seedDescription("desc-p3");
    await db().insert(schema.descriptionPlaces).values({
      id: "plink-3",
      descriptionId: "desc-p3",
      placeId: "pl-p",
      role: "subject",
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id.split"
    );
    const res = (await action({
      request: form({
        _action: "split",
        reason: "place ledger contract split",
        nameA: "Parent",
        nameB: "Parent (new)",
        choices: JSON.stringify({
          coordinates: "original",
          tgnId: "original",
          hgisId: "original",
          whgId: "original",
        }),
        linkIds: JSON.stringify(["plink-3"]),
        _updatedAt: String(parent.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "pl-p" },
    } as any)) as Response;
    // The workbench split lands on the ORIGINAL (spec §4); the new
    // record's id comes from the ledger row.
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/places/pl-p");

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].recordType).toBe("place");
    expect(rows[0].operation).toBe("split");
    expect(rows[0].sourceId).toBe("pl-p");
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);

    const created = await db()
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, rows[0].targetId!))
      .get();
    expect(created).toBeTruthy();
    expect(created!.displayName).toBe("Parent (new)");
  });

  it("place split skips foreign junction ids and counts only verified rows", async () => {
    const { ctxUser } = await seedAdmin();
    const parent = await createTestPlace({
      id: "pl-idor",
      placeCode: "nl-idor01",
      label: "Split Me",
    });
    await createTestPlace({
      id: "pl-other",
      placeCode: "nl-othr01",
      label: "Untouched Other",
    });
    await seedDescription("desc-pidor");
    // The parent's own link — legitimately movable.
    await db().insert(schema.descriptionPlaces).values({
      id: "plink-own",
      descriptionId: "desc-pidor",
      placeId: "pl-idor",
      role: "subject",
      createdAt: Date.now(),
    });
    // A DIFFERENT place's junction row, submitted by a crafted client.
    await db().insert(schema.descriptionPlaces).values({
      id: "plink-foreign",
      descriptionId: "desc-pidor",
      placeId: "pl-other",
      role: "mentioned",
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id.split"
    );
    const res = (await action({
      request: form({
        _action: "split",
        reason: "place IDOR regression split",
        nameA: "Split Me",
        nameB: "Split Me (new)",
        choices: JSON.stringify({
          coordinates: "original",
          tgnId: "original",
          hgisId: "original",
          whgId: "original",
        }),
        linkIds: JSON.stringify(["plink-own", "plink-foreign"]),
        _updatedAt: String(parent.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: "pl-idor" },
    } as any)) as Response;
    expect(res.status).toBe(302);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    const newId = rows[0].targetId!;
    // Only the owned link was moved and counted.
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);
    const own = await db()
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, "plink-own"))
      .get();
    expect(own!.placeId).toBe(newId);
    // The foreign junction row was never reassigned.
    const foreign = await db()
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, "plink-foreign"))
      .get();
    expect(foreign!.placeId).toBe("pl-other");
  });

  it("place delete writes one ledger row with a full-row snapshot", async () => {
    const { ctxUser } = await seedAdmin();
    await createTestPlace({
      id: "pl-del",
      placeCode: "nl-del001",
      label: "Delete Me",
    });

    const { action } = await import("../../app/routes/_auth.admin.places.$id");
    const res = (await action({
      request: form({ _action: "delete" }),
      context: buildContext(ctxUser),
      params: { id: "pl-del" },
    } as any)) as Response;
    expect(res.status).toBe(302);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].operation).toBe("delete");
    expect(rows[0].sourceId).toBe("pl-del");
    expect(rows[0].targetId).toBeNull();
    const detail = JSON.parse(rows[0].detail!);
    expect(detail.snapshot.id).toBe("pl-del");
    expect(detail.snapshot.placeCode).toBe("nl-del001");
    expect(detail.snapshot.label).toBe("Delete Me");
  });
});

// ---------------------------------------------------------------------------
// Vocabulary terms
// ---------------------------------------------------------------------------

describe("authority_operations — vocabulary merge", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("vocab merge writes one ledger row (vocabulary_term / merge)", async () => {
    const { ctxUser } = await seedAdmin();
    const now = Date.now();
    await db().insert(schema.vocabularyTerms).values([
      {
        id: "vt-src",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        canonical: "Notario",
        status: "approved",
        entityCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "vt-tgt",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        canonical: "Escribano",
        status: "approved",
        entityCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const entity = await createTestEntity({
      id: "ent-vt",
      entityCode: "ne-vt0001",
      displayName: "Linked",
    });
    await db()
      .update(schema.entities)
      .set({ primaryFunctionId: "vt-src" })
      .where(eq(schema.entities.id, entity.id));

    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    let redirected: Response | null = null;
    try {
      await action({
        request: form({
          _action: "merge",
          targetId: "vt-tgt",
          linkIds: JSON.stringify([entity.id]),
        }),
        context: buildContext(ctxUser),
        params: { id: "vt-src" },
      } as any);
    } catch (e) {
      redirected = e as Response;
    }
    expect(redirected!.status).toBe(302);

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].recordType).toBe("vocabulary_term");
    expect(rows[0].operation).toBe("merge");
    expect(rows[0].sourceId).toBe("vt-src");
    expect(rows[0].targetId).toBe("vt-tgt");
    expect(rows[0].userId).toBe(ctxUser.id);
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);
    // created_at is epoch ms, not the route's second-precision clock.
    expect(rows[0].createdAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("vocab split writes one ledger row (vocabulary_term / split)", async () => {
    const { ctxUser } = await seedAdmin();
    const now = Date.now();
    await db().insert(schema.vocabularyTerms).values({
      id: "vt-a",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Alcalde",
      status: "approved",
      entityCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    let redirected: Response | null = null;
    try {
      await action({
        request: form({
          _action: "split",
          newName: "Alcalde de primer voto",
          linkIds: "[]",
        }),
        context: buildContext(ctxUser),
        params: { id: "vt-a" },
      } as any);
    } catch (e) {
      redirected = e as Response;
    }
    expect(redirected!.status).toBe(302);
    const newId = redirected!.headers.get("Location")!.split("/").pop()!;

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].recordType).toBe("vocabulary_term");
    expect(rows[0].operation).toBe("split");
    expect(rows[0].sourceId).toBe("vt-a");
    expect(rows[0].targetId).toBe(newId);
  });

  it("review-queue merge writes one ledger row through its own action", async () => {
    const { ctxUser } = await seedAdmin();
    const now = Date.now();
    await db().insert(schema.vocabularyTerms).values([
      {
        id: "vt-rq-src",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        canonical: "Amanuense",
        status: "proposed",
        entityCount: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "vt-rq-tgt",
        federationId: DEFAULT_TEST_FEDERATION_ID,
        canonical: "Escribiente",
        status: "approved",
        entityCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const entity = await createTestEntity({
      id: "ent-rq",
      entityCode: "ne-rq0001",
      displayName: "Review Linked",
    });
    await db()
      .update(schema.entities)
      .set({ primaryFunctionId: "vt-rq-src" })
      .where(eq(schema.entities.id, entity.id));

    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.review"
    );
    const result = (await action({
      request: form({
        _action: "merge",
        sourceId: "vt-rq-src",
        targetId: "vt-rq-tgt",
      }),
      context: buildContext(ctxUser),
      params: {},
    } as any)) as any;
    expect(result.ok).toBe(true);
    expect(result.action).toBe("merged");

    const rows = await ledgerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].recordType).toBe("vocabulary_term");
    expect(rows[0].operation).toBe("merge");
    expect(rows[0].sourceId).toBe("vt-rq-src");
    expect(rows[0].targetId).toBe("vt-rq-tgt");
    expect(rows[0].userId).toBe(ctxUser.id);
    expect(rows[0].federationId).toBe(DEFAULT_TEST_FEDERATION_ID);
    // movedLinks counts the entities whose primaryFunctionId pointed at
    // the source (this route reassigns by predicate, not by linkIds).
    expect(JSON.parse(rows[0].detail!).movedLinks).toBe(1);
    // created_at is epoch ms, not the route's second-precision clock.
    expect(rows[0].createdAt).toBeGreaterThan(1_000_000_000_000);

    // The mutation itself landed with the ledger row: entity reassigned,
    // source deprecated with the mergedInto pointer set.
    const moved = await db()
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entity.id))
      .get();
    expect(moved!.primaryFunctionId).toBe("vt-rq-tgt");
    const src = await db()
      .select()
      .from(schema.vocabularyTerms)
      .where(eq(schema.vocabularyTerms.id, "vt-rq-src"))
      .get();
    expect(src!.status).toBe("deprecated");
    expect(src!.mergedInto).toBe("vt-rq-tgt");
  });
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

describe("authority_operations — immutability", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function insertRow() {
    const { user } = await seedAdmin();
    await db().insert(schema.authorityOperations).values({
      id: "op-immutable",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "delete",
      sourceId: "ent-x",
      targetId: null,
      userId: user.id,
      detail: null,
      createdAt: Date.now(),
    });
  }

  it("rejects UPDATE (BEFORE UPDATE trigger fires)", async () => {
    await insertRow();
    await expect(
      db()
        .update(schema.authorityOperations)
        .set({ operation: "merge" })
        .where(eq(schema.authorityOperations.id, "op-immutable")),
    ).rejects.toThrow();
    // Row unchanged.
    const row = await db()
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.id, "op-immutable"))
      .get();
    expect(row!.operation).toBe("delete");
  });

  it("rejects DELETE (BEFORE DELETE trigger fires)", async () => {
    await insertRow();
    await expect(
      db()
        .delete(schema.authorityOperations)
        .where(eq(schema.authorityOperations.id, "op-immutable")),
    ).rejects.toThrow();
    const rows = await db()
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.id, "op-immutable"))
      .all();
    expect(rows.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Operation CHECK enum
// ---------------------------------------------------------------------------

describe("authority_operations — operation CHECK enum", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("accepts the provenance-backfill values resolve and separate", async () => {
    const { user } = await seedAdmin();
    // resolve: per-entity creation provenance (backfill-only writer).
    await db().insert(schema.authorityOperations).values({
      id: "op-resolve",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "resolve",
      sourceId: "ent-created",
      targetId: null,
      userId: user.id,
      detail: null,
      createdAt: Date.now(),
    });
    // separate: a refuted merge — the do-not-relink pair.
    await db().insert(schema.authorityOperations).values({
      id: "op-separate",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      recordType: "entity",
      operation: "separate",
      sourceId: "ent-a",
      targetId: "ent-b",
      userId: user.id,
      detail: null,
      createdAt: Date.now(),
    });

    const rows = await ledgerRows();
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.operation).sort()).toEqual([
      "resolve",
      "separate",
    ]);
  });

  it("rejects an operation value outside the CHECK enum", async () => {
    const { user } = await seedAdmin();
    // Raw SQL: the Drizzle enum hint is compile-time only, so the DB
    // CHECK is the guard under test here.
    await expect(
      env.DB.prepare(
        "INSERT INTO authority_operations " +
          "(id, federation_id, record_type, operation, source_id, target_id, user_id, detail, created_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?)",
      )
        .bind(
          "op-bogus",
          DEFAULT_TEST_FEDERATION_ID,
          "entity",
          "annihilate",
          "ent-x",
          null,
          user.id,
          null,
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();
    expect((await ledgerRows()).length).toBe(0);
  });
});
