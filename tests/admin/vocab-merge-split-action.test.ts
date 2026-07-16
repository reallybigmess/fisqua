/**
 * Tests — vocabulary functions detail action (merge / split) + search loader
 *
 * This suite drives real `FormData` through the `_auth.admin.
 * vocabularies.functions.$id` route action and the sibling
 * `_auth.admin.vocabularies.functions` search loader, exercising the
 * server contract the shared admin MergeDialog/SplitDialog emit
 * (audit items 4 + 9, Path B consolidation).
 *
 * What it pins:
 *   - merge: source term is deprecated + `mergedInto`=target, selected
 *     entities are reassigned to the target, counts denormalise, a
 *     changelog row is written, and the action redirects to the target.
 *   - split: a new term is created from `newName`, selected entities move
 *     to it, the source retains the rest, and the action redirects to the
 *     new term. `newName` is required.
 *   - field-spelling alias: the action accepts BOTH `intent` (legacy) and
 *     `_action` (shared-dialog spelling) for the merge/split discriminator.
 *   - search: the functions loader answers BOTH `?intent=search-terms`
 *     (legacy) and `?_search=true` (shared MergeDialog) with the same
 *     JSON row shape, and the query stays GLOBAL (no tenant predicate on
 *     vocabulary_terms — shared-by-design).
 *
 * Harness mirrors `tests/admin/vocab-capability.test.ts`: a
 * `RouterContextProvider` carrying userContext + tenantContext with
 * `cloudflare.env` attached, plus a real users row so the changelog FK
 * (`user_id NOT NULL REFERENCES users(id)`) is satisfiable.
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
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestEntity } from "../helpers/entities";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/_auth.admin.vocabularies.functions.$id";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

function form(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request(
    "http://neogranadina.fisqua.test/admin/vocabularies/functions/x",
    {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
}

async function seedTerm(overrides: {
  id: string;
  canonical: string;
  category?: string | null;
  status?: string;
  entityCount?: number;
}) {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(schema.vocabularyTerms).values({
    id: overrides.id,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    canonical: overrides.canonical,
    category: overrides.category ?? null,
    status: (overrides.status ?? "approved") as "approved",
    entityCount: overrides.entityCount ?? 0,
    createdAt: now,
    updatedAt: now,
  });
}

describe("vocabulary functions detail action — merge", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupMerge() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    await seedTerm({ id: "term-src", canonical: "Notario", entityCount: 1 });
    await seedTerm({ id: "term-tgt", canonical: "Escribano", entityCount: 0 });
    const entity = await createTestEntity({
      entityCode: "ne-mrg001",
      displayName: "Linked One",
    });
    const db = drizzle(env.DB);
    await db
      .update(schema.entities)
      .set({ primaryFunctionId: "term-src" })
      .where(eq(schema.entities.id, entity.id));
    return { ctxUser, entity };
  }

  it("merge (intent=merge) deprecates source, reassigns entity, redirects", async () => {
    const { ctxUser, entity } = await setupMerge();
    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    const db = drizzle(env.DB);

    let redirected: Response | null = null;
    try {
      await action({
        request: form({
          intent: "merge",
          targetId: "term-tgt",
          linkIds: JSON.stringify([entity.id]),
        }),
        context: buildContext(ctxUser),
        params: { id: "term-src" },
      } as any);
      expect.fail("merge action should have thrown a redirect");
    } catch (e) {
      redirected = e as Response;
    }
    expect(redirected).toBeInstanceOf(Response);
    expect(redirected!.status).toBe(302);
    expect(redirected!.headers.get("Location")).toBe(
      "/admin/vocabularies/functions/term-tgt",
    );

    const src = await db
      .select()
      .from(schema.vocabularyTerms)
      .where(eq(schema.vocabularyTerms.id, "term-src"))
      .get();
    expect(src!.mergedInto).toBe("term-tgt");
    expect(src!.status).toBe("deprecated");

    const movedEntity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entity.id))
      .get();
    expect(movedEntity!.primaryFunctionId).toBe("term-tgt");

    const tgt = await db
      .select()
      .from(schema.vocabularyTerms)
      .where(eq(schema.vocabularyTerms.id, "term-tgt"))
      .get();
    expect(tgt!.entityCount).toBe(1);

    const log = await db
      .select()
      .from(schema.changelog)
      .where(eq(schema.changelog.recordId, "term-src"))
      .all();
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it("merge accepts the _action alias identically to intent", async () => {
    const { ctxUser, entity } = await setupMerge();
    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    const db = drizzle(env.DB);

    let redirected: Response | null = null;
    try {
      await action({
        request: form({
          _action: "merge",
          targetId: "term-tgt",
          linkIds: JSON.stringify([entity.id]),
        }),
        context: buildContext(ctxUser),
        params: { id: "term-src" },
      } as any);
      expect.fail("merge action should have thrown a redirect");
    } catch (e) {
      redirected = e as Response;
    }
    expect(redirected!.status).toBe(302);

    const src = await db
      .select()
      .from(schema.vocabularyTerms)
      .where(eq(schema.vocabularyTerms.id, "term-src"))
      .get();
    expect(src!.mergedInto).toBe("term-tgt");
    expect(src!.status).toBe("deprecated");
    const movedEntity = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, entity.id))
      .get();
    expect(movedEntity!.primaryFunctionId).toBe("term-tgt");
  });
});

describe("vocabulary functions detail action — split", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function setupSplit() {
    const user = await createTestUser({ isAdmin: true });
    const ctxUser = makeUserContext({ id: user.id, isAdmin: true });
    await seedTerm({
      id: "term-a",
      canonical: "Alcalde",
      category: "civil_office",
      entityCount: 2,
    });
    const e1 = await createTestEntity({
      entityCode: "ne-spl001",
      displayName: "Split One",
    });
    const e2 = await createTestEntity({
      entityCode: "ne-spl002",
      displayName: "Split Two",
    });
    const db = drizzle(env.DB);
    await db
      .update(schema.entities)
      .set({ primaryFunctionId: "term-a" })
      .where(eq(schema.entities.id, e1.id));
    await db
      .update(schema.entities)
      .set({ primaryFunctionId: "term-a" })
      .where(eq(schema.entities.id, e2.id));
    return { ctxUser, e1, e2 };
  }

  it("split (intent=split) creates a new term, moves the selected entity, redirects", async () => {
    const { ctxUser, e1, e2 } = await setupSplit();
    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    const db = drizzle(env.DB);

    let redirected: Response | null = null;
    try {
      await action({
        request: form({
          intent: "split",
          newName: "Alcalde de primer voto",
          linkIds: JSON.stringify([e1.id]),
        }),
        context: buildContext(ctxUser),
        params: { id: "term-a" },
      } as any);
      expect.fail("split action should have thrown a redirect");
    } catch (e) {
      redirected = e as Response;
    }
    expect(redirected).toBeInstanceOf(Response);
    expect(redirected!.status).toBe(302);
    const loc = redirected!.headers.get("Location")!;
    expect(loc.startsWith("/admin/vocabularies/functions/")).toBe(true);
    const newId = loc.split("/").pop()!;
    expect(newId).not.toBe("term-a");

    const newTerm = await db
      .select()
      .from(schema.vocabularyTerms)
      .where(eq(schema.vocabularyTerms.id, newId))
      .get();
    expect(newTerm!.canonical).toBe("Alcalde de primer voto");
    expect(newTerm!.category).toBe("civil_office");

    const movedE1 = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, e1.id))
      .get();
    expect(movedE1!.primaryFunctionId).toBe(newId);

    const stayedE2 = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, e2.id))
      .get();
    expect(stayedE2!.primaryFunctionId).toBe("term-a");
  });

  it("split accepts the _action alias identically to intent", async () => {
    const { ctxUser, e1 } = await setupSplit();
    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    const db = drizzle(env.DB);

    let redirected: Response | null = null;
    try {
      await action({
        request: form({
          _action: "split",
          newName: "Alcalde de segundo voto",
          linkIds: JSON.stringify([e1.id]),
        }),
        context: buildContext(ctxUser),
        params: { id: "term-a" },
      } as any);
      expect.fail("split action should have thrown a redirect");
    } catch (e) {
      redirected = e as Response;
    }
    expect(redirected!.status).toBe(302);
    const newId = redirected!.headers.get("Location")!.split("/").pop()!;
    const newTerm = await db
      .select()
      .from(schema.vocabularyTerms)
      .where(eq(schema.vocabularyTerms.id, newId))
      .get();
    expect(newTerm!.canonical).toBe("Alcalde de segundo voto");
  });

  it("split requires newName (returns an error, no redirect)", async () => {
    const { ctxUser, e1 } = await setupSplit();
    const { action } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions.$id"
    );
    const result = (await action({
      request: form({
        intent: "split",
        newName: "",
        linkIds: JSON.stringify([e1.id]),
      }),
      context: buildContext(ctxUser),
      params: { id: "term-a" },
    } as any)) as any;
    expect(result).toBeDefined();
    expect("error" in result).toBe(true);
  });
});

describe("vocabulary functions search loader", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedSearchable() {
    const user = await createTestUser({ isAdmin: true });
    await seedTerm({ id: "s-1", canonical: "Notario público" });
    await seedTerm({ id: "s-2", canonical: "Escribano" });
    return makeUserContext({ id: user.id, isAdmin: true });
  }

  function searchRequest(query: string): Request {
    return new Request(
      `http://neogranadina.fisqua.test/admin/vocabularies/functions?${query}`,
    );
  }

  it("answers the legacy ?intent=search-terms search", async () => {
    const ctxUser = await seedSearchable();
    const { loader } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions"
    );
    const res = (await loader({
      request: searchRequest("intent=search-terms&q=Notario&exclude=other"),
      context: buildContext(ctxUser),
      params: {},
    } as any)) as Response;
    expect(res).toBeInstanceOf(Response);
    const rows = (await res.json()) as { id: string; displayName: string }[];
    expect(rows.some((r) => r.displayName === "Notario público")).toBe(true);
    expect(rows.some((r) => r.displayName === "Escribano")).toBe(false);
  });

  it("answers the shared-dialog ?_search=true search identically", async () => {
    const ctxUser = await seedSearchable();
    const { loader } = await import(
      "../../app/routes/_auth.admin.vocabularies.functions"
    );
    const res = (await loader({
      request: searchRequest("_search=true&q=Notario&exclude=other"),
      context: buildContext(ctxUser),
      params: {},
    } as any)) as Response;
    expect(res).toBeInstanceOf(Response);
    const rows = (await res.json()) as { id: string; displayName: string }[];
    expect(rows.some((r) => r.displayName === "Notario público")).toBe(true);
    expect(rows.some((r) => r.displayName === "Escribano")).toBe(false);
  });
});
