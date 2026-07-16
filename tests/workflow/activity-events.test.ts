/**
 * Tests — `activity_log.event` literal acceptance
 *
 * This suite pins the runtime and compile-time acceptance of two
 * QC-related activity-log event literals: `qc_flag_raised` and
 * `qc_flag_resolved`. The `activity_log.event` column carries a
 * CHECK constraint that enumerates every legal event name, so the
 * runtime tests insert rows with each literal and assert the insert
 * succeeds without a CHECK rejection. The compile-time test asserts
 * the `ActivityEvent` union type accepts the same two literals, so
 * the TypeScript and SQL definitions cannot drift apart.
 *
 * The reason both layers get pinned: the QC-flag feature is the only
 * consumer of these two literals, and a missing CHECK update during
 * a migration would silently send writes into a corrupt state at
 * runtime even though TypeScript compiled clean. The CHECK is the
 * structural source of truth; the union type is the developer-facing
 * mirror.
 *
 * @version v0.3.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import type { ActivityEvent } from "../../app/lib/workflow.server";

// Compile-time assertions: the two new events are members of
// the ActivityEvent union. If a refactor drops them, this file stops
// compiling (a stronger signal than any runtime assertion can be).
const _qcRaised: ActivityEvent = "qc_flag_raised";
const _qcResolved: ActivityEvent = "qc_flag_resolved";
void _qcRaised;
void _qcResolved;

type Db = ReturnType<typeof drizzle>;

describe("activity_log.event accepts literals", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("inserts a row with event='qc_flag_raised' without a CHECK rejection", async () => {
    const user = await createTestUser({
      email: `ae-raised-${crypto.randomUUID()}@example.com`,
    });
    const id = crypto.randomUUID();
    await db.insert(schema.activityLog).values({
      id,
      tenantId: DEFAULT_TEST_TENANT_ID,
      userId: user.id,
      projectId: null,
      volumeId: null,
      event: "qc_flag_raised",
      detail: null,
      createdAt: Date.now(),
    });

    const [row] = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.id, id))
      .all();
    expect(row.event).toBe("qc_flag_raised");
  });

  it("inserts a row with event='qc_flag_resolved' without a CHECK rejection", async () => {
    const user = await createTestUser({
      email: `ae-resolved-${crypto.randomUUID()}@example.com`,
    });
    const id = crypto.randomUUID();
    await db.insert(schema.activityLog).values({
      id,
      tenantId: DEFAULT_TEST_TENANT_ID,
      userId: user.id,
      projectId: null,
      volumeId: null,
      event: "qc_flag_resolved",
      detail: null,
      createdAt: Date.now(),
    });

    const [row] = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.id, id))
      .all();
    expect(row.event).toBe("qc_flag_resolved");
  });

  it("confirms the ActivityEvent union accepts both literals at compile time", () => {
    // The real assertion runs at compile time via `_qcRaised` / `_qcResolved`
    // above. The runtime body exists so Vitest reports a passing test whose
    // name makes the intent greppable from CI output.
    expect(_qcRaised).toBe("qc_flag_raised");
    expect(_qcResolved).toBe("qc_flag_resolved");
  });
});

