/**
 * Cataloguing Admin — Team
 *
 * This page is the per-project membership administration surface: which users belong to which
 * project and in which role (lead, reviewer, cataloguer). Cataloguing
 * admins and superadmins can add, remove, and reassign members from
 * here; the page pairs a project selector with the member table.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Reads of `users` are filtered by `tenant.id`;
 * project tables (`projects`, `project_members`, `volumes`,
 * `entries`) inherit tenant scope through the user FK chain
 * (memberships only join users that already belong to the tenant).
 *
 * @version v0.4.0
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import type { Route } from "./+types/_auth.admin.cataloguing.team";

interface TeamMember {
  id: string;
  name: string | null;
  email: string;
  projects: { membershipId: string; projectId: string; projectName: string; role: string }[];
  activeVolumes: number;
  activeEntries: number;
  isIdle: boolean;
}

interface AvailableProject {
  id: string;
  name: string;
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-saffron-tint text-saffron-deep",
  cataloguer: "bg-indigo-tint text-indigo",
  reviewer: "bg-verdigris-tint text-verdigris",
};

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, inArray, isNull, sql } = await import("drizzle-orm");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { users, projectMembers, projects, volumes, entries } = await import(
    "../db/schema"
  );

  const user = context.get(userContext);
  requireCollabAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // 1. Get all users who are project members or collab admins
  const allUsersRaw = await db
    .select()
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .all();

  const memberUserIds = await db
    .selectDistinct({ userId: projectMembers.userId })
    .from(projectMembers)
    .all();
  const memberIdSet = new Set(memberUserIds.map((m) => m.userId));

  const relevantUsers = allUsersRaw.filter(
    (u) =>
      u.isCollabAdmin ||
      u.isSuperAdmin ||
      u.isCataloguer ||
      memberIdSet.has(u.id)
  );

  // 2. Query all project memberships
  const allMemberships = await db
    .select({
      id: projectMembers.id,
      userId: projectMembers.userId,
      projectId: projectMembers.projectId,
      role: projectMembers.role,
      projectName: projects.name,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .all();

  // 3. Query volume workload per user
  const volumeWorkload = await db
    .select({
      assignedTo: volumes.assignedTo,
      count: sql<number>`COUNT(*)`,
    })
    .from(volumes)
    .where(inArray(volumes.status, ["in_progress", "sent_back"]))
    .groupBy(volumes.assignedTo)
    .all();

  const volumeCountMap = new Map(
    volumeWorkload
      .filter((v) => v.assignedTo !== null)
      .map((v) => [v.assignedTo!, v.count])
  );

  // 4. Query entry workload per user
  const entryWorkload = await db
    .select({
      assignedDescriber: entries.assignedDescriber,
      count: sql<number>`COUNT(*)`,
    })
    .from(entries)
    .where(
      inArray(entries.descriptionStatus, ["assigned", "in_progress", "sent_back"])
    )
    .groupBy(entries.assignedDescriber)
    .all();

  const entryCountMap = new Map(
    entryWorkload
      .filter((e) => e.assignedDescriber !== null)
      .map((e) => [e.assignedDescriber!, e.count])
  );

  // 5. Get all non-archived projects for the assign dropdown
  const availableProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .all();

  // 6. Merge into team list
  const membershipsByUser = new Map<
    string,
    { membershipId: string; projectId: string; projectName: string; role: string }[]
  >();
  for (const m of allMemberships) {
    const list = membershipsByUser.get(m.userId) || [];
    list.push({
      membershipId: m.id,
      projectId: m.projectId,
      projectName: m.projectName,
      role: m.role,
    });
    membershipsByUser.set(m.userId, list);
  }

  const teamList: TeamMember[] = relevantUsers.map((u) => {
    const userProjects = membershipsByUser.get(u.id) || [];
    const activeVolumes = volumeCountMap.get(u.id) || 0;
    const activeEntries = entryCountMap.get(u.id) || 0;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      projects: userProjects,
      activeVolumes,
      activeEntries,
      isIdle: userProjects.length === 0 && activeVolumes === 0 && activeEntries === 0,
    };
  });

  // 7. Sort: idle users last, then by name
  teamList.sort((a, b) => {
    if (a.isIdle !== b.isIdle) return a.isIdle ? 1 : -1;
    const nameA = (a.name || a.email).toLowerCase();
    const nameB = (b.name || b.email).toLowerCase();
    return nameA.localeCompare(nameB);
  });

  return { team: teamList, availableProjects };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { z } = await import("zod");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { users, projectMembers, projects } = await import("../db/schema");

  const user = context.get(userContext);
  requireCollabAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "assignToProject") {
    const roleSchema = z.enum(["lead", "cataloguer", "reviewer"]);
    const userId = formData.get("userId") as string;
    const projectId = formData.get("projectId") as string;
    const roleRaw = formData.get("role") as string;

    const roleResult = roleSchema.safeParse(roleRaw);
    if (!roleResult.success) {
      return { ok: false, error: "Invalid role" };
    }

    // Verify userId exists in the calling tenant
    const [targetUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenant.id), eq(users.id, userId)))
      .limit(1)
      .all();
    if (!targetUser) {
      return { ok: false, error: i18n.t("team:error_user_not_found") };
    }

    // Verify projectId exists
    const [targetProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .all();
    if (!targetProject) {
      return { ok: false, error: i18n.t("team:error_project_not_found") };
    }

    // Check for duplicate membership
    const existing = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId)
        )
      )
      .limit(1)
      .all();
    if (existing.length > 0) {
      return { ok: false, error: i18n.t("team:error_already_member") };
    }

    await db.insert(projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId,
      role: roleResult.data,
      createdAt: (Date.now() / 1000) | 0,
    });

    return { ok: true, message: i18n.t("team:success_assigned") };
  }

  if (intent === "removeFromProject") {
    const membershipId = formData.get("membershipId") as string;

    // Verify membership exists
    const [membership] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(eq(projectMembers.id, membershipId))
      .limit(1)
      .all();
    if (!membership) {
      return { ok: false, error: i18n.t("team:error_membership_not_found") };
    }

    await db
      .delete(projectMembers)
      .where(eq(projectMembers.id, membershipId));

    return { ok: true, message: i18n.t("team:success_removed") };
  }

  return { ok: false, error: "Unknown action" };
}

function AssignForm({
  userId,
  availableProjects,
  onClose,
}: {
  userId: string;
  availableProjects: AvailableProject[];
  onClose: () => void;
}) {
  const { t } = useTranslation("team");
  const fetcher = useFetcher();

  return (
    <fetcher.Form
      method="post"
      className="mt-2 flex items-end gap-2"
      onSubmit={() => {
        setTimeout(onClose, 100);
      }}
    >
      <input type="hidden" name="_action" value="assignToProject" />
      <input type="hidden" name="userId" value={userId} />

      <select
        name="projectId"
        required
        className="rounded-lg border border-stone-200 px-2 py-1.5 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
      >
        <option value="">{t("select_project")}</option>
        {availableProjects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        name="role"
        required
        className="rounded-lg border border-stone-200 px-2 py-1.5 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
      >
        <option value="">{t("select_role")}</option>
        <option value="lead">{t("role_lead")}</option>
        <option value="cataloguer">{t("role_cataloguer")}</option>
        <option value="reviewer">{t("role_reviewer")}</option>
      </select>

      <button
        type="submit"
        className="rounded-md bg-indigo px-3 py-1.5 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
      >
        {t("assign")}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg border border-stone-200 px-3 py-1.5 font-sans text-sm text-stone-500 hover:bg-stone-50"
      >
        {t("cancel")}
      </button>
    </fetcher.Form>
  );
}

function RemoveButton({
  membershipId,
  userName,
  projectName,
}: {
  membershipId: string;
  userName: string;
  projectName: string;
}) {
  const { t } = useTranslation("team");
  const fetcher = useFetcher();

  return (
    <fetcher.Form method="post" className="inline">
      <input type="hidden" name="_action" value="removeFromProject" />
      <input type="hidden" name="membershipId" value={membershipId} />
      <button
        type="submit"
        className="ml-1 text-stone-400 hover:text-indigo"
        title={t("remove_from_project")}
        onClick={(e) => {
          if (
            !confirm(
              t("confirm_remove", { name: userName, project: projectName })
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        &times;
      </button>
    </fetcher.Form>
  );
}

export default function AdminCataloguingTeam({
  loaderData,
}: Route.ComponentProps) {
  const { team, availableProjects } = loaderData;
  const { t } = useTranslation("team");
  const [assigningUserId, setAssigningUserId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <h1 className="font-display text-4xl font-semibold text-stone-700">
        {t("title")}
      </h1>

      {/* Role legend */}
      <div className="flex flex-wrap items-center gap-3 font-sans text-xs text-stone-500">
        <span className="font-semibold uppercase tracking-wider">
          {t("roles_legend")}
        </span>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${ROLE_BADGE_COLORS.lead}`}>
          {t("role_lead")}
        </span>
        <span className="text-stone-500">{t("role_lead_description")}</span>
        <span className="text-stone-300">·</span>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${ROLE_BADGE_COLORS.cataloguer}`}>
          {t("role_cataloguer")}
        </span>
        <span className="text-stone-500">{t("role_cataloguer_description")}</span>
        <span className="text-stone-300">·</span>
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${ROLE_BADGE_COLORS.reviewer}`}>
          {t("role_reviewer")}
        </span>
        <span className="text-stone-500">{t("role_reviewer_description")}</span>
      </div>

      {team.length === 0 ? (
        <p className="font-sans text-sm text-stone-400">
          {t("idle")}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200">
          <table className="min-w-full divide-y divide-stone-200">
            <thead className="bg-stone-50">
              <tr>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("name")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("email")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("projects")}
                </th>
                <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-stone-500">
                  {t("active_volumes")}
                </th>
                <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-stone-500">
                  {t("active_entries")}
                </th>
                <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-stone-500">
                  {/* Actions column */}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {team.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3 font-sans text-sm font-semibold text-stone-700">
                    {member.name || "\u2014"}
                  </td>
                  <td className="px-4 py-3 font-sans text-sm text-stone-500">
                    {member.email}
                  </td>
                  <td className="px-4 py-3">
                    {member.isIdle ? (
                      <span className="font-sans text-xs text-stone-400">
                        {t("idle")}
                      </span>
                    ) : member.projects.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {member.projects.map((p) => (
                          <span
                            key={p.membershipId}
                            className="inline-flex items-center gap-1"
                          >
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_BADGE_COLORS[p.role] || "bg-stone-100 text-stone-600"}`}
                            >
                              {p.projectName}
                              <span className="ml-1 font-normal opacity-70">
                                ({t(`role_${p.role}`)})
                              </span>
                            </span>
                            <RemoveButton
                              membershipId={p.membershipId}
                              userName={member.name || member.email}
                              projectName={p.projectName}
                            />
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="font-sans text-xs text-stone-400">
                        {t("idle")}
                      </span>
                    )}
                    {assigningUserId === member.id && (
                      <AssignForm
                        userId={member.id}
                        availableProjects={availableProjects}
                        onClose={() => setAssigningUserId(null)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-sans text-sm text-stone-700">
                    {member.activeVolumes}
                  </td>
                  <td className="px-4 py-3 text-right font-sans text-sm text-stone-700">
                    {member.activeEntries}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {assigningUserId !== member.id && (
                      <button
                        type="button"
                        onClick={() => setAssigningUserId(member.id)}
                        className="font-sans text-xs text-stone-500 hover:text-stone-700"
                      >
                        {t("assign_to_project")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
