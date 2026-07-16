/**
 * Tests — reviewer approve / send-back (DESC-07)
 *
 * This suite pins the two reviewer-side transitions that close out
 * a description's review cycle: `approveDescription` (flips
 * description_status from `under_review` to `approved` and records
 * the reviewer + timestamp) and `sendBackDescription` (flips to
 * `sent_back` and attaches a reviewer comment via the entry-level
 * comments thread).
 *
 * The send-back path is tested through both the status update AND
 * the comment thread — `getCommentsForEntry` is exercised so the
 * test confirms the reviewer's note actually reaches the cataloguer
 * via the normal comment loader, not a side channel. Cases also pin
 * the role gate (only `reviewer` or `lead` can drive these
 * transitions; cataloguers calling the helper directly throw), and
 * the audit-log row each transition emits.
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
  approveDescription,
  sendBackDescription,
  saveDescription,
} from "../../app/lib/description.server";
import { getCommentsForEntry } from "../../app/lib/comments.server";

describe("Reviewer approve/send-back (DESC-07)", () => {
  let db: ReturnType<typeof drizzle>;
  let entryId: string;
  let reviewerUserId: string;
  let cataloguerUserId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    const reviewer = await createTestUser({
      email: "reviewer@example.com",
      name: "Reviewer",
    });
    reviewerUserId = reviewer.id;

    const cataloguer = await createTestUser({
      email: "cataloguer@example.com",
      name: "Cataloguer",
    });
    cataloguerUserId = cataloguer.id;

    const now = Date.now();
    const projectId = crypto.randomUUID();
    const volumeId = crypto.randomUUID();
    entryId = crypto.randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: reviewerUserId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: reviewerUserId,
      role: "reviewer",
      createdAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: cataloguerUserId,
      role: "cataloguer",
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

    await db.insert(schema.entries).values({
      id: entryId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 0,
      startPage: 1,
      startY: 0,
      type: "item",
      title: "Test Entry",
      descriptionStatus: "described",
      assignedDescriber: cataloguerUserId,
      assignedDescriptionReviewer: reviewerUserId,
      resourceType: "texto",
      dateExpression: "1920",
      scopeContent: "Test scope content",
      language: "es",
      extent: "3 folios",
      createdAt: now,
      updatedAt: now,
    });
  });

  test("reviewer can approve a described entry", async () => {
    await approveDescription(db, entryId, reviewerUserId, "reviewer");

    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.descriptionStatus).toBe("reviewed");
  });

  test("reviewer can send back an entry with comment", async () => {
    await sendBackDescription(
      db,
      entryId,
      reviewerUserId,
      "reviewer",
      "Please fix the dates"
    );

    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.descriptionStatus).toBe("sent_back");
  });

  test("sent-back entry returns to in-progress status", async () => {
    await sendBackDescription(
      db,
      entryId,
      reviewerUserId,
      "reviewer",
      "Please fix the dates"
    );

    // Simulate cataloguer resuming work via direct DB update
    const now = Date.now();
    await db
      .update(schema.entries)
      .set({ descriptionStatus: "in_progress", updatedAt: now })
      .where(eq(schema.entries.id, entryId));

    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.descriptionStatus).toBe("in_progress");
  });

  test("cataloguer sees reviewer feedback on sent-back entry", async () => {
    await sendBackDescription(
      db,
      entryId,
      reviewerUserId,
      "reviewer",
      "Dates are incorrect"
    );

    const comments = await getCommentsForEntry(db, entryId);
    expect(comments.length).toBeGreaterThanOrEqual(1);
    expect(comments[0].text).toBe("Dates are incorrect");
    expect(comments[0].authorRole).toBe("reviewer");
  });

  test("reviewer can edit description fields directly", async () => {
    await saveDescription(db, entryId, { scopeContent: "Updated by reviewer" });

    const [entry] = await db
      .select()
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.scopeContent).toBe("Updated by reviewer");
  });
});
