/**
 * User Activity Page
 *
 * This page is the per-user activity surface reached from the
 * project members table and from the user's own avatar menu. The
 * loader fans out a single `getActivityForUser` call that returns
 * both a chronological timeline of milestone events (volume
 * transitions, entry workflow moves, QC flag raises and resolutions)
 * and a per-volume progress digest, then renders them through two
 * client-side tabs — "Recent activity" and "Volumes" — so the lead
 * can drill from "what has this teammate been doing" to "where do
 * their volumes stand right now" without a separate round-trip.
 *
 * Visibility is intentionally tiered: a user can always see their own
 * activity, a lead can see any team member's activity inside a
 * project they lead, but cataloguers and reviewers cannot peek at
 * each other — that would turn the timeline into a surveillance
 * surface and erode the workflow's trust assumptions.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { relativeTime } from "~/lib/format";
import { StatusBadge } from "../components/workflow/status-badge";
import type { Route } from "./+types/_auth.users.$userId.activity";

export function meta({ data }: Route.MetaArgs) {
  const name = data?.targetUser?.name ?? "Usuario";
  return [
    { title: `${name} - Actividad` },
    { name: "description", content: `Actividad de ${name}` },
  ];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, inArray, sql } = await import("drizzle-orm");
  const { getActivityForUser } = await import("../lib/activity.server");
  const {
    users,
    projectMembers,
    volumes,
    entries,
    projects,
  } = await import("../db/schema");

  const currentUser = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);
  const targetUserId = params.userId;

  // --- Visibility check ---
  const isSelf = currentUser.id === targetUserId;

  if (!isSelf && !currentUser.isAdmin) {
    // Check if current user is lead on any project where target is a member
    const currentUserMemberships = await db
      .select({
        projectId: projectMembers.projectId,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .where(eq(projectMembers.userId, currentUser.id))
      .all();

    const leadProjectIds = currentUserMemberships
      .filter((m) => m.role === "lead")
      .map((m) => m.projectId);

    if (leadProjectIds.length === 0) {
      throw new Response("Forbidden", { status: 403 });
    }

    // Check target is member of any project where current user is lead
    const targetMemberships = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, targetUserId))
      .all();

    const targetProjectIds = new Set(
      targetMemberships.map((m) => m.projectId)
    );
    const hasSharedProject = leadProjectIds.some((pid) =>
      targetProjectIds.has(pid)
    );

    if (!hasSharedProject) {
      throw new Response("Forbidden", { status: 403 });
    }
  }

  // --- Fetch target user info ---
  const targetUserRows = await db
    .select({
      id: users.id,
      name: users.name,
      lastActiveAt: users.lastActiveAt,
    })
    .from(users)
    .where(eq(users.id, targetUserId))
    .all();

  if (targetUserRows.length === 0) {
    throw new Response("Not found", { status: 404 });
  }

  const targetUser = targetUserRows[0];

  // Target user's roles across projects
  const targetRoles = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(eq(projectMembers.userId, targetUserId))
    .all();

  const roles = [...new Set(targetRoles.map((r) => r.role))];

  // --- Activity log ---
  const activityEntries = await getActivityForUser(db, targetUserId, 50);

  // Enrich activity entries with project names
  const activityProjectIds = [
    ...new Set(activityEntries.map((a) => a.projectId).filter(Boolean)),
  ] as string[];

  let projectNameMap = new Map<string, string>();
  if (activityProjectIds.length > 0) {
    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, activityProjectIds))
      .all();
    projectNameMap = new Map(projectRows.map((p) => [p.id, p.name]));
  }

  const activity = activityEntries.map((a) => ({
    id: a.id,
    event: a.event,
    detail: a.detail,
    projectName: a.projectId ? projectNameMap.get(a.projectId) ?? null : null,
    createdAt: a.createdAt,
  }));

  // --- Volumes assigned to target user ---
  const assignedVolumes = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      pageCount: volumes.pageCount,
      status: volumes.status,
      projectId: volumes.projectId,
      updatedAt: volumes.updatedAt,
    })
    .from(volumes)
    .where(eq(volumes.assignedTo, targetUserId))
    .all();

  // Also get volumes where target is reviewer
  const reviewingVolumes = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      pageCount: volumes.pageCount,
      status: volumes.status,
      projectId: volumes.projectId,
      updatedAt: volumes.updatedAt,
    })
    .from(volumes)
    .where(eq(volumes.assignedReviewer, targetUserId))
    .all();

  // Merge unique volumes
  const allVolumeMap = new Map<string, (typeof assignedVolumes)[0]>();
  for (const v of [...assignedVolumes, ...reviewingVolumes]) {
    allVolumeMap.set(v.id, v);
  }
  const allVolumes = Array.from(allVolumeMap.values());

  // Entry counts
  let entryCountMap = new Map<string, number>();
  if (allVolumes.length > 0) {
    const volumeIds = allVolumes.map((v) => v.id);
    const entryCounts = await db
      .select({
        volumeId: entries.volumeId,
        count: sql<number>`count(*)`.as("count"),
      })
      .from(entries)
      .where(inArray(entries.volumeId, volumeIds))
      .groupBy(entries.volumeId)
      .all();
    entryCountMap = new Map(entryCounts.map((e) => [e.volumeId, e.count]));
  }

  // Project names for volumes
  const volProjectIds = [...new Set(allVolumes.map((v) => v.projectId))];
  if (volProjectIds.length > 0) {
    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, volProjectIds))
      .all();
    for (const p of projectRows) {
      projectNameMap.set(p.id, p.name);
    }
  }

  const volumeData = allVolumes
    .map((v) => ({
      id: v.id,
      name: v.name,
      pageCount: v.pageCount,
      entryCount: entryCountMap.get(v.id) ?? 0,
      status: v.status,
      projectId: v.projectId,
      projectName: projectNameMap.get(v.projectId) ?? "",
      updatedAt: v.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    targetUser: {
      ...targetUser,
      roles,
    },
    activity,
    volumes: volumeData,
  };
}

const ROLE_BADGE_STYLES: Record<string, string> = {
  lead: "bg-saffron-tint text-saffron-deep",
  cataloguer: "bg-indigo-tint text-indigo",
  reviewer: "bg-verdigris-tint text-verdigris",
};

export default function UserActivity({ loaderData }: Route.ComponentProps) {
  const { targetUser, activity, volumes } = loaderData;
  const [tab, setTab] = useState<"activity" | "volumes">("activity");
  const { t } = useTranslation(["dashboard", "workflow", "project", "common"]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="font-sans text-[2rem] font-semibold text-stone-700">
          {targetUser.name || t("dashboard:activity.unnamed_user")}
        </h1>
        {targetUser.roles.map((role) => (
          <span
            key={role}
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-sans text-xs font-semibold ${
              ROLE_BADGE_STYLES[role] ?? "bg-stone-200 text-stone-500"
            }`}
          >
            {t(`workflow:role.${role}`)}
          </span>
        ))}
      </div>
      {targetUser.lastActiveAt && (
        <p className="mt-1 font-sans text-sm text-stone-400">
          {t("dashboard:activity.last_active", { time: relativeTime(targetUser.lastActiveAt) })}
        </p>
      )}

      {/* Tabs */}
      <div className="mt-6 border-b border-stone-200">
        <nav className="-mb-px flex gap-6">
          <button
            type="button"
            onClick={() => setTab("activity")}
            className={`border-b-2 pb-3 font-sans text-sm font-medium ${
              tab === "activity"
                ? "border-indigo text-indigo"
                : "border-transparent text-stone-500 hover:text-stone-700"
            }`}
          >
            {t("dashboard:activity.tab_activity")}
          </button>
          <button
            type="button"
            onClick={() => setTab("volumes")}
            className={`border-b-2 pb-3 font-sans text-sm font-medium ${
              tab === "volumes"
                ? "border-indigo text-indigo"
                : "border-transparent text-stone-500 hover:text-stone-700"
            }`}
          >
            {t("dashboard:activity.tab_volumes", { count: volumes.length })}
          </button>
        </nav>
      </div>

      {/* Tab content */}
      <div className="mt-6">
        {tab === "activity" ? (
          <ActivityTab activity={activity} />
        ) : (
          <VolumesTab volumes={volumes} />
        )}
      </div>
    </div>
  );
}

function ActivityTab({
  activity,
}: {
  activity: {
    id: string;
    event: string;
    detail: string | null;
    projectName: string | null;
    createdAt: number;
  }[];
}) {
  const { t } = useTranslation("dashboard");

  if (activity.length === 0) {
    return (
      <p className="font-sans text-sm text-stone-400">{t("activity.no_activity")}</p>
    );
  }

  return (
    <div className="space-y-0 divide-y divide-stone-100">
      {activity.map((entry) => (
        <div key={entry.id} className="flex items-start gap-3 py-3">
          <div className="flex-1">
            <p className="font-sans text-sm text-stone-700">
              {describeEvent(t, entry.event, entry.detail)}
            </p>
            {entry.projectName && (
              <p className="mt-0.5 font-sans text-xs text-stone-400">
                {entry.projectName}
              </p>
            )}
          </div>
          <span className="shrink-0 font-sans text-xs text-stone-400">
            {relativeTime(entry.createdAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

function describeEvent(
  t: (key: string, options?: Record<string, unknown>) => string,
  event: string,
  detail: string | null
): string {
  const baseKey = `activity.event.${event}`;
  const base = t(baseKey);

  if (!detail) return base;

  try {
    const d = JSON.parse(detail);
    if (event === "status_changed" && d.to) {
      return t("activity.event.status_changed_to", { to: d.to });
    }
    if (event === "volume_opened" && d.volumeName) {
      return t("activity.event.volume_opened_detail", { name: d.volumeName });
    }
    if (event === "assignment_changed" && d.volumeName) {
      return t("activity.event.assignment_changed_detail", { name: d.volumeName });
    }
    if (event === "description_status_changed" && d.to) {
      return t("activity.event.description_status_changed_to", { to: d.to });
    }
    if (event === "description_assignment_changed" && d.entryTitle) {
      return t("activity.event.description_assignment_changed_detail", { title: d.entryTitle });
    }
    if (event === "resegmentation_flagged" && d.volumeName) {
      return t("activity.event.resegmentation_flagged_detail", { name: d.volumeName });
    }
    if (event === "comment_added" && d.entryTitle) {
      return t("activity.event.comment_added_detail", { title: d.entryTitle });
    }
    return base;
  } catch {
    return base;
  }
}

function VolumesTab({
  volumes,
}: {
  volumes: {
    id: string;
    name: string;
    pageCount: number;
    entryCount: number;
    status: string;
    projectId: string;
    projectName: string;
    updatedAt: number;
  }[];
}) {
  const { t } = useTranslation(["dashboard", "project"]);

  if (volumes.length === 0) {
    return (
      <p className="font-sans text-sm text-stone-400">{t("dashboard:activity.no_volumes")}</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead className="border-b border-stone-200">
          <tr>
            <th className="pb-2.5 pr-4 font-sans text-xs font-medium uppercase text-stone-500">
              {t("project:table.volume")}
            </th>
            <th className="pb-2.5 pr-4 font-sans text-xs font-medium uppercase text-stone-500">
              {t("project:table.project", { defaultValue: "Proyecto" })}
            </th>
            <th className="pb-2.5 pr-4 font-sans text-xs font-medium uppercase text-stone-500">
              {t("project:table.status")}
            </th>
            <th className="pb-2.5 pr-4 text-right font-sans text-xs font-medium uppercase text-stone-500">
              {t("project:table.images")}
            </th>
            <th className="pb-2.5 pr-4 text-right font-sans text-xs font-medium uppercase text-stone-500">
              {t("project:table.entries")}
            </th>
            <th className="pb-2.5 text-right font-sans text-xs font-medium uppercase text-stone-500">
              {t("project:table.last_worked")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {volumes.map((vol) => (
            <tr key={vol.id}>
              <td className="py-2.5 pr-4">
                <a
                  href={`/projects/${vol.projectId}/volumes/${vol.id}`}
                  className="font-serif text-sm font-semibold text-stone-700 hover:underline"
                >
                  {vol.name}
                </a>
              </td>
              <td className="py-2.5 pr-4 font-sans text-sm text-stone-500">{vol.projectName}</td>
              <td className="py-2.5 pr-4">
                <StatusBadge status={vol.status} />
              </td>
              <td className="py-2.5 pr-4 text-right font-sans text-sm text-stone-500">
                {vol.pageCount}
              </td>
              <td className="py-2.5 pr-4 text-right font-sans text-sm text-stone-500">
                {vol.entryCount}
              </td>
              <td className="py-2.5 text-right font-sans text-xs text-stone-400">
                {relativeTime(vol.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
