/**
 * Tests — vocabulary review queue federation scoping
 *
 * This suite pins the `_auth.admin.vocabularies.review` loader's
 * visibility rule after migration 0045 lifted vocabulary_terms to
 * FEDERATION scope: a proposed term surfaces in its own federation only,
 * keyed by `vocabulary_terms.federation_id`. This supersedes the former
 * proposer-tenant visibility rule (and its orphan-visible-everywhere
 * fallback): an orphan proposal — proposedBy set-null after a user
 * deletion — still carries a federation_id, so it stays visible in that
 * federation and nowhere else.
 *
 * The vocabulary is shared within a federation by design; this scoping
 * covers the pre-approval review queue, where the proposer name is still
 * surfaced for attribution.
 *
 * @version v0.4.2
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
  SECOND_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  SECOND_TEST_FEDERATION_ID,
} from "../helpers/db";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/_auth.admin.vocabularies.review";

function buildContext(user: User): any {
  const isSecond = user.tenantId === SECOND_TEST_TENANT_ID;
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: user.tenantId,
      slug: isSecond ? "second-tenant" : "neogranadina",
      federationId: isSecond
        ? SECOND_TEST_FEDERATION_ID
        : DEFAULT_TEST_FEDERATION_ID,
      vocabularyHubEnabled: true,
      crowdsourcingEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: true,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function seedProposals() {
  const db = drizzle(env.DB);
  const now = Date.now();

  const proposerA = crypto.randomUUID();
  const proposerB = crypto.randomUUID();
  await db.insert(schema.users).values([
    {
      id: proposerA,
      tenantId: DEFAULT_TEST_TENANT_ID,
      email: "proposer-a@example.test",
      name: "Proposer A",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: proposerB,
      tenantId: SECOND_TEST_TENANT_ID,
      email: "proposer-b@example.test",
      name: "Proposer B",
      isAdmin: false,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  await db.insert(schema.vocabularyTerms).values([
    {
      id: "term-fed-a",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Escribano propuesto A",
      status: "proposed",
      proposedBy: proposerA,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "term-fed-b",
      federationId: SECOND_TEST_FEDERATION_ID,
      canonical: "Notario propuesto B",
      status: "proposed",
      proposedBy: proposerB,
      createdAt: now,
      updatedAt: now,
    },
    {
      // Orphan (proposedBy null) that still belongs to federation A.
      id: "term-orphan-a",
      federationId: DEFAULT_TEST_FEDERATION_ID,
      canonical: "Término huérfano",
      status: "proposed",
      proposedBy: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

async function runLoader(user: User) {
  const { loader } = await import(
    "../../app/routes/_auth.admin.vocabularies.review"
  );
  return (await loader({
    request: new Request(
      "http://catalogacion.zasqua.org/admin/vocabularies/review",
    ),
    context: buildContext(user),
    params: {},
  } as any)) as any;
}

describe("vocabulary review queue federation scoping", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedProposals();
  });

  it("shows a federation its own proposals with proposer name, plus orphans in that federation", async () => {
    const adminA = makeUserContext({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const res = await runLoader(adminA);

    const ids = res.terms.map((t: any) => t.id).sort();
    expect(ids).toEqual(["term-fed-a", "term-orphan-a"]);
    expect(res.total).toBe(2);

    const own = res.terms.find((t: any) => t.id === "term-fed-a");
    expect(own.proposedByName).toBe("Proposer A");
  });

  it("does not leak another federation's proposals or proposer names", async () => {
    const adminB = makeUserContext({
      tenantId: SECOND_TEST_TENANT_ID,
      isAdmin: true,
    });
    const res = await runLoader(adminB);

    const ids = res.terms.map((t: any) => t.id).sort();
    expect(ids).toEqual(["term-fed-b"]);
    expect(res.total).toBe(1);
    expect(
      res.terms.some((t: any) => t.proposedByName === "Proposer A"),
    ).toBe(false);
  });

  it("keeps orphan proposals visible in their federation without proposer attribution", async () => {
    const adminA = makeUserContext({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const res = await runLoader(adminA);

    const orphan = res.terms.find((t: any) => t.id === "term-orphan-a");
    expect(orphan).toBeDefined();
    expect(orphan.proposedByName).toBeNull();
  });
});
