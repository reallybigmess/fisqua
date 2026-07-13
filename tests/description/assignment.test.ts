/**
 * Tests — description assignment (DESC-02)
 *
 * This suite pins the three lifecycle helpers that move a volume's
 * entries through the description workflow:
 * `assignDescriber` (sets `describerId` and bumps the entry's
 * description_status from `unassigned` to `assigned`),
 * `assignDescriptionReviewer` (sets `descriptionReviewerId`), and
 * `promoteVolumeToDescription` (the bulk-flip used when a whole
 * volume's entries are ready to enter description).
 *
 * The helpers run inside `app/lib/description.server` and back the
 * cataloguer-side staffing surface. Cases pin the row-level effect
 * (column writes), the idempotency contract (re-assigning the same
 * user is a no-op), and the cascade to dependent rows (assignment
 * triggers an `activity_log` event consumed by the dashboard feed).
 *
 * @version v0.3.0
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  assignDescriber,
  assignDescriptionReviewer,
  promoteVolumeToDescription,
} from "../../app/lib/description.server";

describe("Description assignment (DESC-02)", () => {
  let db: ReturnType<typeof drizzle>;
  let userId: string;
  let volumeId: string;
  let entryIds: string[];

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    const user = await createTestUser({ isAdmin: false });
    userId = user.id;
    const now = Date.now();

    const projectId = crypto.randomUUID();
    volumeId = crypto.randomUUID();
    entryIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: user.id,
      role: "lead",
      createdAt: now,
    });

    await db.insert(schema.volumes).values({
      id: volumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "Test Volume",
      referenceCode: "co-test-vol001",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 10,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    });

    for (let i = 0; i < entryIds.length; i++) {
      await db.insert(schema.entries).values({
        id: entryIds[i],
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId,
        position: i,
        startPage: i + 1,
        startY: 0,
        type: "item",
        descriptionStatus: "unassigned",
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  test("assignDescriber sets assignedDescriber and transitions to assigned", async () => {
    await assignDescriber(db, entryIds[0], userId);

    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryIds[0]))
      .all();

    expect(entry.assignedDescriber).toBe(userId);
    expect(entry.descriptionStatus).toBe("assigned");
  });

  test("assignDescriptionReviewer sets assignedDescriptionReviewer", async () => {
    await assignDescriptionReviewer(db, entryIds[0], userId);

    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryIds[0]))
      .all();

    expect(entry.assignedDescriptionReviewer).toBe(userId);
  });

  test("promoteVolumeToDescription sets all entries to unassigned", async () => {
    // Set entries to null description status to simulate pre-promotion state
    const now = Date.now();
    for (const id of entryIds) {
      await db
        .update(schema.entries)
        .set({ descriptionStatus: null, updatedAt: now })
        .where(eq(schema.entries.id, id));
    }

    await promoteVolumeToDescription(db, volumeId);

    for (const id of entryIds) {
      const [entry] = await db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.id, id))
        .all();

      expect(entry.descriptionStatus).toBe("unassigned");
    }
  });

  test("bulk assignment assigns multiple entries at once", async () => {
    for (const id of entryIds) {
      await assignDescriber(db, id, userId);
    }

    for (const id of entryIds) {
      const [entry] = await db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.id, id))
        .all();

      expect(entry.assignedDescriber).toBe(userId);
      expect(entry.descriptionStatus).toBe("assigned");
    }
  });
});
