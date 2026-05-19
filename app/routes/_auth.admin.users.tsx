/**
 * User Admin — List
 *
 * This page is the superadmin-only directory of every user in the
 * system, with filter chips for role flags and a search box for name
 * or email. Each row
 * deep-links to the user detail page for edits.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Loader filters `users` by `tenant.id`; the
 * action plumbs `tenant.id` into `handleUsersAction` so the invite
 * path attributes the new user row to the calling tenant.
 *
 * @version v0.4.0
 */

import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { formatDate } from "../lib/format";
import type { Route } from "./+types/_auth.admin.users";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { asc, eq } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");

  const user = context.get(userContext);
  if (!user.isSuperAdmin && !user.isUserManager) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const allUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
      isSuperAdmin: users.isSuperAdmin,
      isCollabAdmin: users.isCollabAdmin,
      isArchiveUser: users.isArchiveUser,
      isUserManager: users.isUserManager,
      isCataloguer: users.isCataloguer,
      lastActiveAt: users.lastActiveAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .orderBy(asc(users.name))
    .all();

  // Count project memberships per user
  const allMemberships = await db
    .select({
      userId: projectMembers.userId,
      projectName: projects.name,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .all();

  const membershipsByUser = new Map<string, { projectName: string; role: string }[]>();
  for (const m of allMemberships) {
    const list = membershipsByUser.get(m.userId) || [];
    list.push({ projectName: m.projectName, role: m.role });
    membershipsByUser.set(m.userId, list);
  }

  const usersWithProjects = allUsers.map((u) => ({
    ...u,
    projects: membershipsByUser.get(u.id) || [],
  }));

  return { users: usersWithProjects };
}

// ---------------------------------------------------------------------------
// Action — invite user only (role management moved to detail page)
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");

  const user = context.get(userContext);
  if (!user.isSuperAdmin && !user.isUserManager) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "inviteUser") {
    const { handleUsersAction } = await import(
      "./_auth.admin.cataloguing.users.action.server"
    );
    const i18n = await import("i18next");
    const origin = new URL(request.url).origin;
    return handleUsersAction(user, tenant.id, db, formData, env, i18n, origin);
  }

  return { ok: false, error: "Unknown action" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RoleKey =
  | "super_admin"
  | "user_manager"
  | "cataloguing_admin"
  | "cataloguer"
  | "records_admin"
  | "archive_user";

function roleSummary(u: {
  isAdmin: number | boolean;
  isSuperAdmin: number | boolean;
  isCollabAdmin: number | boolean;
  isArchiveUser: number | boolean;
  isUserManager: number | boolean;
  isCataloguer: number | boolean;
}): RoleKey[] {
  const roles: RoleKey[] = [];
  if (u.isSuperAdmin) roles.push("super_admin");
  if (u.isUserManager) roles.push("user_manager");
  if (u.isCollabAdmin) roles.push("cataloguing_admin");
  if (u.isCataloguer) roles.push("cataloguer");
  if (u.isAdmin) roles.push("records_admin");
  if (u.isArchiveUser) roles.push("archive_user");
  return roles;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ROLE_PILL_COLORS: Record<RoleKey, string> = {
  super_admin: "bg-indigo text-parchment",
  user_manager: "bg-saffron-tint text-saffron-deep",
  cataloguing_admin: "bg-indigo-tint text-indigo",
  cataloguer: "bg-verdigris-tint text-verdigris",
  records_admin: "bg-sage-tint text-sage-deep",
  archive_user: "bg-verdigris-tint text-verdigris",
};

export default function SystemUsersPage({
  loaderData,
}: Route.ComponentProps) {
  const { users: allUsers } = loaderData;
  const { t } = useTranslation(["user_admin", "sidebar", "admin"]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const inviteFetcher = useFetcher();

  const inviteResult = inviteFetcher.data as
    | { ok: boolean; message?: string; error?: string }
    | undefined;
  const inviteSuccess = inviteResult?.ok === true;

  return (
    <div className="mx-auto max-w-7xl px-8 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold text-stone-700">
          {t("sidebar:system_users")}
        </h1>
        <button
          type="button"
          onClick={() => setShowInviteModal(true)}
          className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          {t("sidebar:invite_user")}
        </button>
      </div>

      {inviteSuccess && inviteResult?.message && (
        <div className="rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 font-sans text-sm text-stone-700">
          {inviteResult.message}
        </div>
      )}

      {inviteResult && !inviteResult.ok && inviteResult.error && (
        <div className="rounded-md border border-indigo bg-indigo-tint px-4 py-3 font-sans text-sm text-stone-700">
          {inviteResult.error}
        </div>
      )}

      {showInviteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowInviteModal(false)}
        >
          <div
            role="dialog"
            aria-labelledby="invite-modal-title"
            className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="invite-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("sidebar:invite_user")}
            </h2>
            <p className="mt-1 font-sans text-sm text-stone-500">
              {t("sidebar:invite_description")}
            </p>
            <inviteFetcher.Form
              method="post"
              className="mt-4 space-y-4"
              onSubmit={() => setShowInviteModal(false)}
            >
              <input type="hidden" name="_action" value="inviteUser" />
              <div>
                <label
                  htmlFor="invite-name"
                  className="mb-1 block font-sans text-xs font-medium text-indigo"
                >
                  {t("sidebar:col_name")}
                </label>
                <input
                  id="invite-name"
                  type="text"
                  name="name"
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div>
                <label
                  htmlFor="invite-email"
                  className="mb-1 block font-sans text-xs font-medium text-indigo"
                >
                  {t("sidebar:col_email")} <span className="text-madder">*</span>
                </label>
                <input
                  id="invite-email"
                  type="email"
                  name="email"
                  required
                  placeholder={t("admin:placeholder.email")}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                />
              </div>
              <div className="flex justify-end gap-3 border-t border-stone-200 pt-4">
                <button
                  type="button"
                  onClick={() => setShowInviteModal(false)}
                  className="rounded-md border border-stone-200 px-4 py-2 font-sans text-sm font-semibold text-stone-700 hover:bg-stone-50"
                >
                  {t("admin:action.cancel")}
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
                >
                  {t("sidebar:send_invite")}
                </button>
              </div>
            </inviteFetcher.Form>
          </div>
        </div>
      )}

      {allUsers.length === 0 ? (
        <p className="font-sans text-sm text-stone-400">{t("sidebar:no_users")}</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200">
          <table className="min-w-full divide-y divide-stone-200">
            <thead className="bg-stone-50">
              <tr>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_name")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_email")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_roles")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("user_admin:col_projects")}
                </th>
                <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                  {t("sidebar:col_last_login")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {allUsers.map((u) => {
                const roles = roleSummary(u);
                return (
                  <tr key={u.id} className="hover:bg-stone-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/users/${u.id}`}
                        className="font-sans text-sm font-semibold text-stone-700 hover:text-indigo"
                      >
                        {u.name || u.email.split("@")[0]}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-sans text-sm text-stone-500">
                      {u.email}
                    </td>
                    <td className="px-4 py-3">
                      {roles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {roles.map((r) => (
                            <span
                              key={r}
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${ROLE_PILL_COLORS[r] || "bg-stone-200 text-stone-500"}`}
                            >
                              {t(`user_admin:role_${r}`)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-xs text-stone-400">
                          {t("user_admin:no_roles")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.projects.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {u.projects.map((p, i) => (
                            <span
                              key={i}
                              className="font-sans text-xs text-stone-700"
                            >
                              {p.projectName}
                              <span className="ml-0.5 text-stone-400">
                                ({p.role})
                              </span>
                              {i < u.projects.length - 1 && ", "}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="font-sans text-xs text-stone-400">
                          &mdash;
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-sans text-xs text-stone-400">
                      {u.lastActiveAt ? formatDate(u.lastActiveAt) : t("never")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
