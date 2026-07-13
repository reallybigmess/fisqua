/**
 * Tests — authority merge/split workbenches (phase 3a)
 *
 * Drives real `FormData` through the full-page merge and split workbench
 * route actions (`entities.$id.merge`, `entities.$id.split`) and their
 * loaders, plus the ledger-derived superseded-status helper and the
 * entities list show-merged filter. Harness mirrors
 * `vocab-merge-split-action.test.ts`: a `RouterContextProvider` carrying
 * userContext + tenantContext with `cloudflare.env` attached, and a real
 * users row so the ledger FK (`user_id NOT NULL REFERENCES users(id)`)
 * and the federation-steward gate (home admin on the lead tenant) are
 * satisfiable.
 *
 * What it pins:
 *   - merge: reason required (empty rejected), survivor reassignment
 *     (links move, loser gets `mergedInto`), a ledger row with
 *     `detail.reason`, optimistic-lock conflict, and the `authorities`
 *     capability gate (404 when off).
 *   - split: reason required, names-identical rejected, unassigned
 *     rejected (including EMPTY and PARTIAL `choices` — full assignment
 *     is server-enforced, review HARDEN 2), `"both"` rejected on
 *     exactly-one-side external-ID keys (HARDEN 3), and the happy path
 *     (new record created, external id moved to the assigned side,
 *     links moved, lands on the original).
 *   - merge link ownership: a linkId belonging to a different record is
 *     skipped, never repointed (HARDEN 4); junction collisions land in
 *     `detail.droppedLinks` with the loser's row deleted.
 *   - places routes: one merge and one split action test drive the
 *     place workbenches end-to-end.
 *   - old-intent regression: `_action=merge` against the detail routes
 *     no longer merges (DEFECT 1 — the workbenches are the only merge
 *     path and the only writers of reasoned ledger rows).
 *   - superseded derivation: `getOperationActor` resolves the merge
 *     actor + date from the ledger.
 *   - show-merged: the list loader excludes merged-away rows by default
 *     and includes them when `showMerged=true`.
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
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestRepository } from "../helpers/repositories";
import { tenantContext, userContext, type User, type Tenant } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import "../../app/routes/_auth.admin.entities.$id.merge";
import "../../app/routes/_auth.admin.entities.$id.split";
import "../../app/routes/_auth.admin.places.$id.merge";
import "../../app/routes/_auth.admin.places.$id.split";
import "../../app/routes/_auth.admin.entities.$id";
import "../../app/routes/_auth.admin.places.$id";
import "../../app/routes/_auth.admin.entities";

function buildContext(user: User, tenant?: Tenant): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, tenant ?? makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function form(fields: Record<string, string>): Request {
  return new Request("http://neogranadina.fisqua.test/admin/entities/x/merge", {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

async function setupPair() {
  const user = await createTestUser({ isAdmin: true, name: "Ada Lovelace" });
  const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
  const repo = await createTestRepository();
  const source = await createTestEntity({
    displayName: "Bolívar",
    sortName: "Bolivar",
    entityCode: "ne-src001",
    wikidataId: "Q8195",
  });
  const target = await createTestEntity({
    id: crypto.randomUUID(),
    displayName: "Simón Bolívar",
    sortName: "Bolivar, Simon",
    entityCode: "ne-tgt001",
  });
  const db = drizzle(env.DB);
  const now = Date.now();
  const descId = crypto.randomUUID();
  await db.insert(schema.descriptions).values({
    tenantId: DEFAULT_TEST_TENANT_ID,
    id: descId,
    repositoryId: repo.id,
    descriptionLevel: "item",
    referenceCode: "WB-001",
    localIdentifier: "WB-001",
    title: "Test Item",
    position: 0,
    depth: 0,
    childCount: 0,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  });
  const linkId = crypto.randomUUID();
  await db.insert(schema.descriptionEntities).values({
    id: linkId,
    descriptionId: descId,
    entityId: source.id,
    role: "creator",
    sequence: 0,
    createdAt: now,
  });
  return { ctxUser, source, target, linkId };
}

describe("merge workbench action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects an empty reason", async () => {
    const { ctxUser, source, target } = await setupPair();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    const result = await action({
      request: form({
        _action: "merge",
        reason: "   ",
        loserId: source.id,
        survivorId: target.id,
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result).toEqual({ ok: false, error: "reason" });
  });

  it("reassigns links, marks the loser merged, and writes the reason to the ledger", async () => {
    const { ctxUser, source, target, linkId } = await setupPair();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    const db = drizzle(env.DB);

    const redirected: any = await action({
      request: form({
        _action: "merge",
        reason: "duplicate of the canonical record",
        loserId: source.id,
        survivorId: target.id,
        linkIds: JSON.stringify([linkId]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Location")).toBe(
      `/admin/entities/${target.id}`,
    );

    const loser = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, source.id))
      .get();
    expect(loser!.mergedInto).toBe(target.id);

    const link = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    expect(link!.entityId).toBe(target.id);

    const op = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .get();
    expect(op!.operation).toBe("merge");
    expect(op!.targetId).toBe(target.id);
    expect(JSON.parse(op!.detail as string).reason).toBe(
      "duplicate of the canonical record",
    );
  });

  it("returns a conflict when the loser moved since the form loaded", async () => {
    const { ctxUser, source, target } = await setupPair();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    const result: any = await action({
      request: form({
        _action: "merge",
        reason: "merge",
        loserId: source.id,
        survivorId: target.id,
        linkIds: "[]",
        _updatedAt: String(source.updatedAt - 5000),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("conflict");
  });

  it("folds the loser's names into the survivor's variants when requested", async () => {
    const { ctxUser, source, target } = await setupPair();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    const db = drizzle(env.DB);
    try {
      await action({
        request: form({
          _action: "merge",
          reason: "fold names",
          loserId: source.id,
          survivorId: target.id,
          linkIds: "[]",
          addVariants: "true",
          _updatedAt: String(source.updatedAt),
        }),
        context: buildContext(ctxUser),
        params: { id: source.id },
      } as any);
    } catch {
      /* redirect */
    }
    const survivor = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, target.id))
      .get();
    const variants = JSON.parse(survivor!.nameVariants || "[]");
    expect(variants).toContain("Bolívar");
  });

  it("404s the loader when the authorities capability is off", async () => {
    const { ctxUser, source } = await setupPair();
    const { loader } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    const offTenant = makeTenantContext({ authoritiesEnabled: false });
    await expect(
      loader({
        request: new Request(
          `http://neogranadina.fisqua.test/admin/entities/${source.id}/merge`,
        ),
        context: buildContext(ctxUser, offTenant),
        params: { id: source.id },
      } as any),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("split workbench action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupSplit() {
    const user = await createTestUser({ isAdmin: true, name: "Ada Lovelace" });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const source = await createTestEntity({
      displayName: "Conflated Person",
      sortName: "Conflated",
      entityCode: "ne-cnf001",
      wikidataId: "Q123",
    });
    const db = drizzle(env.DB);
    const now = Date.now();
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "SP-001",
      localIdentifier: "SP-001",
      title: "Test Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: linkId,
      descriptionId: descId,
      entityId: source.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });
    return { ctxUser, source, linkId };
  }

  function splitForm(fields: Record<string, string>): Request {
    return new Request("http://neogranadina.fisqua.test/admin/entities/x/split", {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  it("rejects identical names", async () => {
    const { ctxUser, source } = await setupSplit();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const result: any = await action({
      request: splitForm({
        _action: "split",
        reason: "split",
        nameA: "Same",
        nameB: "Same",
        choices: JSON.stringify({ wikidataId: "original" }),
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("names");
  });

  it("rejects an unassigned field row", async () => {
    const { ctxUser, source } = await setupSplit();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const result: any = await action({
      request: splitForm({
        _action: "split",
        reason: "split",
        nameA: "Left",
        nameB: "Right",
        choices: JSON.stringify({ wikidataId: "" }),
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unassigned");
  });

  it("creates the new record, moves the external id + link, lands on the original", async () => {
    const { ctxUser, source, linkId } = await setupSplit();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const db = drizzle(env.DB);

    const redirected: any = await action({
      request: splitForm({
        _action: "split",
        reason: "these are two different people",
        nameA: "Person A",
        nameB: "Person B",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "new",
          viafId: "original",
          dbeId: "original",
        }),
        linkIds: JSON.stringify([linkId]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Location")).toBe(
      `/admin/entities/${source.id}`,
    );

    // The original is renamed and stripped of the reassigned wikidata id.
    const original = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, source.id))
      .get();
    expect(original!.displayName).toBe("Person A");
    expect(original!.wikidataId).toBeNull();

    // A new record exists carrying the wikidata id and the moved link.
    const created = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.displayName, "Person B"))
      .get();
    expect(created).toBeTruthy();
    expect(created!.wikidataId).toBe("Q123");

    const link = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    expect(link!.entityId).toBe(created!.id);

    const op = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .get();
    expect(op!.operation).toBe("split");
    expect(op!.targetId).toBe(created!.id);
    expect(JSON.parse(op!.detail as string).reason).toBe(
      "these are two different people",
    );
  });
});

describe("superseded derivation + show-merged filter", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("getOperationActor resolves the merge actor and date", async () => {
    const { ctxUser, source, target } = await setupPair();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    try {
      await action({
        request: form({
          _action: "merge",
          reason: "merge",
          loserId: source.id,
          survivorId: target.id,
          linkIds: "[]",
          _updatedAt: String(source.updatedAt),
        }),
        context: buildContext(ctxUser),
        params: { id: source.id },
      } as any);
    } catch {
      /* redirect */
    }

    const db = drizzle(env.DB);
    const { getOperationActor, bandDate } = await import(
      "../../app/lib/authority-workbench.server"
    );
    const actor = await getOperationActor(db, {
      recordType: "entity",
      operation: "merge",
      sourceId: source.id,
      targetId: target.id,
    });
    expect(actor).not.toBeNull();
    expect(actor!.userName).toBe("Ada Lovelace");
    expect(bandDate(actor!.createdAt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the list loader excludes merged rows by default and includes them with showMerged", async () => {
    await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ isAdmin: true });
    const survivor = await createTestEntity({
      displayName: "Survivor",
      sortName: "Survivor",
      entityCode: "ne-surv01",
    });
    await createTestEntity({
      displayName: "Merged Away",
      sortName: "Merged Away",
      entityCode: "ne-away01",
      mergedInto: survivor.id,
    });
    const { loader } = await import("../../app/routes/_auth.admin.entities");

    const off: any = await loader({
      request: new Request("http://neogranadina.fisqua.test/admin/entities"),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    const offNames = off.entities.map((e: any) => e.displayName);
    expect(offNames).toContain("Survivor");
    expect(offNames).not.toContain("Merged Away");

    const on: any = await loader({
      request: new Request(
        "http://neogranadina.fisqua.test/admin/entities?showMerged=true",
      ),
      context: buildContext(ctxUser),
      params: {},
    } as any);
    const onNames = on.entities.map((e: any) => e.displayName);
    expect(onNames).toContain("Merged Away");
  });
});

describe("split full-assignment + exactly-one-side enforcement (review round 1)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  function splitForm(fields: Record<string, string>): Request {
    return new Request("http://neogranadina.fisqua.test/admin/entities/x/split", {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  async function setupEntity() {
    await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ isAdmin: true });
    const source = await createTestEntity({
      displayName: "Conflated Person",
      sortName: "Conflated",
      entityCode: "ne-full01",
      wikidataId: "Q123",
      datesOfExistence: "1780-1830",
    });
    return { ctxUser, source };
  }

  it("rejects EMPTY choices and leaves the original's fields intact", async () => {
    const { ctxUser, source } = await setupEntity();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const result: any = await action({
      request: splitForm({
        _action: "split",
        reason: "split",
        nameA: "Left",
        nameB: "Right",
        choices: "{}",
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unassigned");

    // Nothing was mutated: the surviving original keeps its fields.
    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, source.id))
      .get();
    expect(after!.wikidataId).toBe("Q123");
    expect(after!.datesOfExistence).toBe("1780-1830");
    expect(after!.displayName).toBe("Conflated Person");
  });

  it("rejects PARTIAL choices (one expected key missing)", async () => {
    const { ctxUser, source } = await setupEntity();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const result: any = await action({
      request: splitForm({
        _action: "split",
        reason: "split",
        nameA: "Left",
        nameB: "Right",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "new",
          // viafId missing
        }),
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unassigned");
  });

  it("rejects \"both\" on an exactly-one-side external-ID key", async () => {
    const { ctxUser, source } = await setupEntity();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.split"
    );
    const result: any = await action({
      request: splitForm({
        _action: "split",
        reason: "split",
        nameA: "Left",
        nameB: "Right",
        choices: JSON.stringify({
          datesOfExistence: "original",
          history: "original",
          wikidataId: "both",
          viafId: "original",
          dbeId: "original",
        }),
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_choice");

    // The identifier was not dropped from either side (no mutation ran).
    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, source.id))
      .get();
    expect(after!.wikidataId).toBe("Q123");
  });
});

describe("merge link ownership + droppedLinks capture (review round 1)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("skips a linkId belonging to a different record and accounts leftBehind from actual moves", async () => {
    const { ctxUser, source, target } = await setupPair();
    const db = drizzle(env.DB);

    // A third entity with its own link — its linkId will be smuggled in.
    const bystander = await createTestEntity({
      id: crypto.randomUUID(),
      displayName: "Bystander",
      sortName: "Bystander",
      entityCode: "ne-bys001",
    });
    const now = Date.now();
    const user2 = await createTestUser({
      email: "second@example.com",
      isAdmin: true,
    });
    const repo2 = await createTestRepository({ code: "REPO2" });
    const descId2 = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId2,
      repositoryId: repo2.id,
      descriptionLevel: "item",
      referenceCode: "BYS-001",
      localIdentifier: "BYS-001",
      title: "Bystander Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user2.id,
      createdAt: now,
      updatedAt: now,
    });
    const foreignLinkId = crypto.randomUUID();
    await db.insert(schema.descriptionEntities).values({
      id: foreignLinkId,
      descriptionId: descId2,
      entityId: bystander.id,
      role: "creator",
      sequence: 0,
      createdAt: now,
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    await action({
      request: form({
        _action: "merge",
        reason: "merge with smuggled link id",
        loserId: source.id,
        survivorId: target.id,
        linkIds: JSON.stringify([foreignLinkId]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);

    // The bystander's link was NOT repointed.
    const foreignLink = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, foreignLinkId))
      .get();
    expect(foreignLink!.entityId).toBe(bystander.id);

    // The ledger row accounts from what actually happened: nothing
    // moved, and the loser's one real link was left behind.
    const op = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .get();
    const detail = JSON.parse(op!.detail as string);
    expect(detail.movedLinks).toBe(0);
    expect(detail.leftBehind).toBe(1);
  });

  it("captures a junction collision in detail.droppedLinks and deletes the loser's row", async () => {
    const { ctxUser, source, target, linkId } = await setupPair();
    const db = drizzle(env.DB);

    // The survivor already carries the SAME (description, role) link —
    // the loser's link collides with the unique index instead of moving.
    const loserLink = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    await db.insert(schema.descriptionEntities).values({
      id: crypto.randomUUID(),
      descriptionId: loserLink!.descriptionId,
      entityId: target.id,
      role: loserLink!.role,
      sequence: 0,
      createdAt: Date.now(),
    });

    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id.merge"
    );
    await action({
      request: form({
        _action: "merge",
        reason: "merge with colliding link",
        loserId: source.id,
        survivorId: target.id,
        linkIds: JSON.stringify([linkId]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);

    // The loser's colliding junction row was deleted, not duplicated.
    const gone = await db
      .select()
      .from(schema.descriptionEntities)
      .where(eq(schema.descriptionEntities.id, linkId))
      .get();
    expect(gone).toBeUndefined();

    // Its full content landed in the ledger's droppedLinks.
    const op = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .get();
    const detail = JSON.parse(op!.detail as string);
    expect(detail.movedLinks).toBe(0);
    expect(detail.droppedLinks).toHaveLength(1);
    expect(detail.droppedLinks[0].id).toBe(linkId);
  });
});

describe("places workbench actions (review round 1)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupPlaces() {
    const user = await createTestUser({ isAdmin: true, name: "Ada Lovelace" });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const repo = await createTestRepository();
    const source = await createTestPlace({
      displayName: "Santafé de Bogotá",
      label: "Santafé de Bogotá",
      placeCode: "nl-src001",
      tgnId: "7016812",
      latitude: 4.6,
      longitude: -74.08,
    });
    const target = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "Bogotá",
      label: "Bogotá",
      placeCode: "nl-tgt001",
    });
    const db = drizzle(env.DB);
    const now = Date.now();
    const descId = crypto.randomUUID();
    await db.insert(schema.descriptions).values({
      tenantId: DEFAULT_TEST_TENANT_ID,
      id: descId,
      repositoryId: repo.id,
      descriptionLevel: "item",
      referenceCode: "PLW-001",
      localIdentifier: "PLW-001",
      title: "Place Item",
      position: 0,
      depth: 0,
      childCount: 0,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    const linkId = crypto.randomUUID();
    await db.insert(schema.descriptionPlaces).values({
      id: linkId,
      descriptionId: descId,
      placeId: source.id,
      role: "mentioned",
      createdAt: now,
    });
    return { ctxUser, source, target, linkId };
  }

  function placeForm(path: string, fields: Record<string, string>): Request {
    return new Request(`http://neogranadina.fisqua.test${path}`, {
      method: "POST",
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  it("place merge reassigns the link, marks the loser merged, writes a reasoned ledger row", async () => {
    const { ctxUser, source, target, linkId } = await setupPlaces();
    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id.merge"
    );
    const db = drizzle(env.DB);

    const redirected: any = await action({
      request: placeForm(`/admin/places/${source.id}/merge`, {
        _action: "merge",
        reason: "same settlement",
        loserId: source.id,
        survivorId: target.id,
        linkIds: JSON.stringify([linkId]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Location")).toBe(
      `/admin/places/${target.id}`,
    );

    const loser = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, source.id))
      .get();
    expect(loser!.mergedInto).toBe(target.id);

    const link = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();
    expect(link!.placeId).toBe(target.id);

    const op = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .get();
    expect(op!.recordType).toBe("place");
    expect(op!.operation).toBe("merge");
    expect(JSON.parse(op!.detail as string).reason).toBe("same settlement");
  });

  it("place split divides coordinates and external ids per choices and moves the link", async () => {
    const { ctxUser, source, linkId } = await setupPlaces();
    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id.split"
    );
    const db = drizzle(env.DB);

    const redirected: any = await action({
      request: placeForm(`/admin/places/${source.id}/split`, {
        _action: "split",
        reason: "conflated settlement and province",
        nameA: "Santafé (ciudad)",
        nameB: "Santafé (provincia)",
        choices: JSON.stringify({
          coordinates: "both",
          tgnId: "new",
          hgisId: "original",
          whgId: "original",
        }),
        linkIds: JSON.stringify([linkId]),
        _updatedAt: String(source.updatedAt),
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("Location")).toBe(
      `/admin/places/${source.id}`,
    );

    const original = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, source.id))
      .get();
    expect(original!.displayName).toBe("Santafé (ciudad)");
    expect(original!.tgnId).toBeNull();
    expect(original!.latitude).toBe(4.6);

    const created = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.displayName, "Santafé (provincia)"))
      .get();
    expect(created).toBeTruthy();
    expect(created!.tgnId).toBe("7016812");
    expect(created!.latitude).toBe(4.6);

    const link = await db
      .select()
      .from(schema.descriptionPlaces)
      .where(eq(schema.descriptionPlaces.id, linkId))
      .get();
    expect(link!.placeId).toBe(created!.id);

    const op = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .get();
    expect(op!.recordType).toBe("place");
    expect(op!.operation).toBe("split");
    expect(JSON.parse(op!.detail as string).reason).toBe(
      "conflated settlement and province",
    );
  });
});

describe("old detail-route merge/split intents are gone (DEFECT 1 regression)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("entities detail action no longer merges on _action=merge", async () => {
    const { ctxUser, source, target } = await setupPair();
    const { action } = await import(
      "../../app/routes/_auth.admin.entities.$id"
    );
    const result: any = await action({
      request: form({
        _action: "merge",
        targetId: target.id,
        linkIds: "[]",
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    // Unknown-action response; no merge performed, no ledger row.
    expect(result).toEqual({ ok: false, error: "generic" });

    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, source.id))
      .get();
    expect(after!.mergedInto).toBeNull();

    const ops = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .all();
    expect(ops).toHaveLength(0);
  });

  it("places detail action no longer merges on _action=merge (nor splits)", async () => {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    const source = await createTestPlace({
      displayName: "Old Place",
      label: "Old Place",
      placeCode: "nl-old001",
    });
    const target = await createTestPlace({
      id: crypto.randomUUID(),
      displayName: "New Place",
      label: "New Place",
      placeCode: "nl-new001",
    });
    const { action } = await import(
      "../../app/routes/_auth.admin.places.$id"
    );

    const mergeResult: any = await action({
      request: new Request("http://neogranadina.fisqua.test/admin/places/x", {
        method: "POST",
        body: new URLSearchParams({
          _action: "merge",
          targetId: target.id,
          linkIds: "[]",
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(mergeResult).toEqual({ ok: false, error: "generic" });

    const splitResult: any = await action({
      request: new Request("http://neogranadina.fisqua.test/admin/places/x", {
        method: "POST",
        body: new URLSearchParams({ _action: "split", linkIds: "[]" }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      context: buildContext(ctxUser),
      params: { id: source.id },
    } as any);
    expect(splitResult).toEqual({ ok: false, error: "generic" });

    const db = drizzle(env.DB);
    const after = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.id, source.id))
      .get();
    expect(after!.mergedInto).toBeNull();

    const ops = await db
      .select()
      .from(schema.authorityOperations)
      .where(eq(schema.authorityOperations.sourceId, source.id))
      .all();
    expect(ops).toHaveLength(0);
  });
});
