/**
 * Project Assignments Tab
 *
 * This page is the lead-only assignments surface inside a project,
 * gated through `requireProjectRole(user, projectId, "lead")` in both
 * loader and action. It pairs an `AssignmentTable` of every volume in
 * the project — cataloguer, reviewer, status, progress — with a
 * `BulkToolbar` for multi-row reassignment and a `TeamProgress` panel
 * that aggregates per-member workload. A sub-tab switch lets the lead
 * flip between segmentation and description assignments without
 * leaving the route; the description view is rendered through the
 * shared `DescriptionTabContent` component to keep the volume-level
 * and entry-level pages in sync.
 *
 * The loader bundles every payload the page needs in a single
 * round-trip — volumes with denormalised counts, candidate members,
 * and the per-member stats — so the table never waterfalls when the
 * lead opens it.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { StackedProgressBar } from "../components/dashboard/progress-bar";
import {
  AssignmentTable,
  type VolumeRow,
  type MemberOption,
} from "../components/assignments/assignment-table";
import { BulkToolbar } from "../components/assignments/bulk-toolbar";
import {
  TeamProgress,
  type TeamMemberStats,
} from "../components/assignments/team-progress";
import { DescriptionTabContent } from "../components/assignments/description-tab-content";
import type { Route } from "./+types/_auth.projects.$id.assignments";

type SubTab = "segmentation" | "description";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, sql, inArray, isNull, isNotNull } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { logActivity } = await import("../lib/workflow.server");
  const { promoteVolumeToDescription, getVolumeDescriptionProgress } = await import("../lib/description.server");
  const { hasOpenFlags } = await import("../lib/resegmentation.server");
  const { volumes, projectMembers, users, entries } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Lead-only access
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  // Fetch all volumes for this project
  const projectVolumes = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      pageCount: volumes.pageCount,
      status: volumes.status,
      assignedTo: volumes.assignedTo,
      assignedReviewer: volumes.assignedReviewer,
    })
    .from(volumes)
    .where(eq(volumes.projectId, params.id))
    .orderBy(volumes.name)
    .all();

  // Fetch project members
  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, params.id))
    .all();

  const cataloguers: MemberOption[] = members
    .filter((m) => m.role === "cataloguer")
    .map((m) => ({ id: m.id, name: m.name, email: m.email }));

  const reviewers: MemberOption[] = members
    .filter((m) => m.role === "reviewer")
    .map((m) => ({ id: m.id, name: m.name, email: m.email }));

  // Compute status counts for progress bar
  const statusCounts: Record<string, number> = {};
  for (const vol of projectVolumes) {
    statusCounts[vol.status] = (statusCounts[vol.status] ?? 0) + 1;
  }

  // Compute per-member stats for team progress
  const memberStatsMap = new Map<string, TeamMemberStats>();

  for (const m of members) {
    if (m.role === "lead") continue; // leads don't get progress cards
    if (!memberStatsMap.has(m.id)) {
      memberStatsMap.set(m.id, {
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        statusCounts: {},
        totalVolumes: 0,
        entryCount: 0,
      });
    }
  }

  // Count assigned volumes per member by status
  for (const vol of projectVolumes) {
    if (vol.assignedTo && memberStatsMap.has(vol.assignedTo)) {
      const stats = memberStatsMap.get(vol.assignedTo)!;
      stats.statusCounts[vol.status] = (stats.statusCounts[vol.status] ?? 0) + 1;
      stats.totalVolumes += 1;
    }
    if (vol.assignedReviewer && memberStatsMap.has(vol.assignedReviewer)) {
      const stats = memberStatsMap.get(vol.assignedReviewer)!;
      stats.statusCounts[vol.status] = (stats.statusCounts[vol.status] ?? 0) + 1;
      stats.totalVolumes += 1;
    }
  }

  // Count entries per assigned user (supporting metric)
  const volumeIds = projectVolumes.map((v) => v.id);
  if (volumeIds.length > 0) {
    const entryCounts = await db
      .select({
        volumeId: entries.volumeId,
        count: sql<number>`count(*)`,
      })
      .from(entries)
      .where(inArray(entries.volumeId, volumeIds))
      .groupBy(entries.volumeId)
      .all();

    const entryCountByVolume = new Map(
      entryCounts.map((e) => [e.volumeId, e.count])
    );

    for (const vol of projectVolumes) {
      const count = entryCountByVolume.get(vol.id) ?? 0;
      if (vol.assignedTo && memberStatsMap.has(vol.assignedTo)) {
        memberStatsMap.get(vol.assignedTo)!.entryCount += count;
      }
    }
  }

  const teamMembers = Array.from(memberStatsMap.values());

  // --- Description tab data ---

  // Promotable volumes: approved segmentation, no entries with descriptionStatus set
  const approvedVolumes = projectVolumes.filter((v) => v.status === "approved");
  const promotableVolumes: Array<{
    id: string;
    name: string;
    referenceCode: string | null;
    approvedEntryCount: number;
  }> = [];

  const descriptionVolumes: Array<{
    id: string;
    name: string;
    referenceCode: string | null;
    entryCount: number;
    progress: Record<string, number>;
    hasOpenFlags: boolean;
  }> = [];

  // Check each approved volume for description entries
  for (const vol of approvedVolumes) {
    const descEntries = await db
      .select({
        descriptionStatus: entries.descriptionStatus,
        count: sql<number>`count(*)`,
      })
      .from(entries)
      .where(eq(entries.volumeId, vol.id))
      .groupBy(entries.descriptionStatus)
      .all();

    const hasDescriptionEntries = descEntries.some(
      (e) => e.descriptionStatus !== null
    );

    if (!hasDescriptionEntries) {
      // Promotable: approved segmentation, no description entries
      const totalEntries = descEntries.reduce((sum, e) => sum + e.count, 0);
      promotableVolumes.push({
        id: vol.id,
        name: vol.name,
        referenceCode: null,
        approvedEntryCount: totalEntries,
      });
    } else {
      // Already in description
      const progress: Record<string, number> = {};
      let totalCount = 0;
      for (const row of descEntries) {
        const status = row.descriptionStatus ?? "unassigned";
        progress[status] = row.count;
        totalCount += row.count;
      }
      const openFlags = await hasOpenFlags(db, vol.id);
      descriptionVolumes.push({
        id: vol.id,
        name: vol.name,
        referenceCode: null,
        entryCount: totalCount,
        progress,
        hasOpenFlags: openFlags,
      });
    }
  }

  // Also check non-approved volumes that might have description entries
  const nonApprovedWithDesc = projectVolumes.filter(
    (v) => v.status !== "approved"
  );
  for (const vol of nonApprovedWithDesc) {
    const descEntries = await db
      .select({
        descriptionStatus: entries.descriptionStatus,
        count: sql<number>`count(*)`,
      })
      .from(entries)
      .where(
        and(eq(entries.volumeId, vol.id), isNotNull(entries.descriptionStatus))
      )
      .groupBy(entries.descriptionStatus)
      .all();

    if (descEntries.length > 0) {
      const progress: Record<string, number> = {};
      let totalCount = 0;
      for (const row of descEntries) {
        const status = row.descriptionStatus ?? "unassigned";
        progress[status] = row.count;
        totalCount += row.count;
      }
      const openFlags = await hasOpenFlags(db, vol.id);
      descriptionVolumes.push({
        id: vol.id,
        name: vol.name,
        referenceCode: null,
        entryCount: totalCount,
        progress,
        hasOpenFlags: openFlags,
      });
    }
  }

  // Global description progress (aggregate across all description volumes)
  const globalProgress: Record<string, number> = {};
  for (const vol of descriptionVolumes) {
    for (const [status, count] of Object.entries(vol.progress)) {
      globalProgress[status] = (globalProgress[status] ?? 0) + count;
    }
  }

  // Description team members: members with description assignments
  const descriptionMembers: Array<{
    id: string;
    name: string | null;
    email: string;
    role: string;
    assignedCount: number;
    completedCount: number;
  }> = [];

  if (volumeIds.length > 0) {
    // Get per-user description assignment stats
    const describerStats = await db
      .select({
        userId: entries.assignedDescriber,
        status: entries.descriptionStatus,
        count: sql<number>`count(*)`,
      })
      .from(entries)
      .where(
        and(
          inArray(entries.volumeId, volumeIds),
          isNotNull(entries.assignedDescriber)
        )
      )
      .groupBy(entries.assignedDescriber, entries.descriptionStatus)
      .all();

    const memberMap = new Map<
      string,
      { assigned: number; completed: number }
    >();
    for (const row of describerStats) {
      if (!row.userId) continue;
      if (!memberMap.has(row.userId)) {
        memberMap.set(row.userId, { assigned: 0, completed: 0 });
      }
      const stats = memberMap.get(row.userId)!;
      stats.assigned += row.count;
      if (
        row.status === "reviewed" ||
        row.status === "approved"
      ) {
        stats.completed += row.count;
      }
    }

    for (const [userId, stats] of memberMap) {
      const member = members.find((m) => m.id === userId);
      if (member) {
        descriptionMembers.push({
          id: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
          assignedCount: stats.assigned,
          completedCount: stats.completed,
        });
      }
    }
  }

  // Count description volumes for tab badge
  const descriptionVolumeCount = descriptionVolumes.length;

  return {
    volumes: projectVolumes as VolumeRow[],
    cataloguers,
    reviewers,
    statusCounts,
    teamMembers,
    projectId: params.id,
    promotableVolumes,
    descriptionVolumes,
    globalProgress,
    descriptionMembers,
    descriptionVolumeCount,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, inArray } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { logActivity } = await import("../lib/workflow.server");
  const { promoteVolumeToDescription } = await import("../lib/description.server");
  const { volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  // Lead-only access
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  if (actionType === "promote") {
    const volumeId = formData.get("volumeId") as string;
    if (!volumeId) {
      return Response.json({ error: "volumeId required" }, { status: 400 });
    }

    await promoteVolumeToDescription(db, volumeId);

    await logActivity(db, user.id, "description_status_changed", {
      projectId: params.id,
      volumeId,
      detail: JSON.stringify({ action: "promote_to_description" }),
    });

    return Response.json({ ok: true });
  }

  if (actionType === "assign") {
    const volumeId = formData.get("volumeId") as string;
    const cataloguerId = formData.get("cataloguerId") as string | null;
    const reviewerId = formData.get("reviewerId") as string | null;

    if (!volumeId) {
      return Response.json({ error: "volumeId required" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (cataloguerId !== null) {
      updateData.assignedTo = cataloguerId === "" ? null : cataloguerId;
    }
    if (reviewerId !== null) {
      updateData.assignedReviewer = reviewerId === "" ? null : reviewerId;
    }

    await db.update(volumes).set(updateData).where(
      and(eq(volumes.id, volumeId), eq(volumes.projectId, params.id))
    );

    await logActivity(db, user.id, "assignment_changed", {
      projectId: params.id,
      volumeId,
      detail: JSON.stringify({
        cataloguerId: cataloguerId || null,
        reviewerId: reviewerId || null,
      }),
    });

    return Response.json({ ok: true });
  }

  if (actionType === "bulk-assign") {
    const volumeIdsJson = formData.get("volumeIds") as string;
    const cataloguerId = formData.get("cataloguerId") as string | null;
    const reviewerId = formData.get("reviewerId") as string | null;

    let volumeIds: string[];
    try {
      volumeIds = JSON.parse(volumeIdsJson);
    } catch {
      return Response.json({ error: "Invalid volumeIds" }, { status: 400 });
    }

    if (!Array.isArray(volumeIds) || volumeIds.length === 0) {
      return Response.json({ error: "No volumes specified" }, { status: 400 });
    }

    const updateData: Record<string, unknown> = { updatedAt: Date.now() };

    if (cataloguerId) {
      updateData.assignedTo =
        cataloguerId === "__unassign__" ? null : cataloguerId;
    }
    if (reviewerId) {
      updateData.assignedReviewer =
        reviewerId === "__unassign__" ? null : reviewerId;
    }

    // Chunk to stay under D1's 100-statement batch limit (89 leaves
    // a safety margin for additional batch members).
    const CHUNK_SIZE = 89;
    for (let i = 0; i < volumeIds.length; i += CHUNK_SIZE) {
      const chunk = volumeIds.slice(i, i + CHUNK_SIZE);
      const stmts: any[] = chunk.map((vid) =>
        db.update(volumes).set(updateData).where(
          and(eq(volumes.id, vid), eq(volumes.projectId, params.id))
        )
      );
      await db.batch(stmts as any);
    }

    // Log activity for each (chunked)
    for (let i = 0; i < volumeIds.length; i += CHUNK_SIZE) {
      const chunk = volumeIds.slice(i, i + CHUNK_SIZE);
      for (const vid of chunk) {
        await logActivity(db, user.id, "assignment_changed", {
          projectId: params.id,
          volumeId: vid,
          detail: JSON.stringify({
            cataloguerId: cataloguerId || null,
            reviewerId: reviewerId || null,
            bulk: true,
          }),
        });
      }
    }

    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}

export default function AssignmentsRoute({ loaderData }: Route.ComponentProps) {
  const {
    volumes: projectVolumes,
    cataloguers,
    reviewers,
    statusCounts,
    teamMembers,
    projectId,
    promotableVolumes,
    descriptionVolumes,
    globalProgress,
    descriptionMembers,
    descriptionVolumeCount,
  } = loaderData;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<SubTab>("segmentation");
  const { t } = useTranslation(["project", "description"]);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-stone-900">
        {t("project:heading.assignments")}
      </h2>

      {/* Sub-tabs */}
      <div className="border-b border-stone-200">
        <nav className="-mb-px flex gap-6">
          <button
            onClick={() => setActiveTab("segmentation")}
            className={`border-b-2 pb-2 text-sm font-medium transition-colors ${
              activeTab === "segmentation"
                ? "border-indigo text-indigo"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
            }`}
          >
            {t("description:tabs.segmentacion")}
            <span className="ml-1.5 inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
              {projectVolumes.length}
            </span>
          </button>
          <button
            onClick={() => setActiveTab("description")}
            className={`border-b-2 pb-2 text-sm font-medium transition-colors ${
              activeTab === "description"
                ? "border-indigo text-indigo"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-700"
            }`}
          >
            {t("description:tabs.descripcion")}
            {descriptionVolumeCount > 0 && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
                {descriptionVolumeCount}
              </span>
            )}
          </button>
        </nav>
      </div>

      {/* Segmentation tab content */}
      {activeTab === "segmentation" && (
        <div className="space-y-6">
          <StackedProgressBar counts={statusCounts} />

          <BulkToolbar
            selectedCount={selectedIds.size}
            selectedIds={selectedIds}
            cataloguers={cataloguers}
            reviewers={reviewers}
            onClear={() => setSelectedIds(new Set())}
          />

          <AssignmentTable
            volumes={projectVolumes}
            cataloguers={cataloguers}
            reviewers={reviewers}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />

          <TeamProgress members={teamMembers} />
        </div>
      )}

      {/* Description tab content */}
      {activeTab === "description" && (
        <DescriptionTabContent
          promotableVolumes={promotableVolumes}
          descriptionVolumes={descriptionVolumes}
          globalProgress={globalProgress}
          descriptionMembers={descriptionMembers}
          projectId={projectId}
        />
      )}
    </div>
  );
}
