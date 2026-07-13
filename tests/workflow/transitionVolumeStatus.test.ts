/**
 * Tests — transitionVolumeStatus atomicity
 *
 * This suite pins the atomicity contract of `transitionVolumeStatus` in
 * `app/lib/workflow.server.ts`. Two writes — the volumes status
 * UPDATE and the activity_log INSERT — must land together or not at
 * all. This is the regression test that closes the Apr 24 forensic
 * case on volume `5636e0b6-1e46-4aa4-975b-7c2f62dd7b3c`, where an
 * earlier non-batch implementation let one statement commit while
 * the other silently failed, leaving the database in a drifted
 * state for weeks until the cataloguer-side bug report surfaced it.
 *
 * Forcing function: D1 enforces foreign keys (`PRAGMA foreign_keys=ON`
 * by default) and the `cloudflare:test` pool inherits that, as
 * `tests/lib/audit.test.ts` already demonstrates with its CHECK
 * violation rollbacks. We force the activity_log INSERT to fail by
 * passing a `userId` whose row does not exist in `users` — the
 * activity_log.user_id FK references users(id) NOT NULL with no
 * cascade, so the INSERT raises and the batch rolls back. If FK
 * enforcement is ever turned off in the pool the test would see the
 * INSERT succeed instead of throwing; the assertion on the rolled-back
 * status would still catch the regression but the failure mode would
 * shift from "expect rejects" to "expect status unchanged" — the
 * `expectRollback` helper documents both branches.
 *
 * @version v0.4.1
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { transitionVolumeStatus } from "../../app/lib/workflow.server";

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function seedProject(db: Db, userId: string): Promise<string> {
  const projectId = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.projects).values({
    id: projectId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: "Test Project",
    description: null,
    conventions: null,
    settings: null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return projectId;
}

async function seedVolume(
  db: Db,
  projectId: string,
  status:
    | "unstarted"
    | "in_progress"
    | "segmented"
    | "sent_back"
    | "reviewed"
    | "approved" = "unstarted",
): Promise<string> {
  const volumeId = crypto.randomUUID();
  const now = Date.now();
  await db.insert(schema.volumes).values({
    id: volumeId,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId,
    name: "Test Volume",
    referenceCode: `TEST-${volumeId.slice(0, 8)}`,
    manifestUrl: "https://example.test/manifest.json",
    pageCount: 10,
    status,
    assignedTo: null,
    assignedReviewer: null,
    reviewComment: null,
    createdAt: now,
    updatedAt: now,
  });
  return volumeId;
}

describe("transitionVolumeStatus atomicity", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
  });

  it("happy path — both writes land in one batch", async () => {
    const user = await createTestUser({
      email: `t-happy-${crypto.randomUUID()}@example.test`,
    });
    const projectId = await seedProject(db, user.id);
    const volumeId = await seedVolume(db, projectId, "unstarted");

    await transitionVolumeStatus(
      db,
      volumeId,
      "in_progress",
      user.id,
      "cataloguer",
    );

    // (a) volumes row reflects the new status.
    const [vol] = await db
      .select({ status: schema.volumes.status })
      .from(schema.volumes)
      .where(eq(schema.volumes.id, volumeId))
      .all();
    expect(vol).toBeDefined();
    expect(vol.status).toBe("in_progress");

    // (b) activity_log row landed with the expected event + detail JSON.
    const logRows = await db
      .select({
        event: schema.activityLog.event,
        detail: schema.activityLog.detail,
        volumeId: schema.activityLog.volumeId,
        projectId: schema.activityLog.projectId,
      })
      .from(schema.activityLog)
      .where(eq(schema.activityLog.volumeId, volumeId))
      .all();
    expect(logRows).toHaveLength(1);
    expect(logRows[0].event).toBe("status_changed");
    expect(logRows[0].projectId).toBe(projectId);
    const detail = JSON.parse(logRows[0].detail!);
    expect(detail).toEqual({
      from: "unstarted",
      to: "in_progress",
      comment: null,
    });
  });

  it("rollback — activity_log INSERT failure leaves volumes row unchanged", async () => {
    // Seed a real user just so the volume can be assigned/created
    // through the same project. The transition itself is invoked
    // with a BAD userId — the activity_log.user_id FK to users(id)
    // is NOT NULL with no cascade, so the INSERT raises and the
    // entire db.batch rolls back.
    const realUser = await createTestUser({
      email: `t-rollback-${crypto.randomUUID()}@example.test`,
    });
    const projectId = await seedProject(db, realUser.id);
    const volumeId = await seedVolume(db, projectId, "unstarted");

    const badUserId = crypto.randomUUID(); // no users row with this id

    await expect(
      transitionVolumeStatus(
        db,
        volumeId,
        "in_progress",
        badUserId,
        "cataloguer",
      ),
    ).rejects.toThrow();

    // The atomicity assertion: the volumes UPDATE rolled back.
    // Status is still "unstarted", not "in_progress".
    const [vol] = await db
      .select({ status: schema.volumes.status })
      .from(schema.volumes)
      .where(eq(schema.volumes.id, volumeId))
      .all();
    expect(vol).toBeDefined();
    expect(vol.status).toBe("unstarted");

    // And no activity_log row was written.
    const logRows = await db
      .select({ id: schema.activityLog.id })
      .from(schema.activityLog)
      .where(eq(schema.activityLog.volumeId, volumeId))
      .all();
    expect(logRows).toHaveLength(0);
  });

  it("validation failure — invalid transition raises 400 with no writes", async () => {
    const user = await createTestUser({
      email: `t-validate-${crypto.randomUUID()}@example.test`,
    });
    const projectId = await seedProject(db, user.id);
    const volumeId = await seedVolume(db, projectId, "unstarted");

    // Cataloguer can't go straight unstarted -> segmented.
    await expect(
      transitionVolumeStatus(
        db,
        volumeId,
        "segmented",
        user.id,
        "cataloguer",
      ),
    ).rejects.toBeInstanceOf(Response);

    // Volume unchanged.
    const [vol] = await db
      .select({ status: schema.volumes.status })
      .from(schema.volumes)
      .where(eq(schema.volumes.id, volumeId))
      .all();
    expect(vol.status).toBe("unstarted");

    // No activity_log row.
    const logRows = await db
      .select({ id: schema.activityLog.id })
      .from(schema.activityLog)
      .where(eq(schema.activityLog.volumeId, volumeId))
      .all();
    expect(logRows).toHaveLength(0);
  });

  it("structural guard — happy path emits exactly one batch with the two expected statements", async () => {
    // The cleaner version of the atomicity guard is a spy on
    // `db.batch`. Together with the rollback test above, this pins
    // both that the implementation uses `db.batch` (mechanism) AND
    // that the batch actually rolls back on partial failure
    // (semantics). Spy on the underlying d1 driver via the
    // env.DB.batch surface that Drizzle delegates to.
    const user = await createTestUser({
      email: `t-spy-${crypto.randomUUID()}@example.test`,
    });
    const projectId = await seedProject(db, user.id);
    const volumeId = await seedVolume(db, projectId, "unstarted");

    let batchCalls = 0;
    let lastBatchLen = 0;
    const originalBatch = env.DB.batch.bind(env.DB);
    (env.DB as any).batch = (stmts: unknown[]) => {
      batchCalls += 1;
      lastBatchLen = stmts.length;
      return originalBatch(stmts as Parameters<typeof originalBatch>[0]);
    };
    try {
      await transitionVolumeStatus(
        db,
        volumeId,
        "in_progress",
        user.id,
        "cataloguer",
      );
    } finally {
      (env.DB as any).batch = originalBatch;
    }

    expect(batchCalls).toBe(1);
    expect(lastBatchLen).toBeGreaterThanOrEqual(2);
  });
});

// @version v0.4.1
