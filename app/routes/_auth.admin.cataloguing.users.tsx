/**
 * Cataloguing Admin — Users
 *
 * This page is the cataloguing-side user directory: it shows every account that holds
 * at least one cataloguing role and lets a cataloguing admin edit
 * per-row role flags. Sensitive toggles — superadmin, collab admin —
 * remain superadmin-only in the UI, even though the route lives in
 * the cataloguing admin subsection.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`; the loader filters `users` by `tenant.id` and
 * the action plumbs `tenant.id` into `handleUsersAction` so user
 * mutations attribute to the calling tenant.
 *
 * The invite-form `isCollabAdmin` checkbox and the per-row
 * `toggleCollabAdmin` button are hidden entirely when
 * `tenant.crowdsourcingEnabled === false`. The route itself 404s on
 * a crowdsourcing-off tenant via the parent layout's capability
 * gate; the JSX gate here is belt-and-braces. Dormant flag values
 * stay in the DB (no auto-clear).
 *
 * @version v0.4.2
 */

import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { formatDate } from "../lib/format";
import type { Route } from "./+types/_auth.admin.cataloguing.users";

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { desc, eq, or, inArray, sql } = await import("drizzle-orm");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { users, projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  requireCollabAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Collab-side users only. Include users who either have
  // isCollabAdmin=true or have at least one projectMembers row. Archive-only
  // admins (isAdmin=true, isCollabAdmin=false, no memberships) are excluded.
  const memberUserIds = await db
    .selectDistinct({ userId: projectMembers.userId })
    .from(projectMembers)
    .all();
  const memberIdSet = memberUserIds.map((m) => m.userId);

  const allUsersRaw = await db
    .select()
    .from(users)
    .where(eq(users.tenantId, tenant.id))
    .orderBy(desc(users.createdAt))
    .all();

  const allUsers = allUsersRaw.filter(
    (u) => u.isCollabAdmin || u.isSuperAdmin || memberIdSet.includes(u.id)
  );

  return {
    users: allUsers,
    currentUser: {
      id: user.id,
      isSuperAdmin: user.isSuperAdmin,
      isCollabAdmin: user.isCollabAdmin,
    },
    // Surface only the capability flag the JSX gates on.
    tenant: {
      crowdsourcingEnabled: tenant.crowdsourcingEnabled,
    },
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireCollabAdmin } = await import("../lib/permissions.server");
  const { getInstance } = await import("~/middleware/i18next");
  const { handleUsersAction } = await import(
    "./_auth.admin.cataloguing.users.action.server"
  );

  const user = context.get(userContext);
  requireCollabAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  const formData = await request.formData();
  const origin = new URL(request.url).origin;

  return handleUsersAction(user, tenant.id, db, formData, env, i18n, origin);
}

export default function AdminCataloguingUsers({
  loaderData,
}: Route.ComponentProps) {
  const { users: allUsers, currentUser, tenant } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("admin");

  return (
    <div className="space-y-8">
      <h1 className="font-display text-4xl font-semibold text-stone-700">
        {t("cataloguing_users.title")}
      </h1>

      {/* Invite user form */}
      <section>
        <h2 className="font-sans text-lg font-semibold text-stone-700">
          {t("heading.create_user")}
        </h2>

        {actionData?.ok && actionData?.message && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 font-sans text-sm text-stone-700">
            {actionData.message}
          </div>
        )}
        {actionData && !actionData.ok && actionData?.error && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-indigo bg-indigo-tint px-4 py-3 font-sans text-sm text-stone-700">
            {actionData.error}
          </div>
        )}

        <Form method="post" className="mt-4 flex items-end gap-3">
          <input type="hidden" name="_action" value="inviteUser" />
          <div>
            <label
              htmlFor="email"
              className="block font-sans text-sm font-medium text-indigo"
            >
              {t("table.email")}
            </label>
            <input
              type="email"
              id="email"
              name="email"
              required
              placeholder={t("placeholder.email")}
              className="mt-1 block w-64 rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="name"
              className="block font-sans text-sm font-medium text-indigo"
            >
              {t("table.name")}
            </label>
            <input
              type="text"
              id="name"
              name="name"
              className="mt-1 block w-48 rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>
          {/* isCollabAdmin checkbox is hidden unless current user is
              superadmin AND the tenant has crowdsourcing enabled.
              On a crowdsourcing-off tenant the flag becomes a no-op
              (the parent layout 404s the cataloguing routes), so
              surfacing it would be misleading. */}
          {currentUser.isSuperAdmin && tenant.crowdsourcingEnabled && (
            <label className="flex items-center gap-2 font-sans text-sm font-medium text-indigo">
              <input type="checkbox" name="isCollabAdmin" />
              Collab admin
            </label>
          )}
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("action.create_user")}
          </button>
        </Form>
      </section>

      {/* Users table */}
      <section>
        <h2 className="font-sans text-lg font-semibold text-stone-700">
          {t("heading.all_users")}
        </h2>

        {allUsers.length === 0 ? (
          <p className="mt-2 font-sans text-sm text-stone-400">
            {t("empty.no_users")}
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("table.email")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("table.name")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("table.role")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("table.created")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {allUsers.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-sans text-sm text-stone-700">
                      {u.email}
                    </td>
                    <td className="px-4 py-3 font-sans text-sm text-stone-500">
                      {u.name || "\u2014"}
                    </td>
                    <td className="px-4 py-3">
                      {/* per-row toggles are superadmin-only in the UI. */}
                      {currentUser.isSuperAdmin ? (
                        <div className="flex gap-2">
                          <Form method="post" className="inline">
                            <input
                              type="hidden"
                              name="_action"
                              value="toggleAdmin"
                            />
                            <input type="hidden" name="userId" value={u.id} />
                            <button
                              type="submit"
                              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${
                                u.isAdmin
                                  ? "bg-saffron-tint text-saffron-deep hover:bg-saffron/20"
                                  : "bg-stone-200 text-stone-500 hover:bg-stone-200"
                              }`}
                            >
                              {u.isAdmin ? t("table.admin") : t("table.user")}
                            </button>
                          </Form>
                          {/* Toggle for the capability-dependent flag is
                              hidden when crowdsourcing is off — the
                              flag becomes a dormant no-op and the
                              surface it gates 404s at the parent
                              layout's capability check. */}
                          {tenant.crowdsourcingEnabled && (
                            <Form method="post" className="inline">
                              <input
                                type="hidden"
                                name="_action"
                                value="toggleCollabAdmin"
                              />
                              <input type="hidden" name="userId" value={u.id} />
                              <button
                                type="submit"
                                className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${
                                  u.isCollabAdmin
                                    ? "bg-verdigris-tint text-verdigris hover:bg-verdigris/20"
                                    : "bg-stone-200 text-stone-500 hover:bg-stone-200"
                                }`}
                              >
                                Collab
                              </button>
                            </Form>
                          )}
                        </div>
                      ) : (
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-semibold ${
                            u.isCollabAdmin || u.isAdmin
                              ? "bg-saffron-tint text-saffron-deep"
                              : "bg-stone-200 text-stone-500"
                          }`}
                        >
                          {u.isCollabAdmin
                            ? "Collab admin"
                            : u.isAdmin
                              ? t("table.admin")
                              : t("table.user")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-sans text-xs text-stone-400">
                      {formatDate(u.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
