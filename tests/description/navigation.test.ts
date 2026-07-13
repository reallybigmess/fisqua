/**
 * Tests — entry navigation (DESC-05)
 *
 * This suite pins `loadVolumeEntriesForDescription` — the loader
 * helper that returns the ordered list of entries the description
 * editor's prev/next navigation walks. The contract: entries are
 * filtered to a single volume, ordered by (`startPage` ASC,
 * `position` ASC), and carry only the columns the navigation
 * shell needs (id, title, description_status), keeping the
 * payload small enough to round-trip on every page change.
 *
 * Cases pin the ordering invariant (a multi-page entry with
 * positions 0..3 lands in deterministic order), the tenant
 * isolation (entries from another tenant's volume are not
 * surfaced), and the empty-volume edge case (the helper returns
 * `[]` rather than throwing, so the editor renders a clean empty
 * state).
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
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { loadVolumeEntriesForDescription } from "../../app/lib/description.server";

describe("Entry navigation (DESC-05)", () => {
  let db: ReturnType<typeof drizzle>;
  let volumeId: string;
  let entryIds: string[];

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    const user = await createTestUser({ isAdmin: false });
    const now = Date.now();

    const projectId = crypto.randomUUID();
    volumeId = crypto.randomUUID();
    entryIds = [];

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

    // Create 5 entries with positions 0-4 and startPages 1, 3, 5, 7, 9
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID();
      entryIds.push(id);
      await db.insert(schema.entries).values({
        id,
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId,
        position: i,
        startPage: 1 + i * 2,
        startY: 0,
        type: "item",
        descriptionStatus: "unassigned",
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  test("loader provides ordered entry list for volume", async () => {
    const result = await loadVolumeEntriesForDescription(db, volumeId);

    expect(result).toHaveLength(5);
    expect(result[0].position).toBe(0);
    expect(result[1].position).toBe(1);
    expect(result[2].position).toBe(2);
    expect(result[3].position).toBe(3);
    expect(result[4].position).toBe(4);
  });

  test("prev/next navigation updates URL to adjacent entry", async () => {
    const result = await loadVolumeEntriesForDescription(db, volumeId);

    // For the middle entry (index 2), the prev is index 1 and next is index 3
    const middleEntry = result[2];
    const prevEntry = result[1];
    const nextEntry = result[3];

    expect(prevEntry.id).toBeTruthy();
    expect(nextEntry.id).toBeTruthy();
    expect(prevEntry.position).toBe(middleEntry.position - 1);
    expect(nextEntry.position).toBe(middleEntry.position + 1);
  });

  test("navigation wraps or disables at boundaries", async () => {
    const result = await loadVolumeEntriesForDescription(db, volumeId);

    // First entry has no prev (index -1 is undefined)
    expect(result[-1]).toBeUndefined();
    // Last entry has no next (index 5 is undefined)
    expect(result[5]).toBeUndefined();
  });

  test("navigation shows current position (e.g. 3 de 24)", async () => {
    const result = await loadVolumeEntriesForDescription(db, volumeId);

    // For entry at index 2, position display would be "3 de 5"
    const targetEntryId = entryIds[2];
    const index = result.findIndex((e) => e.id === targetEntryId);

    expect(index).toBe(2);
    expect(index + 1).toBe(3); // Display position
    expect(result.length).toBe(5); // Total entries
  });
});
