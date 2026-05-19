/**
 * Member Dashboard — /proyectos
 *
 * This page is the signed-in member's landing surface: a merged view
 * of their work across every project they belong to, grouped into
 * Segmentation,
 * Description, and Messages sections. Reviewers and leads see two
 * columns (My work / To review) when their role justifies it;
 * cataloguers see a single column. Project administration (create,
 * archive, delete) is deliberately absent from this surface — those
 * operations live exclusively in `/admin/cataloguing/projects`.
 *
 * @version v0.3.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { BookOpen, ClipboardList, Settings, ArrowRight } from "lucide-react";
import { userContext } from "../context";
import { DashboardSection } from "../components/dashboard/dashboard-section";
import { VolumeStatusCard } from "../components/dashboard/volume-status-card";
import { DescriptionStatusBadge } from "../components/workflow/status-badge";
import type { Route } from "./+types/_auth.proyectos";

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql, inArray, and, desc } = await import("drizzle-orm");
  const {
    projects,
    projectMembers,
    volumes,
    entries,
    activityLog,
    comments,
    users,
    qcFlags,
  } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // 1. User's project memberships
  const memberships = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))
    .all();

  const projectIds = [...new Set(memberships.map((m) => m.projectId))];

  // Determine role capabilities
  const hasReviewerRole = memberships.some(
    (m) => m.role === "reviewer" || m.role === "lead"
  );
  const isCollabAdmin = user.isCollabAdmin || user.isSuperAdmin;

  // Build per-project role map (a user can be lead of one, cataloguer of another)
  const projectRoleMap = new Map<string, string>();
  for (const m of memberships) {
    const existing = projectRoleMap.get(m.projectId);
    // Keep the highest role: lead > reviewer > cataloguer
    if (!existing || m.role === "lead" || (m.role === "reviewer" && existing === "cataloguer")) {
      projectRoleMap.set(m.projectId, m.role);
    }
  }

  if (projectIds.length === 0) {
    return {
      showToReview: hasReviewerRole,
      isCollabAdmin,
      userProjects: [],
      segMyWork: [],
      segToReview: [],
      descMyWork: [],
      descToReview: [],
      messages: [],
    };
  }

  // Fetch project names for labels
  const projectList = await db
    .select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .where(inArray(projects.id, projectIds))
    .all();
  const projectNameMap = new Map(projectList.map((p) => [p.id, p.name]));

  // Build user's project list with roles for the management section
  const userProjects = projectList.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    role: projectRoleMap.get(p.id) || "cataloguer",
  }));

  // 2. Segmentation — My work: volumes assigned to me that still need work
  //    ('unstarted' surfaces a just-assigned volume immediately; 'in_progress'
  //    and 'sent_back' cover work resumed or returned by a reviewer).
  const segMyWork = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      status: volumes.status,
      projectId: volumes.projectId,
      pageCount: volumes.pageCount,
      updatedAt: volumes.updatedAt,
      reviewComment: volumes.reviewComment,
    })
    .from(volumes)
    .where(
      and(
        eq(volumes.assignedTo, user.id),
        inArray(volumes.status, ["unstarted", "in_progress", "sent_back"])
      )
    )
    .orderBy(desc(volumes.updatedAt))
    .all();

  // 3. Segmentation — To review: volumes where I'm the reviewer, status = segmented
  const segToReview = hasReviewerRole
    ? await db
        .select({
          id: volumes.id,
          name: volumes.name,
          status: volumes.status,
          projectId: volumes.projectId,
          pageCount: volumes.pageCount,
          updatedAt: volumes.updatedAt,
        })
        .from(volumes)
        .where(
          and(
            eq(volumes.assignedReviewer, user.id),
            eq(volumes.status, "segmented")
          )
        )
        .orderBy(desc(volumes.updatedAt))
        .all()
    : [];

  // 4. Description — My work: entries assigned to me for description
  const descMyWork = await db
    .select({
      id: entries.id,
      title: entries.title,
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(
      and(
        eq(entries.assignedDescriber, user.id),
        inArray(entries.descriptionStatus, [
          "assigned",
          "in_progress",
          "sent_back",
        ])
      )
    )
    .orderBy(desc(entries.updatedAt))
    .all();

  // 5. Description — To review: entries where I'm the description reviewer
  const descToReview = hasReviewerRole
    ? await db
        .select({
          id: entries.id,
          title: entries.title,
          descriptionStatus: entries.descriptionStatus,
          volumeId: entries.volumeId,
          updatedAt: entries.updatedAt,
        })
        .from(entries)
        .where(
          and(
            eq(entries.assignedDescriptionReviewer, user.id),
            eq(entries.descriptionStatus, "described")
          )
        )
        .orderBy(desc(entries.updatedAt))
        .all()
    : [];

  // Resolve volume -> project mapping for description entries
  const allVolumeIds = [
    ...new Set([
      ...descMyWork.map((e) => e.volumeId),
      ...descToReview.map((e) => e.volumeId),
    ]),
  ];
  const volumeProjectMap = new Map<string, { projectId: string; volumeName: string }>();
  if (allVolumeIds.length > 0) {
    const volumeRows = await db
      .select({
        id: volumes.id,
        projectId: volumes.projectId,
        name: volumes.name,
      })
      .from(volumes)
      .where(inArray(volumes.id, allVolumeIds))
      .all();
    for (const v of volumeRows) {
      volumeProjectMap.set(v.id, { projectId: v.projectId, volumeName: v.name });
    }
  }

  // Enrich description entries with project info
  const enrichDesc = (
    items: typeof descMyWork
  ) =>
    items.map((e) => {
      const vol = volumeProjectMap.get(e.volumeId);
      return {
        ...e,
        projectId: vol?.projectId ?? "",
        projectName: vol ? (projectNameMap.get(vol.projectId) ?? "") : "",
        volumeName: vol?.volumeName ?? "",
      };
    });

  // 6. Messages — activity log + comments from user's projects
  const recentActivity = await db
    .select({
      id: activityLog.id,
      event: activityLog.event,
      detail: activityLog.detail,
      createdAt: activityLog.createdAt,
      userId: activityLog.userId,
      projectId: activityLog.projectId,
    })
    .from(activityLog)
    .where(inArray(activityLog.projectId, projectIds))
    .orderBy(desc(activityLog.createdAt))
    .limit(50)
    .all();

  // Resolve user names for activity
  const actorIds = [...new Set(recentActivity.map((a) => a.userId))];
  const actorMap = new Map<string, string>();
  if (actorIds.length > 0) {
    const actorRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, actorIds))
      .all();
    for (const u of actorRows) {
      actorMap.set(u.id, u.name ?? u.id);
    }
  }

  const messagesData = recentActivity.map((a) => ({
    id: a.id,
    type: "activity" as const,
    event: a.event,
    detail: a.detail,
    createdAt: a.createdAt,
    actorName: actorMap.get(a.userId) ?? "",
    projectName: a.projectId ? (projectNameMap.get(a.projectId) ?? "") : "",
  }));

  // 7. Open QC flag counts for the volumes shown in the Segmentation section
  //   . One grouped query over the union of segMyWork +
  //    segToReview volume ids keeps this cheap — a single sub-millisecond
  //    SELECT at the current data scale.
  const segVolumeIds = [
    ...new Set([...segMyWork.map((v) => v.id), ...segToReview.map((v) => v.id)]),
  ];
  const openQcFlagCountByVolume = new Map<string, number>();
  if (segVolumeIds.length > 0) {
    const flagCounts = await db
      .select({
        volumeId: qcFlags.volumeId,
        count: sql<number>`COUNT(*)`,
      })
      .from(qcFlags)
      .where(
        and(
          inArray(qcFlags.volumeId, segVolumeIds),
          eq(qcFlags.status, "open")
        )
      )
      .groupBy(qcFlags.volumeId)
      .all();
    for (const row of flagCounts) {
      openQcFlagCountByVolume.set(row.volumeId, Number(row.count));
    }
  }

  return {
    showToReview: hasReviewerRole,
    isCollabAdmin,
    userProjects,
    segMyWork: segMyWork.map((v) => ({
      ...v,
      projectName: projectNameMap.get(v.projectId) ?? "",
      entryCount: 0,
      openQcFlagCount: openQcFlagCountByVolume.get(v.id) ?? 0,
    })),
    segToReview: segToReview.map((v) => ({
      ...v,
      projectName: projectNameMap.get(v.projectId) ?? "",
      entryCount: 0,
      openQcFlagCount: openQcFlagCountByVolume.get(v.id) ?? 0,
    })),
    descMyWork: enrichDesc(descMyWork),
    descToReview: enrichDesc(descToReview),
    messages: messagesData,
  };
}

export default function ProyectosPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation(["dashboard", "project", "workflow"]);
  const {
    showToReview,
    isCollabAdmin,
    userProjects,
    segMyWork,
    segToReview,
    descMyWork,
    descToReview,
    messages,
  } = loaderData;

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      <h1 className="font-serif text-2xl font-semibold text-stone-900">
        {t("dashboard:member_dashboard.page_title")}
      </h1>

      {/* Project management cards */}
      {userProjects.length > 0 && (
        <div className="mt-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {userProjects.map((p: any) => (
              <ProjectManagementCard key={p.id} project={p} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-8 space-y-10">
        {/* Segmentation section */}
        <DashboardSection
          id="segmentation"
          title={t("member_dashboard.section_segmentation")}
          myWorkLabel={t("member_dashboard.my_work")}
          toReviewLabel={t("member_dashboard.to_review")}
          showToReview={showToReview}
          myWorkEmpty={t("member_dashboard.empty_seg_my_work")}
          toReviewEmpty={t("member_dashboard.empty_seg_to_review")}
          myWorkItems={
            segMyWork.length > 0
              ? segMyWork.map((v: any) => (
                  <VolumeStatusCard
                    key={v.id}
                    volume={{
                      id: v.id,
                      name: v.name,
                      pageCount: v.pageCount,
                      entryCount: v.entryCount,
                      status: v.status,
                      projectId: v.projectId,
                      projectName: v.projectName,
                      updatedAt: v.updatedAt,
                      reviewComment: v.reviewComment,
                      openQcFlagCount: v.openQcFlagCount,
                    }}
                  />
                ))
              : null
          }
          toReviewItems={
            segToReview.length > 0
              ? segToReview.map((v: any) => (
                  <VolumeStatusCard
                    key={v.id}
                    volume={{
                      id: v.id,
                      name: v.name,
                      pageCount: v.pageCount,
                      entryCount: v.entryCount,
                      status: v.status,
                      projectId: v.projectId,
                      projectName: v.projectName,
                      updatedAt: v.updatedAt,
                    }}
                  />
                ))
              : null
          }
        />

        {/* Description section */}
        <DashboardSection
          id="description"
          title={t("member_dashboard.section_description")}
          myWorkLabel={t("member_dashboard.my_work")}
          toReviewLabel={t("member_dashboard.to_review")}
          showToReview={showToReview}
          myWorkEmpty={t("member_dashboard.empty_desc_my_work")}
          toReviewEmpty={t("member_dashboard.empty_desc_to_review")}
          myWorkItems={
            descMyWork.length > 0
              ? descMyWork.map((e: any) => (
                  <EntryCard
                    key={e.id}
                    entry={e}
                    isCollabAdmin={isCollabAdmin}
                  />
                ))
              : null
          }
          toReviewItems={
            descToReview.length > 0
              ? descToReview.map((e: any) => (
                  <EntryCard
                    key={e.id}
                    entry={e}
                    isCollabAdmin={isCollabAdmin}
                  />
                ))
              : null
          }
        />

        {/* Messages section */}
        <DashboardSection
          id="messages"
          title={t("member_dashboard.section_messages")}
          myWorkLabel={t("member_dashboard.my_work")}
          toReviewLabel={t("member_dashboard.to_review")}
          showToReview={false}
          myWorkEmpty={t("member_dashboard.empty_messages")}
          toReviewEmpty=""
          myWorkItems={
            messages.length > 0 ? <ActivityFeed items={messages} /> : null
          }
          toReviewItems={null}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entry card for description section
// ---------------------------------------------------------------------------

type EntryCardData = {
  id: string;
  title: string | null;
  descriptionStatus: string | null;
  volumeId: string;
  projectId: string;
  projectName: string;
  volumeName: string;
  updatedAt: number;
};

function EntryCard({
  entry,
  isCollabAdmin,
}: {
  entry: EntryCardData;
  isCollabAdmin: boolean;
}) {
  const { t } = useTranslation("dashboard");

  return (
    <div className="rounded-lg border border-stone-200 p-4 hover:shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-medium text-stone-900">
            {entry.title || t("unnamed")}
          </h3>
          <p className="mt-0.5 text-xs text-stone-500">
            {entry.projectName} — {entry.volumeName}
          </p>
        </div>
        {entry.descriptionStatus && (
          <DescriptionStatusBadge status={entry.descriptionStatus} />
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        {isCollabAdmin && (
          <Link
            to={`/projects/${entry.projectId}/overview`}
            className="text-xs text-indigo-deep hover:underline"
          >
            Overview
          </Link>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity feed for messages section
// ---------------------------------------------------------------------------

type ActivityItem = {
  id: string;
  type: "activity";
  event: string;
  detail: string | null;
  createdAt: number;
  actorName: string;
  projectName: string;
};

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  const { t } = useTranslation("dashboard");

  return (
    <div className="divide-y divide-stone-100">
      {items.map((item) => (
        <div key={item.id} className="py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-stone-900">
                <span className="font-medium">{item.actorName}</span>{" "}
                <span className="text-stone-600">
                  {t(`activity.event.${item.event}`)}
                </span>
              </p>
              {item.projectName && (
                <p className="mt-0.5 text-xs text-stone-500">
                  {item.projectName}
                </p>
              )}
            </div>
            <time className="shrink-0 text-xs text-stone-400">
              {formatTimestamp(item.createdAt)}
            </time>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project management card — links to volumes, assignments, settings
// ---------------------------------------------------------------------------

const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-verdigris-tint text-verdigris",
  cataloguer: "bg-indigo-tint text-indigo",
  reviewer: "bg-verdigris-tint text-verdigris",
  admin: "bg-indigo-tint text-indigo",
};

function ProjectManagementCard({
  project,
}: {
  project: { id: string; name: string; description: string | null; role: string };
}) {
  const { t } = useTranslation(["project", "workflow"]);
  const badgeColor = ROLE_BADGE_COLORS[project.role] || "bg-stone-100 text-stone-600";
  const isLead = project.role === "lead";

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-heading text-base font-semibold text-stone-700">
            {project.name}
          </h3>
          {project.description && (
            <p className="mt-0.5 text-xs text-stone-400 line-clamp-1">
              {project.description}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${badgeColor}`}
        >
          {t(`workflow:role.${project.role}`)}
        </span>
      </div>
      {isLead && (
        <div className="mt-3 flex items-center gap-3">
          <Link
            to={`/projects/${project.id}/volumes`}
            className="inline-flex items-center gap-1 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs font-medium text-stone-700 ring-1 ring-stone-200 hover:bg-stone-100"
          >
            <BookOpen className="h-3.5 w-3.5" />
            {t("project:tab.volumes")}
          </Link>
          <Link
            to={`/projects/${project.id}/assignments`}
            className="inline-flex items-center gap-1 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs font-medium text-stone-700 ring-1 ring-stone-200 hover:bg-stone-100"
          >
            <ClipboardList className="h-3.5 w-3.5" />
            {t("project:tab.assignments")}
          </Link>
          <Link
            to={`/projects/${project.id}/settings`}
            className="inline-flex items-center gap-1 rounded-md bg-stone-50 px-2.5 py-1.5 text-xs font-medium text-stone-700 ring-1 ring-stone-200 hover:bg-stone-100"
          >
            <Settings className="h-3.5 w-3.5" />
            {t("project:tab.settings")}
          </Link>
        </div>
      )}
      {!isLead && (
        <div className="mt-3">
          <Link
            to={`/projects/${project.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-indigo hover:underline"
          >
            {t("project:tab.open_project")}
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * Format a Unix epoch timestamp as YYYY-MM-DD HH:MM.
 */
function formatTimestamp(epoch: number): string {
  const d = new Date(epoch);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
