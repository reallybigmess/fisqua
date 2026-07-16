/**
 * Tests — withAuditLog wrapper
 *
 * This suite pins the atomicity contract of `app/lib/audit.server.ts`:
 *
 *   1. Happy path — the audit row and the work statement(s) land in
 *      one D1 batch; the wrapper returns whatever the inner `fn`'s
 *      `result` field carries.
 *   2. Work failure rolls back audit — when a work statement violates
 *      a CHECK, the entire batch fails and no audit row is visible.
 *   3. Audit failure rolls back work — when the audit insert violates
 *      its CHECK (action enum), the entire batch fails and the work
 *      did not happen either.
 *   4. `details: null` writes SQL NULL — not the string `"null"` —
 *      to the audit_log.details column.
 *   5. Optional fields default to NULL — omitted
 *      `impersonationSessionId` and `targetTenantId` land as NULL.
 *   6. `now` override — when the caller passes `now`, the audit row's
 *      created_at column equals that value verbatim.
 *
 * The harness uses cleanDatabase() + seedTenants() + seedOperatorUser()
 * so each test starts with the platform/neogranadina/second-tenant
 * tenant rows + the platform-tenant operator user that real audit
 * rows will reference. The denormalised actor_user_id_text column
 * is exercised on every test; the FK actor_user_id is set on the
 * happy path to confirm the FK reference resolves.
 *
 * @version v0.4.0
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  OPERATOR_TEST_EMAIL,
} from "../helpers/db";
import {
  PLATFORM_TENANT_ID,
  NEOGRANADINA_TENANT_ID,
} from "../../app/lib/tenant";
import { withAuditLog } from "../../app/lib/audit.server";

describe("withAuditLog", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
    db = drizzle(env.DB, { schema });
  });

  it("happy path — audit row + work land in one batch; result is returned", async () => {
    const newTenantId = crypto.randomUUID();
    const result = await withAuditLog(
      db,
      {
        action: "create_tenant",
        actorUserId: OPERATOR_TEST_USER_ID,
        actorUserIdText: OPERATOR_TEST_EMAIL,
        actorTenantId: PLATFORM_TENANT_ID,
        targetTenantId: newTenantId,
        targetObjectKind: "tenant",
        targetObjectId: newTenantId,
        details: { slug: "foo", note: "happy path" },
      },
      async (txDb) => {
        // Build a Drizzle insert as the work statement.
        const insertTenant = txDb
          .insert(schema.tenants)
          .values({
            id: newTenantId,
            slug: "foo",
            name: "Foo",
            kind: "tenant",
            descriptiveStandard: "isadg",
            status: "active",
            crowdsourcingEnabled: false,
            vocabularyHubEnabled: true,
            publishPipelineEnabled: true,
            multiRepositoryEnabled: false,
            quotaStorageBytes: null,
            // federation_id is DB-nullable (migration 0044); NULL is
            // FK-exempt. schema.ts types it `.notNull()`, hence the cast.
            federationId: null as unknown as string,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        return { workStatements: [insertTenant], result: newTenantId };
      },
    );

    expect(result).toBe(newTenantId);

    // Tenant row landed.
    const tenantRow = await env.DB.prepare(
      "SELECT id, slug, name FROM tenants WHERE id = ?",
    )
      .bind(newTenantId)
      .first<{ id: string; slug: string; name: string }>();
    expect(tenantRow).not.toBeNull();
    expect(tenantRow!.slug).toBe("foo");

    // Audit row landed; details JSON-stringified per the helper's
    // documented convention.
    const auditRow = await env.DB.prepare(
      "SELECT action, actor_user_id, actor_user_id_text, actor_tenant_id, " +
        "target_tenant_id, target_object_kind, target_object_id, " +
        "impersonation_session_id, details FROM audit_log " +
        "WHERE target_tenant_id = ?",
    )
      .bind(newTenantId)
      .first<{
        action: string;
        actor_user_id: string | null;
        actor_user_id_text: string;
        actor_tenant_id: string;
        target_tenant_id: string | null;
        target_object_kind: string | null;
        target_object_id: string | null;
        impersonation_session_id: string | null;
        details: string | null;
      }>();
    expect(auditRow).not.toBeNull();
    expect(auditRow!.action).toBe("create_tenant");
    expect(auditRow!.actor_user_id).toBe(OPERATOR_TEST_USER_ID);
    expect(auditRow!.actor_user_id_text).toBe(OPERATOR_TEST_EMAIL);
    expect(auditRow!.actor_tenant_id).toBe(PLATFORM_TENANT_ID);
    expect(auditRow!.target_tenant_id).toBe(newTenantId);
    expect(auditRow!.target_object_kind).toBe("tenant");
    expect(auditRow!.target_object_id).toBe(newTenantId);
    expect(auditRow!.impersonation_session_id).toBeNull();
    expect(JSON.parse(auditRow!.details!)).toEqual({
      slug: "foo",
      note: "happy path",
    });
  });

  it("rollback on work failure — work CHECK violation prevents audit row from landing", async () => {
    const auditCountBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log",
    ).first<{ c: number }>();

    // Slug GLOB CHECK rejects uppercase letters: 'BAD-UPPERCASE'.
    await expect(
      withAuditLog(
        db,
        {
          action: "create_tenant",
          actorUserId: OPERATOR_TEST_USER_ID,
          actorUserIdText: OPERATOR_TEST_EMAIL,
          actorTenantId: PLATFORM_TENANT_ID,
          targetObjectKind: "tenant",
          details: { slug: "BAD-UPPERCASE" },
        },
        async (txDb) => {
          const badInsert = txDb.insert(schema.tenants).values({
            id: crypto.randomUUID(),
            slug: "BAD-UPPERCASE",
            name: "x",
            kind: "tenant",
            descriptiveStandard: "isadg",
            status: "active",
            crowdsourcingEnabled: false,
            vocabularyHubEnabled: true,
            publishPipelineEnabled: true,
            multiRepositoryEnabled: false,
            quotaStorageBytes: null,
            // federation_id is DB-nullable (migration 0044); NULL is
            // FK-exempt. schema.ts types it `.notNull()`, hence the cast.
            federationId: null as unknown as string,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          return { workStatements: [badInsert], result: "should-not-return" };
        },
      ),
    ).rejects.toThrow();

    // Bad tenant absent.
    const badRow = await env.DB.prepare(
      "SELECT id FROM tenants WHERE slug = 'BAD-UPPERCASE'",
    ).first();
    expect(badRow).toBeNull();

    // Audit count unchanged.
    const auditCountAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM audit_log",
    ).first<{ c: number }>();
    expect(auditCountAfter!.c).toBe(auditCountBefore!.c);
  });

  it("rollback on audit failure — invalid action enum prevents work from landing", async () => {
    const newTenantId = crypto.randomUUID();
    const tenantsBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM tenants",
    ).first<{ c: number }>();

    await expect(
      withAuditLog(
        db,
        {
          // Force a CHECK violation on audit_log.action by lying via
          // `as any`. The runtime enum CHECK rejects; the batch fails;
          // the work tenant insert does not land.
          action: "not_a_real_action" as any,
          actorUserId: OPERATOR_TEST_USER_ID,
          actorUserIdText: OPERATOR_TEST_EMAIL,
          actorTenantId: PLATFORM_TENANT_ID,
          targetTenantId: newTenantId,
          details: { slug: "qux" },
        },
        async (txDb) => {
          const insertTenant = txDb.insert(schema.tenants).values({
            id: newTenantId,
            slug: "qux",
            name: "Qux",
            kind: "tenant",
            descriptiveStandard: "isadg",
            status: "active",
            crowdsourcingEnabled: false,
            vocabularyHubEnabled: true,
            publishPipelineEnabled: true,
            multiRepositoryEnabled: false,
            quotaStorageBytes: null,
            // federation_id is DB-nullable (migration 0044); NULL is
            // FK-exempt. schema.ts types it `.notNull()`, hence the cast.
            federationId: null as unknown as string,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          return { workStatements: [insertTenant], result: newTenantId };
        },
      ),
    ).rejects.toThrow();

    const tenantRow = await env.DB.prepare(
      "SELECT id FROM tenants WHERE id = ?",
    )
      .bind(newTenantId)
      .first();
    expect(tenantRow).toBeNull();

    const tenantsAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM tenants",
    ).first<{ c: number }>();
    expect(tenantsAfter!.c).toBe(tenantsBefore!.c);
  });

  it("details=null writes SQL NULL, not the string 'null'", async () => {
    const probeId = crypto.randomUUID();
    await withAuditLog(
      db,
      {
        action: "set_capability",
        actorUserId: OPERATOR_TEST_USER_ID,
        actorUserIdText: OPERATOR_TEST_EMAIL,
        actorTenantId: PLATFORM_TENANT_ID,
        targetTenantId: NEOGRANADINA_TENANT_ID,
        targetObjectKind: "capability",
        targetObjectId: "crowdsourcing",
        details: null,
      },
      async (txDb) => {
        // Use a Drizzle query builder (un-awaited) so the work
        // composes into the batch alongside the audit insert. Insert
        // into magic_links — a side-table the helper itself never
        // writes — using the seeded operator user as the FK target.
        const stmt = txDb.insert(schema.magicLinks).values({
          id: probeId,
          token: "tok-" + probeId,
          userId: OPERATOR_TEST_USER_ID,
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
        });
        return { workStatements: [stmt], result: probeId };
      },
    );

    const row = await env.DB.prepare(
      "SELECT details FROM audit_log WHERE target_object_id = 'crowdsourcing' AND target_tenant_id = ?",
    )
      .bind(NEOGRANADINA_TENANT_ID)
      .first<{ details: string | null }>();
    expect(row).not.toBeNull();
    // SQL NULL — not the four-character string "null".
    expect(row!.details).toBeNull();
  });

  it("optional fields default to NULL when omitted", async () => {
    // Omit both targetTenantId and impersonationSessionId; assert
    // both columns are SQL NULL on the resulting row. action=
    // 'reset_superadmin' is a real enum value and does not require
    // any specific target shape.
    await withAuditLog(
      db,
      {
        action: "reset_superadmin",
        actorUserId: OPERATOR_TEST_USER_ID,
        actorUserIdText: OPERATOR_TEST_EMAIL,
        actorTenantId: PLATFORM_TENANT_ID,
        details: { reason: "minimal envelope" },
      },
      async () => {
        // No work — empty workStatements array. The wrapper still
        // composes a single-statement batch (audit insert only).
        return { workStatements: [], result: undefined };
      },
    );

    const row = await env.DB.prepare(
      "SELECT target_tenant_id, target_object_kind, target_object_id, " +
        "impersonation_session_id FROM audit_log " +
        "WHERE action = 'reset_superadmin' ORDER BY created_at DESC LIMIT 1",
    ).first<{
      target_tenant_id: string | null;
      target_object_kind: string | null;
      target_object_id: string | null;
      impersonation_session_id: string | null;
    }>();
    expect(row).not.toBeNull();
    expect(row!.target_tenant_id).toBeNull();
    expect(row!.target_object_kind).toBeNull();
    expect(row!.target_object_id).toBeNull();
    expect(row!.impersonation_session_id).toBeNull();
  });

  it("now override — created_at equals the caller-supplied epoch-ms verbatim", async () => {
    const fixedNow = 1_234_567_890;
    await withAuditLog(
      db,
      {
        action: "soft_disable_tenant",
        actorUserId: OPERATOR_TEST_USER_ID,
        actorUserIdText: OPERATOR_TEST_EMAIL,
        actorTenantId: PLATFORM_TENANT_ID,
        targetTenantId: NEOGRANADINA_TENANT_ID,
        targetObjectKind: "tenant",
        targetObjectId: NEOGRANADINA_TENANT_ID,
        details: null,
        now: fixedNow,
      },
      async () => ({ workStatements: [], result: undefined }),
    );

    const row = await env.DB.prepare(
      "SELECT created_at FROM audit_log WHERE action = 'soft_disable_tenant' " +
        "ORDER BY created_at DESC LIMIT 1",
    ).first<{ created_at: number }>();
    expect(row).not.toBeNull();
    expect(row!.created_at).toBe(fixedNow);
  });
});

// @version v0.4.0
