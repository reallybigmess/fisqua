/**
 * Tests — dashboard loader helpers
 *
 * This suite pins `determinePrimaryRole` and the five `db`/`userId`
 * loader helpers behind `app/routes/_auth.dashboard.tsx`'s loader:
 * `loadCataloguerData`, `loadReviewerData`, `loadLeadData`,
 * `loadCataloguerDescriptionData`, and `loadReviewerDescriptionData`.
 *
 * These helpers used to take a `deps: any` bag threaded in from the
 * loader's dynamic `drizzle-orm` / schema imports; the refactor moved
 * those imports to module scope and typed `db` as
 * `DrizzleD1Database<any>`, matching the sibling `.server.ts` helper
 * convention. The helpers are exported (a named export purely for
 * testability, mirroring `applyUpdateRoles` in
 * `_auth.admin.users.$id.tsx`) so this suite can call them directly
 * without going through the full route loader / i18n stack.
 *
 * `determinePrimaryRole` gets a precedence suite (lead > reviewer >
 * cataloguer, no-role case). Each data loader gets at least one
 * substantive assertion against a seeded fixture: `loadCataloguerData`
 * pins status grouping + entry counts + recency sort;
 * `loadReviewerData` pins status grouping + cataloguer-name
 * resolution; `loadLeadData` pins the project-overview aggregates
 * plus all five attention-item kinds (waiting, unassigned,
 * resegmentation, description-review, inactive) and the admin
 * all-projects branch; `loadCataloguerDescriptionData` pins the
 * sent-back reviewer-feedback lookup; `loadReviewerDescriptionData`
 * pins the description-status buckets plus the reviewer-scoped open
 * reseg flags.
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
import {
  determinePrimaryRole,
  loadCataloguerData,
  loadReviewerData,
  loadLeadData,
  loadCataloguerDescriptionData,
  loadReviewerDescriptionData,
} from "../../app/routes/_auth.dashboard";

function getDb() {
  return drizzle(env.DB, { schema });
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeProject(
  db: ReturnType<typeof getDb>,
  overrides: { id?: string; name?: string; createdBy: string; archivedAt?: number | null }
): Promise<string> {
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(schema.projects).values({
    id,
    tenantId: DEFAULT_TEST_TENANT_ID,
    name: overrides.name ?? "Test Project",
    createdBy: overrides.createdBy,
    createdAt: now,
    updatedAt: now,
    archivedAt: overrides.archivedAt ?? null,
  });
  return id;
}

async function addMember(
  db: ReturnType<typeof getDb>,
  projectId: string,
  userId: string,
  role: "lead" | "cataloguer" | "reviewer"
): Promise<void> {
  await db.insert(schema.projectMembers).values({
    id: crypto.randomUUID(),
    projectId,
    userId,
    role,
    createdAt: Date.now(),
  });
}

async function makeVolume(
  db: ReturnType<typeof getDb>,
  overrides: {
    id?: string;
    projectId: string;
    name?: string;
    referenceCode?: string;
    status?: "unstarted" | "in_progress" | "segmented" | "sent_back" | "reviewed" | "approved";
    assignedTo?: string | null;
    assignedReviewer?: string | null;
    reviewComment?: string | null;
    updatedAt?: number;
  }
): Promise<string> {
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(schema.volumes).values({
    id,
    tenantId: DEFAULT_TEST_TENANT_ID,
    projectId: overrides.projectId,
    name: overrides.name ?? "Test Volume",
    referenceCode: overrides.referenceCode ?? `ref-${id}`,
    manifestUrl: `https://iiif.zasqua.org/${id}/manifest.json`,
    pageCount: 10,
    status: overrides.status ?? "unstarted",
    assignedTo: overrides.assignedTo ?? null,
    assignedReviewer: overrides.assignedReviewer ?? null,
    reviewComment: overrides.reviewComment ?? null,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  });
  return id;
}

async function makeEntry(
  db: ReturnType<typeof getDb>,
  overrides: {
    id?: string;
    volumeId: string;
    position?: number;
    startPage?: number;
    descriptionStatus?:
      | "unassigned"
      | "assigned"
      | "in_progress"
      | "described"
      | "sent_back"
      | "reviewed"
      | "approved"
      | "promoted";
    assignedDescriber?: string | null;
    assignedDescriptionReviewer?: string | null;
    title?: string | null;
    translatedTitle?: string | null;
    resourceType?: "texto" | "imagen" | "cartografico" | "mixto" | null;
    dateExpression?: string | null;
    extent?: string | null;
    scopeContent?: string | null;
    language?: string | null;
    descriptionNotes?: string | null;
    updatedAt?: number;
  }
): Promise<string> {
  const now = Date.now();
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(schema.entries).values({
    id,
    tenantId: DEFAULT_TEST_TENANT_ID,
    volumeId: overrides.volumeId,
    position: overrides.position ?? 0,
    startPage: overrides.startPage ?? 1,
    descriptionStatus: overrides.descriptionStatus ?? "unassigned",
    assignedDescriber: overrides.assignedDescriber ?? null,
    assignedDescriptionReviewer: overrides.assignedDescriptionReviewer ?? null,
    title: overrides.title ?? null,
    translatedTitle: overrides.translatedTitle ?? null,
    resourceType: overrides.resourceType ?? null,
    dateExpression: overrides.dateExpression ?? null,
    extent: overrides.extent ?? null,
    scopeContent: overrides.scopeContent ?? null,
    language: overrides.language ?? null,
    descriptionNotes: overrides.descriptionNotes ?? null,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  });
  return id;
}

describe("dashboard loader helpers", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe("determinePrimaryRole", () => {
    it("prefers lead over reviewer and cataloguer", () => {
      const role = determinePrimaryRole([
        { role: "cataloguer" },
        { role: "reviewer" },
        { role: "lead" },
      ]);
      expect(role).toBe("lead");
    });

    it("prefers reviewer over cataloguer when there is no lead role", () => {
      const role = determinePrimaryRole([
        { role: "cataloguer" },
        { role: "reviewer" },
      ]);
      expect(role).toBe("reviewer");
    });

    it("falls back to cataloguer when that is the only role held", () => {
      expect(determinePrimaryRole([{ role: "cataloguer" }])).toBe("cataloguer");
    });

    it("returns 'none' when the caller holds no memberships", () => {
      expect(determinePrimaryRole([])).toBe("none");
    });
  });

  describe("loadCataloguerData", () => {
    it("groups assigned volumes by status, attaches entry/project counts, and sorts by recency", async () => {
      const db = getDb();
      const lead = await createTestUser({ email: "lead@test.com" });
      const cataloguer = await createTestUser({ email: "cat@test.com" });
      const projectId = await makeProject(db, { createdBy: lead.id, name: "Project A" });

      const now = Date.now();
      const sentBackId = await makeVolume(db, {
        projectId,
        status: "sent_back",
        assignedTo: cataloguer.id,
        updatedAt: now - 1000,
      });
      const inProgressId = await makeVolume(db, {
        projectId,
        status: "in_progress",
        assignedTo: cataloguer.id,
        updatedAt: now - 2000,
      });
      // Two "unstarted" volumes to pin the recency sort within a group.
      const readyOlderId = await makeVolume(db, {
        projectId,
        status: "unstarted",
        assignedTo: cataloguer.id,
        updatedAt: now - 5000,
      });
      const readyNewerId = await makeVolume(db, {
        projectId,
        status: "unstarted",
        assignedTo: cataloguer.id,
        updatedAt: now - 500,
      });
      const approvedId = await makeVolume(db, {
        projectId,
        status: "approved",
        assignedTo: cataloguer.id,
        updatedAt: now - 3000,
      });
      // A volume in the same project assigned to someone else must not appear.
      await makeVolume(db, { projectId, status: "unstarted", assignedTo: lead.id });

      await makeEntry(db, { volumeId: sentBackId });
      await makeEntry(db, { volumeId: sentBackId });
      await makeEntry(db, { volumeId: inProgressId });

      const { groups } = await loadCataloguerData(db, cataloguer.id);

      expect(groups.needsAttention.map((v) => v.id)).toEqual([sentBackId]);
      expect(groups.needsAttention[0].entryCount).toBe(2);
      expect(groups.needsAttention[0].projectName).toBe("Project A");

      expect(groups.inProgress.map((v) => v.id)).toEqual([inProgressId]);
      expect(groups.inProgress[0].entryCount).toBe(1);

      // readyToStart sorted by updatedAt DESC -- newer first.
      expect(groups.readyToStart.map((v) => v.id)).toEqual([
        readyNewerId,
        readyOlderId,
      ]);
      expect(groups.readyToStart[0].entryCount).toBe(0);

      expect(groups.completed.map((v) => v.id)).toEqual([approvedId]);
    });

    it("returns empty groups when the cataloguer has no assigned volumes", async () => {
      const db = getDb();
      const cataloguer = await createTestUser({ email: "cat2@test.com" });
      const { groups } = await loadCataloguerData(db, cataloguer.id);
      expect(groups).toEqual({
        needsAttention: [],
        inProgress: [],
        readyToStart: [],
        completed: [],
      });
    });
  });

  describe("loadReviewerData", () => {
    it("groups review volumes by status and resolves cataloguer names", async () => {
      const db = getDb();
      const lead = await createTestUser({ email: "lead2@test.com" });
      const reviewer = await createTestUser({ email: "rev@test.com" });
      const cataloguer = await createTestUser({ email: "cat3@test.com", name: "Ana Cataloguer" });
      const projectId = await makeProject(db, { createdBy: lead.id, name: "Project B" });

      const awaitingId = await makeVolume(db, {
        projectId,
        status: "segmented",
        assignedReviewer: reviewer.id,
        assignedTo: cataloguer.id,
      });
      const reviewedId = await makeVolume(db, {
        projectId,
        status: "reviewed",
        assignedReviewer: reviewer.id,
      });
      const approvedId = await makeVolume(db, {
        projectId,
        status: "approved",
        assignedReviewer: reviewer.id,
      });
      // Statuses reviewers don't see.
      await makeVolume(db, { projectId, status: "unstarted", assignedReviewer: reviewer.id });
      await makeVolume(db, { projectId, status: "in_progress", assignedReviewer: reviewer.id });
      await makeVolume(db, { projectId, status: "sent_back", assignedReviewer: reviewer.id });

      await makeEntry(db, { volumeId: awaitingId });

      const { groups } = await loadReviewerData(db, reviewer.id);

      expect(groups.awaitingReview.map((v) => v.id)).toEqual([awaitingId]);
      expect(groups.awaitingReview[0].entryCount).toBe(1);
      expect(groups.awaitingReview[0].cataloguerName).toBe("Ana Cataloguer");
      expect(groups.awaitingReview[0].projectName).toBe("Project B");

      expect(groups.reviewed.map((v) => v.id)).toEqual([reviewedId]);
      expect(groups.reviewed[0].cataloguerName).toBeNull();

      expect(groups.approved.map((v) => v.id)).toEqual([approvedId]);
    });
  });

  describe("loadLeadData", () => {
    it("builds a project overview with status/description counts and every attention-item kind", async () => {
      const db = getDb();
      const lead = await createTestUser({ email: "lead3@test.com" });
      const cataloguer = await createTestUser({
        email: "cat4@test.com",
        name: "Inactive Cataloguer",
      });
      const projectId = await makeProject(db, { createdBy: lead.id, name: "Project C" });
      await addMember(db, projectId, lead.id, "lead");
      await addMember(db, projectId, cataloguer.id, "cataloguer");

      // Inactive member (>7 days) -- attention type "inactive".
      const staleActiveAt = Date.now() - 8 * DAY_MS;
      await db
        .update(schema.users)
        .set({ lastActiveAt: staleActiveAt })
        .where(eq(schema.users.id, cataloguer.id));

      // Waiting >3 days for review -- attention type "waiting" (segmentation
      // status counts also cover this volume).
      const waitingVolumeId = await makeVolume(db, {
        projectId,
        name: "Waiting Volume",
        status: "segmented",
        assignedTo: cataloguer.id,
        updatedAt: Date.now() - 4 * DAY_MS,
      });

      // Unassigned volume -- attention type "unassigned".
      await makeVolume(db, { projectId, name: "Unassigned Volume", status: "unstarted" });

      // Entries for description-status aggregation + "description-review"
      // attention (described, waiting >3 days).
      const describedEntryId = await makeEntry(db, {
        volumeId: waitingVolumeId,
        descriptionStatus: "described",
        title: "Old Entry",
        updatedAt: Date.now() - 5 * DAY_MS,
      });
      await makeEntry(db, {
        volumeId: waitingVolumeId,
        descriptionStatus: "approved",
      });

      // Open resegmentation flag -- attention type "resegmentation".
      await db.insert(schema.resegmentationFlags).values({
        id: crypto.randomUUID(),
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId: waitingVolumeId,
        reportedBy: cataloguer.id,
        entryId: describedEntryId,
        problemType: "incorrect_boundaries",
        affectedEntryIds: JSON.stringify([describedEntryId]),
        description: "Pages look merged.",
        status: "open",
        createdAt: Date.now(),
      });

      const { projects, attentionItems } = await loadLeadData(db, lead.id, false);

      expect(projects).toHaveLength(1);
      const overview = projects[0];
      expect(overview.id).toBe(projectId);
      expect(overview.totalVolumes).toBe(2);
      expect(overview.statusCounts).toEqual({ segmented: 1, unstarted: 1 });
      expect(overview.descriptionStatusCounts).toEqual({ described: 1, approved: 1 });
      expect(overview.totalEntries).toBe(2);

      const teamMember = overview.teamMembers.find((m) => m.id === cataloguer.id);
      expect(teamMember?.name).toBe("Inactive Cataloguer");
      expect(teamMember?.volumeCount).toBe(1);

      const kinds = attentionItems.map((a) => a.type).sort();
      expect(kinds).toEqual(
        ["description-review", "inactive", "resegmentation", "unassigned", "waiting"].sort(),
      );
    });

    it("admin sees every non-archived project across the tenant, archived ones excluded", async () => {
      const db = getDb();
      const admin = await createTestUser({ email: "admin@test.com", isAdmin: true });
      const otherOwner = await createTestUser({ email: "owner@test.com" });

      // Admin has no membership on this project -- still visible.
      const visibleId = await makeProject(db, { createdBy: otherOwner.id, name: "Visible" });
      // Archived project -- excluded even for admin.
      await makeProject(db, {
        createdBy: otherOwner.id,
        name: "Archived",
        archivedAt: Date.now(),
      });

      const { projects } = await loadLeadData(db, admin.id, true);

      expect(projects.map((p) => p.id)).toEqual([visibleId]);
    });

    it("returns empty projects/attentionItems when the user leads nothing", async () => {
      const db = getDb();
      const user = await createTestUser({ email: "nolead@test.com" });
      const result = await loadLeadData(db, user.id, false);
      expect(result).toEqual({ projects: [], attentionItems: [] });
    });
  });

  describe("loadCataloguerDescriptionData", () => {
    it("attaches the latest reviewer comment as feedback on sent_back entries", async () => {
      const db = getDb();
      const lead = await createTestUser({ email: "lead4@test.com" });
      const describer = await createTestUser({ email: "describer@test.com" });
      const reviewer = await createTestUser({ email: "reviewer2@test.com" });
      const projectId = await makeProject(db, { createdBy: lead.id, name: "Project D" });
      const volumeId = await makeVolume(db, { projectId, name: "Vol D", referenceCode: "ref-d" });

      const sentBackEntryId = await makeEntry(db, {
        volumeId,
        assignedDescriber: describer.id,
        descriptionStatus: "sent_back",
        title: "Escritura",
        resourceType: "texto",
        dateExpression: "1750",
        extent: "3 folios",
        scopeContent: "Contenido",
        language: "es",
      });
      // Older comment, then a newer one -- only the newer should surface.
      await db.insert(schema.comments).values({
        id: crypto.randomUUID(),
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId,
        entryId: sentBackEntryId,
        authorId: reviewer.id,
        authorRole: "reviewer",
        text: "First pass: fix the date.",
        createdAt: Date.now() - 2000,
        updatedAt: Date.now() - 2000,
      });
      await db.insert(schema.comments).values({
        id: crypto.randomUUID(),
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId,
        entryId: sentBackEntryId,
        authorId: reviewer.id,
        authorRole: "reviewer",
        text: "Second pass: also fix the extent.",
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
      });

      // A second assigned entry, not sent back -- no feedback expected.
      await makeEntry(db, {
        volumeId,
        assignedDescriber: describer.id,
        descriptionStatus: "in_progress",
      });

      const cards = await loadCataloguerDescriptionData(db, describer.id);

      expect(cards).toHaveLength(2);
      const sentBackCard = cards.find((c) => c.id === sentBackEntryId)!;
      expect(sentBackCard.reviewerFeedback).toBe("Second pass: also fix the extent.");
      expect(sentBackCard.volumeTitle).toBe("Vol D");
      expect(sentBackCard.referenceCode).toBe("ref-d");
      expect(sentBackCard.hasIdentificacion).toBe(true);
      expect(sentBackCard.hasFisica).toBe(true);
      expect(sentBackCard.hasContenido).toBe(true);
      expect(sentBackCard.hasNotas).toBe(false);
    });

    it("returns an empty array when the describer has no assigned entries", async () => {
      const db = getDb();
      const describer = await createTestUser({ email: "describer2@test.com" });
      expect(await loadCataloguerDescriptionData(db, describer.id)).toEqual([]);
    });
  });

  describe("loadReviewerDescriptionData", () => {
    it("buckets entries by description status and lists open reseg flags for the reviewer's volumes", async () => {
      const db = getDb();
      const lead = await createTestUser({ email: "lead5@test.com" });
      const reviewer = await createTestUser({ email: "descreviewer@test.com" });
      const projectId = await makeProject(db, { createdBy: lead.id, name: "Project E" });
      const volumeId = await makeVolume(db, {
        projectId,
        name: "Vol E",
        referenceCode: "ref-e",
        assignedReviewer: reviewer.id,
      });

      const describedId = await makeEntry(db, {
        volumeId,
        assignedDescriptionReviewer: reviewer.id,
        descriptionStatus: "described",
      });
      const reviewedId = await makeEntry(db, {
        volumeId,
        assignedDescriptionReviewer: reviewer.id,
        descriptionStatus: "reviewed",
      });
      const approvedId = await makeEntry(db, {
        volumeId,
        assignedDescriptionReviewer: reviewer.id,
        descriptionStatus: "approved",
      });

      await db.insert(schema.resegmentationFlags).values({
        id: crypto.randomUUID(),
        tenantId: DEFAULT_TEST_TENANT_ID,
        volumeId,
        reportedBy: reviewer.id,
        entryId: describedId,
        problemType: "missing_pages",
        affectedEntryIds: JSON.stringify([describedId]),
        description: "Missing a page.",
        status: "open",
        createdAt: Date.now(),
      });

      const result = await loadReviewerDescriptionData(db, reviewer.id);

      expect(result.awaitingReview.map((e) => e.id)).toEqual([describedId]);
      expect(result.reviewed.map((e) => e.id)).toEqual([reviewedId]);
      expect(result.approved.map((e) => e.id)).toEqual([approvedId]);
      expect(result.resegFlags).toHaveLength(1);
      expect(result.resegFlags[0].volumeTitle).toBe("Vol E");
      expect(result.resegFlags[0].referenceCode).toBe("ref-e");
    });

    it("returns empty buckets and no flags when the reviewer has nothing assigned", async () => {
      const db = getDb();
      const reviewer = await createTestUser({ email: "descreviewer2@test.com" });
      const result = await loadReviewerDescriptionData(db, reviewer.id);
      expect(result).toEqual({
        resegFlags: [],
        awaitingReview: [],
        reviewed: [],
        approved: [],
      });
    });
  });
});
