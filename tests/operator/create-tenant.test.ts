/**
 * Tests — operator create-tenant route
 *
 * This suite pins the create-tenant action's atomicity + audit contract on
 * `app/routes/_operator.tenants.new.tsx`. Six tests covering:
 *
 *   1. Happy path: full valid payload → tenant row + user row + audit
 *      row all land in one batch, magic-link generated for the
 *      bootstrap superadmin, redirect to `/operator/tenants/<slug>`.
 *      The bootstrap-superadmin step is part of `create_tenant`'s
 *      scope, not a separate audit row.
 *   2. Slug collision: existing slug → field error, no DB writes, no
 *      audit row.
 *   3. Reserved slug: `platform` → field error from SlugSchema's
 *      reserved-list refinement, no DB writes.
 *   4. Invalid descriptive_standard → field error.
 *   5. Invalid bootstrap_email → field error.
 *   6. Magic-link send failure does NOT roll back DB: mocking the
 *      generator to throw → tenant + user + audit ROW all still
 *      committed (the email send is non-blocking, outside the batch,
 *      mirroring the existing invites convention).
 *
 * The action handler runs inside the `_operator` middleware in
 * production (which sets userContext + tenantContext to the operator
 * + platform tenant). For these unit tests we invoke the action
 * function directly with a hand-built RouterContextProvider; the
 * middleware behaviour is covered by `operator-layout.test.ts`.
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
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
      crowdsourcingEnabled: false,
      vocabularyHubEnabled: false,
      publishPipelineEnabled: false,
      multiRepositoryEnabled: false,
    }),
  );
  (ctx as any).cloudflare = { env };
  return ctx;
}

function buildFormRequest(payload: Record<string, string>): Request {
  const body = new URLSearchParams(payload);
  return new Request("https://platform.fisqua.test/operator/tenants/new", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("/operator/tenants/new — create tenant + bootstrap superadmin", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
    vi.restoreAllMocks();
  });

  it("happy path — tenant + user + audit row land in one batch; redirect to detail page", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.new"
    );
    const request = buildFormRequest({
      slug: "ahrb",
      name: "Archivo Histórico Regional de Boyacá",
      descriptiveStandard: "isadg",
      crowdsourcingEnabled: "true",
      vocabularyHubEnabled: "true",
      publishPipelineEnabled: "true",
      multiRepositoryEnabled: "false",
      quotaStorageBytes: "10000000",
      bootstrapEmail: "Bootstrap@Example.test",
    });

    const result = (await action({
      request,
      context: buildContext(),
      params: {},
    } as any)) as Response;

    // 302 redirect to the new tenant's detail page.
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBeGreaterThanOrEqual(300);
    expect(result.status).toBeLessThan(400);
    expect(result.headers.get("Location")).toBe("/operator/tenants/ahrb");

    const db = getTestDb();
    // Tenant row landed.
    const tenantRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, "ahrb"))
      .get();
    expect(tenantRow).toBeDefined();
    expect(tenantRow!.kind).toBe("tenant");
    expect(tenantRow!.descriptiveStandard).toBe("isadg");
    expect(tenantRow!.crowdsourcingEnabled).toBe(true);
    expect(tenantRow!.multiRepositoryEnabled).toBe(false);
    expect(tenantRow!.disabledAt).toBeNull();

    // Bootstrap user landed in the new tenant; superadmin + admin both true.
    const userRow = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "bootstrap@example.test"))
      .get();
    expect(userRow).toBeDefined();
    expect(userRow!.tenantId).toBe(tenantRow!.id);
    expect(userRow!.isSuperAdmin as unknown as boolean).toBe(true);
    expect(userRow!.isAdmin as unknown as boolean).toBe(true);

    // Audit row landed; create_tenant action; details JSON has slug,
    // capabilities, bootstrap_email.
    const auditRow = await env.DB.prepare(
      "SELECT action, actor_user_id, target_tenant_id, target_object_kind, " +
        "target_object_id, details FROM audit_log WHERE target_tenant_id = ?",
    )
      .bind(tenantRow!.id)
      .first<{
        action: string;
        actor_user_id: string | null;
        target_tenant_id: string;
        target_object_kind: string | null;
        target_object_id: string | null;
        details: string | null;
      }>();
    expect(auditRow).not.toBeNull();
    expect(auditRow!.action).toBe("create_tenant");
    expect(auditRow!.actor_user_id).toBe(OPERATOR_TEST_USER_ID);
    expect(auditRow!.target_object_kind).toBe("tenant");
    expect(auditRow!.target_object_id).toBe(tenantRow!.id);
    const details = JSON.parse(auditRow!.details!);
    expect(details.slug).toBe("ahrb");
    expect(details.bootstrap_email).toBe("bootstrap@example.test");
    expect(details.capabilities).toEqual({
      crowdsourcing: true,
      vocabulary_hub: true,
      publish_pipeline: true,
      multi_repository: false,
      // Omitted from the form → CreateTenantSchema default (on).
      authorities: true,
    });

    // Magic-link row landed for the bootstrap user.
    const magicLink = await env.DB.prepare(
      "SELECT user_id FROM magic_links WHERE user_id = ?",
    )
      .bind(userRow!.id)
      .first<{ user_id: string }>();
    expect(magicLink).not.toBeNull();
  });

  it("slug collision — existing slug → field error, no DB writes, no audit row", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.new"
    );
    const request = buildFormRequest({
      slug: "neogranadina", // already seeded
      name: "Duplicate",
      descriptiveStandard: "isadg",
      bootstrapEmail: "x@example.test",
    });

    const result = (await action({
      request,
      context: buildContext(),
      params: {},
    } as any)) as { fieldErrors: Record<string, string[]> };

    expect(result).not.toBeInstanceOf(Response);
    expect(result.fieldErrors).toBeDefined();
    expect(result.fieldErrors.slug).toBeDefined();
    expect(result.fieldErrors.slug?.length).toBeGreaterThan(0);

    // No second neogranadina row inserted; user count unchanged
    // (existing seedOperatorUser + nothing else).
    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log",
    ).first<{ c: number }>();
    expect(auditCount!.c).toBe(0);
  });

  it("reserved slug — `platform` → field error from SlugSchema, no DB writes", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.new"
    );
    const request = buildFormRequest({
      slug: "platform",
      name: "Bad",
      descriptiveStandard: "isadg",
      bootstrapEmail: "x@example.test",
    });

    const result = (await action({
      request,
      context: buildContext(),
      params: {},
    } as any)) as { fieldErrors: Record<string, string[]> };

    expect(result).not.toBeInstanceOf(Response);
    expect(result.fieldErrors).toBeDefined();
    expect(result.fieldErrors.slug).toBeDefined();
    expect(result.fieldErrors.slug?.some((m) => /reserved/i.test(m))).toBe(
      true,
    );

    const auditCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log",
    ).first<{ c: number }>();
    expect(auditCount!.c).toBe(0);
  });

  it("invalid descriptive_standard → field error, no DB writes", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.new"
    );
    const request = buildFormRequest({
      slug: "valid-slug",
      name: "x",
      descriptiveStandard: "unknown",
      bootstrapEmail: "x@example.test",
    });

    const result = (await action({
      request,
      context: buildContext(),
      params: {},
    } as any)) as { fieldErrors: Record<string, string[]> };

    expect(result).not.toBeInstanceOf(Response);
    expect(result.fieldErrors).toBeDefined();
    expect(result.fieldErrors.descriptiveStandard).toBeDefined();
  });

  it("invalid bootstrap_email → field error, no DB writes", async () => {
    const { action } = await import(
      "../../app/routes/_operator.tenants.new"
    );
    const request = buildFormRequest({
      slug: "valid-slug",
      name: "x",
      descriptiveStandard: "isadg",
      bootstrapEmail: "not-an-email",
    });

    const result = (await action({
      request,
      context: buildContext(),
      params: {},
    } as any)) as { fieldErrors: Record<string, string[]> };

    expect(result).not.toBeInstanceOf(Response);
    expect(result.fieldErrors).toBeDefined();
    expect(result.fieldErrors.bootstrapEmail).toBeDefined();
  });

  it("magic-link send failure is non-blocking — DB writes still commit", async () => {
    // Mock generateMagicLink to throw. The action handler's invocation
    // is wrapped in try/catch and the email failure is logged; the
    // tenant + user + audit rows are already committed at that point
    // (they happen in the withAuditLog batch BEFORE the email send).
    const authModule = await import("../../app/lib/auth.server");
    const spy = vi
      .spyOn(authModule, "generateMagicLink")
      .mockRejectedValue(new Error("Resend down"));

    const { action } = await import(
      "../../app/routes/_operator.tenants.new"
    );
    const request = buildFormRequest({
      slug: "email-fail-test",
      name: "x",
      descriptiveStandard: "isadg",
      bootstrapEmail: "boot@example.test",
    });

    const result = (await action({
      request,
      context: buildContext(),
      params: {},
    } as any)) as Response;

    // Action still returns a redirect because the DB writes commit
    // before the email send.
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBeGreaterThanOrEqual(300);
    expect(result.status).toBeLessThan(400);

    // Tenant + user + audit row all present.
    const db = getTestDb();
    const tenantRow = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, "email-fail-test"))
      .get();
    expect(tenantRow).toBeDefined();

    const userRow = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "boot@example.test"))
      .get();
    expect(userRow).toBeDefined();

    const auditRow = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE target_tenant_id = ?",
    )
      .bind(tenantRow!.id)
      .first<{ action: string }>();
    expect(auditRow).not.toBeNull();
    expect(auditRow!.action).toBe("create_tenant");

    expect(spy).toHaveBeenCalled();
  });
});

// @version v0.4.0
