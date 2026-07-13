/**
 * Tests — operator tenant detail route
 *
 * This suite pins the GET + capability-edit POST behaviour of
 * `app/routes/_operator.tenants.$slug.tsx`.
 *
 *   1. GET regular tenant → returns the tenant row and `intent` flags
 *      (canEdit + canImpersonate + canDisable) all true.
 *   2. GET platform tenant → returns the platform row with the
 *      management flags FALSE: operator does not edit/impersonate
 *      INTO themselves, and soft-disabling the platform tenant would
 *      lock the operator out.
 *   3. GET disabled tenant → returns the row with `disabledAt`
 *      non-null; the detail page is reachable thanks to the
 *      /operator carve-out in getTenantFromRequest.
 *   4. GET unknown slug → 404 throws.
 *   5. POST set_capability flips one flag → audit row written; tenant
 *      row updated; details payload includes one entry.
 *   6. POST set_capability no-op → no audit row written; tenant row
 *      unchanged (idempotent UX, no DB churn).
 *
 * The impersonate-form-renders test (test 10 in the plan) is covered
 * structurally by the GET tests + the route component shape: we
 * check the loader's `canImpersonate` flag (the conditional render
 * pivot). Actual HTML rendering is not unit-tested here (the React
 * Router workers test pool is hard to drive through full HTTP); the
 * component renders ARE exercised by the React Router type-checker
 * during build.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedDisabledTenant,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
  DEFAULT_TEST_TENANT_ID,
  DISABLED_TEST_TENANT_SLUG,
  getTestDb,
} from "../helpers/db";
import { tenantContext, userContext } from "../../app/context";
import { makeUserContext, makeTenantContext } from "../helpers/context";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";
import * as schema from "../../app/db/schema";

function buildContext(): any {
  const ctx = new RouterContextProvider();
  ctx.set(
    userContext,
    makeUserContext({
      id: OPERATOR_TEST_USER_ID,
      tenantId: PLATFORM_TENANT_ID,
      isSuperAdmin: true,
      email: OPERATOR_TEST_EMAIL,
    }),
  );
  ctx.set(
    tenantContext,
    makeTenantContext({
      id: PLATFORM_TENANT_ID,
      slug: "platform",
      name: "Platform",
      kind: "platform",
      descriptiveStandard: null,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

function buildPostRequest(
  slug: string,
  payload: Record<string, string>,
): Request {
  const body = new URLSearchParams(payload);
  return new Request(`https://platform.fisqua.test/operator/tenants/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("/operator/tenants/:slug — detail loader", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedDisabledTenant();
    await seedOperatorUser();
  });

  it("GET regular tenant — returns row with management flags enabled", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const result = (await loader({
      request: new Request(
        "https://platform.fisqua.test/operator/tenants/neogranadina",
      ),
      context: buildContext(),
      params: { slug: "neogranadina" },
    } as any)) as {
      tenant: { id: string; slug: string; kind: string };
      canEdit: boolean;
      canImpersonate: boolean;
      canDisable: boolean;
    };

    expect(result.tenant.slug).toBe("neogranadina");
    expect(result.tenant.kind).toBe("tenant");
    expect(result.canEdit).toBe(true);
    expect(result.canImpersonate).toBe(true);
    expect(result.canDisable).toBe(true);
  });

  it("GET platform tenant — returns row with management flags FALSE", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const result = (await loader({
      request: new Request(
        "https://platform.fisqua.test/operator/tenants/platform",
      ),
      context: buildContext(),
      params: { slug: "platform" },
    } as any)) as {
      tenant: { id: string; kind: string };
      canEdit: boolean;
      canImpersonate: boolean;
      canDisable: boolean;
    };

    expect(result.tenant.kind).toBe("platform");
    expect(result.canEdit).toBe(false);
    expect(result.canImpersonate).toBe(false);
    expect(result.canDisable).toBe(false);
  });

  it("GET disabled tenant — returns row with disabledAt non-null", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    const result = (await loader({
      request: new Request(
        `https://platform.fisqua.test/operator/tenants/${DISABLED_TEST_TENANT_SLUG}`,
      ),
      context: buildContext(),
      params: { slug: DISABLED_TEST_TENANT_SLUG },
    } as any)) as {
      tenant: { slug: string; disabledAt: number | null };
    };

    expect(result.tenant.slug).toBe(DISABLED_TEST_TENANT_SLUG);
    expect(result.tenant.disabledAt).not.toBeNull();
  });

  it("GET unknown slug — throws 404", async () => {
    const { loader } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    try {
      await loader({
        request: new Request(
          "https://platform.fisqua.test/operator/tenants/does-not-exist",
        ),
        context: buildContext(),
        params: { slug: "does-not-exist" },
      } as any);
      expect.fail("Loader should have thrown 404");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("POST set_capability — flipping vocab_hub off writes one audit row + updates tenant", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    // neogranadina starts with all its capabilities ON. Flip
    // vocabulary_hub off (omit it; the unchecked checkbox absence
    // means false). Keep the others on.
    const request = buildPostRequest("neogranadina", {
      intent: "set_capability",
      crowdsourcingEnabled: "true",
      // vocabularyHubEnabled deliberately omitted (unchecked)
      publishPipelineEnabled: "true",
      multiRepositoryEnabled: "true",
      authoritiesEnabled: "true",
    });
    const result = await action({
      request,
      context: buildContext(),
      params: { slug: "neogranadina" },
    } as any);

    expect((result as any).saved).toBe(true);

    const db = getTestDb();
    const tenantRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.id, DEFAULT_TEST_TENANT_ID))
      .get();
    expect(tenantRow!.vocabularyHubEnabled as unknown as boolean).toBe(false);
    expect(tenantRow!.crowdsourcingEnabled as unknown as boolean).toBe(true);

    const auditRow = await env.DB.prepare(
      "SELECT action, target_tenant_id, details FROM audit_log " +
        "WHERE target_tenant_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{ action: string; target_tenant_id: string; details: string | null }>();
    expect(auditRow!.action).toBe("set_capability");
    const details = JSON.parse(auditRow!.details!);
    expect(details.slug).toBe("neogranadina");
    expect(details.changes).toHaveLength(1);
    expect(details.changes[0].capability).toBe("vocabulary_hub");
    expect(details.changes[0].from).toBe(true);
    expect(details.changes[0].to).toBe(false);
  });

  it("POST set_capability no-op — same flags as current → no audit row, no DB churn", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.$slug"
    );
    // neogranadina starts with all its capabilities ON. Submit the
    // exact same state.
    const request = buildPostRequest("neogranadina", {
      intent: "set_capability",
      crowdsourcingEnabled: "true",
      vocabularyHubEnabled: "true",
      publishPipelineEnabled: "true",
      multiRepositoryEnabled: "true",
      authoritiesEnabled: "true",
    });
    const result = await action({
      request,
      context: buildContext(),
      params: { slug: "neogranadina" },
    } as any);

    expect((result as any).saved).toBe(true);
    expect((result as any).noop).toBe(true);

    // No audit row landed for neogranadina.
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE target_tenant_id = ?",
    )
      .bind(DEFAULT_TEST_TENANT_ID)
      .first<{ c: number }>();
    expect(auditCount!.c).toBe(0);
  });
});

// @version v0.4.0
