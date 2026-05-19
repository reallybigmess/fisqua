/**
 * Cataloguing Admin — Projects
 *
 * This page is the admin surface for creating, archiving, and restoring cataloguing
 * projects. Lists every active and archived project, shows membership
 * counts, and exposes the new-project dialog. Destructive actions are
 * gated behind a confirm dialog and record an audit trail.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { useFetcher, useActionData, useSearchParams, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { userContext } from "../context";
import { formatDate } from "~/lib/format";
import type { Route } from "./+types/_auth.admin.cataloguing.projects";

interface ProjectMember {
  userId: string;
  name: string | null;
  email: string;
  role: string;
}

interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  memberCount: number;
  volumeCount: number;
  leads: string[];
  members: ProjectMember[];
  statusCounts: Record<string, number>;
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-verdigris-tint text-verdigris",
  cataloguer: "bg-indigo-tint text-indigo",
  reviewer: "bg-verdigris-tint text-verdigris",
};

const STATUS_BADGE_COLORS: Record<string, string> = {
  unstarted: "bg-stone-100 text-stone-600",
  in_progress: "bg-indigo-tint text-indigo",
  segmented: "bg-verdigris-tint text-verdigris",
  sent_back: "bg-saffron-tint text-saffron-deep",
  reviewed: "bg-verdigris-tint text-verdigris",
  approved: "bg-verdigris-tint text-verdigris",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, desc, isNull, isNotNull, sql } = await import("drizzle-orm");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { projects, projectMembers, users, volumes } = await import("../db/schema");

  const user = context.get(userContext);
  requireCollabAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const url = new URL(request.url);
  const showArchived = url.searchParams.get("archived") === "true";

  const allProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(showArchived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt))
    .orderBy(desc(projects.updatedAt))
    .all();

  const projectDetails: ProjectDetail[] = await Promise.all(
    allProjects.map(async (project) => {
      // Members
      const memberRows = await db
        .select({
          userId: projectMembers.userId,
          role: projectMembers.role,
          userName: users.name,
          userEmail: users.email,
        })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.id))
        .where(eq(projectMembers.projectId, project.id))
        .all();

      const uniqueMembers = new Set(memberRows.map((m) => m.userId));
      const leads = memberRows
        .filter((m) => m.role === "lead")
        .map((m) => m.userName || m.userEmail);

      const members: ProjectMember[] = memberRows.map((m) => ({
        userId: m.userId,
        name: m.userName,
        email: m.userEmail,
        role: m.role,
      }));

      // Volume status counts
      const volumeRows = await db
        .select({ status: volumes.status, count: sql<number>`count(*)` })
        .from(volumes)
        .where(eq(volumes.projectId, project.id))
        .groupBy(volumes.status)
        .all();

      const statusCounts: Record<string, number> = {};
      let volumeCount = 0;
      for (const row of volumeRows) {
        statusCounts[row.status] = row.count;
        volumeCount += row.count;
      }

      return {
        ...project,
        memberCount: uniqueMembers.size,
        volumeCount,
        leads,
        members,
        statusCounts,
      };
    })
  );

  return { projects: projectDetails, showArchived };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { z } = await import("zod");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { projects } = await import("../db/schema");

  const user = context.get(userContext);
  requireCollabAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "createProject") {
    const nameSchema = z.string().min(3).max(100);
    const nameRaw = (formData.get("name") as string) || "";
    const description = (formData.get("description") as string) || null;

    const nameResult = nameSchema.safeParse(nameRaw.trim());
    if (!nameResult.success) {
      return { ok: false, error: i18n.t("admin:error.invalid_name") };
    }

    const { createProject } = await import("~/lib/projects.server");
    await createProject(
      db,
      { name: nameResult.data, description },
      user.id
    );

    return { ok: true, message: i18n.t("admin:error.project_created") };
  }

  return { ok: false, error: i18n.t("admin:error.unknown_action") };
}

function CreateProjectButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("admin");
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
    >
      {t("admin:action.new_project")}
    </button>
  );
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["admin", "common"]);
  const fetcher = useFetcher();

  return (
    <fetcher.Form
      method="post"
      className="mt-4 rounded-lg border border-stone-200 bg-white p-4"
      onSubmit={() => setTimeout(onClose, 100)}
    >
      <input type="hidden" name="_action" value="createProject" />
      <div className="space-y-3">
        <div>
          <label
            htmlFor="create-name"
            className="block font-sans text-sm font-medium text-indigo"
          >
            {t("admin:table.project")}
          </label>
          <input
            type="text"
            id="create-name"
            name="name"
            required
            minLength={3}
            maxLength={100}
            className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="create-description"
            className="block font-sans text-sm font-medium text-indigo"
          >
            {t("admin:table.description")}
          </label>
          <textarea
            id="create-description"
            name="description"
            rows={2}
            className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("common:button.save")}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-stone-200 px-4 py-2 font-sans text-sm text-stone-500 hover:bg-stone-50"
          >
            {t("common:button.cancel")}
          </button>
        </div>
      </div>
    </fetcher.Form>
  );
}

function ProjectRow({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation(["admin", "common", "workflow"]);
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border-b border-stone-100 last:border-b-0">
      <div
        className="flex cursor-pointer items-center px-4 py-3 hover:bg-stone-50"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="mr-2 font-sans text-xs text-stone-400">
          {isExpanded ? "\u25BC" : "\u25B6"}
        </span>
        <div className="flex-1">
          <span className="font-serif text-sm font-semibold text-stone-700">
            {project.name}
          </span>
          {project.description && (
            <p className="mt-0.5 max-w-xs truncate font-sans text-xs text-stone-400">
              {project.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-6 text-right">
          <span className="font-sans text-sm text-stone-500">
            {project.leads.length > 0 ? project.leads.join(", ") : "\u2014"}
          </span>
          <span className="font-sans text-sm text-stone-500">
            {t("admin:table.members")}: {project.memberCount}
          </span>
          <span className="font-sans text-sm text-stone-500">
            {t("admin:table.volumes")}: {project.volumeCount}
          </span>
          <span className="font-sans text-xs text-stone-400">
            {formatDate(project.createdAt)}
          </span>
          <Link
            to={`/projects/${project.id}/settings`}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo px-2.5 py-1 font-sans text-xs font-semibold text-parchment hover:bg-indigo-deep"
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink className="h-3 w-3" />
            {t("admin:action.open_project")}
          </Link>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-stone-100 bg-stone-50 px-4 py-4">
          {/* Team overview (read-only) */}
          <div>
            <h3 className="font-sans text-sm font-semibold text-stone-700">
              {t("admin:table.members")} ({project.memberCount})
            </h3>
            {project.members.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {project.members.map((member, i) => (
                  <span
                    key={`${member.userId}-${member.role}-${i}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 ring-1 ring-stone-200"
                  >
                    <span className="font-sans text-xs text-stone-700">
                      {member.name || member.email}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 font-sans text-[10px] font-semibold ${ROLE_BADGE_COLORS[member.role] || "bg-stone-100 text-stone-600"}`}
                    >
                      {t(`workflow:role.${member.role}`)}
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 font-sans text-xs text-stone-400">
                {t("admin:empty.no_users")}
              </p>
            )}
          </div>

          {/* Volume progress (read-only) */}
          <div className="mt-5">
            <h3 className="font-sans text-sm font-semibold text-stone-700">
              {t("admin:table.volumes")} ({project.volumeCount})
            </h3>
            {project.volumeCount > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(project.statusCounts).map(([status, count]) => (
                  <span
                    key={status}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-sans text-xs font-semibold ${STATUS_BADGE_COLORS[status] || "bg-stone-100 text-stone-600"}`}
                  >
                    {status.replace(/_/g, " ")}
                    <span className="font-normal">({count})</span>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 font-sans text-xs text-stone-400">
                {t("admin:empty.no_volumes")}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminCataloguingProjects({
  loaderData,
}: Route.ComponentProps) {
  const { projects: allProjects, showArchived } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation(["admin", "common"]);
  const [showCreateForm, setShowCreateForm] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-4xl font-semibold text-stone-700">
            {showArchived
              ? t("admin:heading.archived_projects")
              : t("admin:heading.all_projects")}
          </h1>
          <a
            href={
              showArchived
                ? "/admin/cataloguing/projects"
                : "/admin/cataloguing/projects?archived=true"
            }
            className="font-sans text-sm text-stone-500 hover:text-stone-700"
          >
            {showArchived
              ? t("admin:action.show_active")
              : t("admin:action.show_archived")}
          </a>
        </div>
        {!showArchived && !showCreateForm && (
          <CreateProjectButton onClick={() => setShowCreateForm(true)} />
        )}
      </div>

      {showCreateForm && (
        <CreateProjectForm onClose={() => setShowCreateForm(false)} />
      )}

      {actionData?.message && (
        <div
          className={`mt-3 rounded-md border px-4 py-3 font-sans text-sm ${actionData.ok ? "border-verdigris bg-verdigris-tint text-stone-700" : "border-indigo bg-indigo-tint text-stone-700"}`}
        >
          {actionData.message}
        </div>
      )}
      {actionData && !actionData.ok && actionData.error && (
        <div className="mt-3 rounded-md border border-indigo bg-indigo-tint px-4 py-3 font-sans text-sm text-stone-700">
          {actionData.error}
        </div>
      )}

      {allProjects.length === 0 ? (
        <p className="mt-4 font-sans text-sm text-stone-400">
          {showArchived
            ? t("admin:empty.no_archived")
            : t("admin:empty.no_projects")}
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
          {allProjects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
