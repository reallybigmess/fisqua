/**
 * User Admin — Detail Page
 *
 * This page is the superadmin surface for one user account: email, display name,
 * all five role flags, session state, and the audit log of
 * administrative changes. The edit form is guarded behind
 * `requireSuperAdmin`; the audit panel is read-only.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of the `users` table is
 * filtered by `tenant.id`, including the role-flag update and the
 * email-uniqueness check, so cross-tenant id-guessing 404s and
 * writes cannot reattribute users between tenants.
 *
 * When the request tenant has `crowdsourcingEnabled === false`, the
 * JSX omits the `isCollabAdmin` and `isCataloguer` checkboxes
 * entirely from the role-flag fieldset. The matching
 * `applyUpdateRoles` helper skips writing those two fields under the
 * same condition, so a dormant DB value (set on a user before
 * crowdsourcing was disabled) is left intact rather than silently
 * cleared by an unchecked-as-false read of the form body. The four
 * other role flags (`isAdmin`, `isSuperAdmin`, `isArchiveUser`,
 * `isUserManager`) always render and always update normally.
 *
 * `applyUpdateRoles` is exported so the
 * `tests/admin/users-capability.test.ts` test pool can exercise the
 * dormant-flag-preserved behaviour without paying the cost of the
 * full route-action wiring (the i18n middleware in particular pulls
 * in `~/locales` which the Workers test pool does not alias).
 *
 * @version v0.4.2
 */

import { useState } from "react";
import { Form, Link, useFetcher, redirect } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { formatDate } from "../lib/format";
import type { Route } from "./+types/_auth.admin.users.$id";
import { PROJECT_ROLES, type ProjectRole } from "../lib/validation/enums";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { users, projectMembers, projects } = await import("../db/schema");

  const currentUser = context.get(userContext);
  if (!currentUser.isSuperAdmin && !currentUser.isUserManager) {
    throw new Response("Forbidden", { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const [targetUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenant.id), eq(users.id, params.id)))
    .limit(1)
    .all();

  if (!targetUser) {
    throw new Response("User not found", { status: 404 });
  }

  // Fetch project memberships
  const memberships = await db
    .select({
      id: projectMembers.id,
      projectId: projectMembers.projectId,
      projectName: projects.name,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, params.id))
    .all();

  // Available projects for assignment (tenant-scoped: only the request
  // tenant's projects can be offered for assignment)
  const availableProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.tenantId, tenant.id), isNull(projects.archivedAt)))
    .all();

  // Filter out projects the user is already in
  const memberProjectIds = new Set(memberships.map((m) => m.projectId));
  const assignableProjects = availableProjects.filter(
    (p) => !memberProjectIds.has(p.id)
  );

  return {
    targetUser,
    memberships,
    assignableProjects,
    isSelf: currentUser.id === params.id,
    canEditRoles: currentUser.isSuperAdmin,
    // Surface only the capability flag the JSX gates on. The JSX
    // hides isCollabAdmin and isCataloguer when crowdsourcing is
    // off; the other three capabilities are not consumed here.
    tenant: {
      crowdsourcingEnabled: tenant.crowdsourcingEnabled,
    },
  };
}

// ---------------------------------------------------------------------------
// Role-update helper
// ---------------------------------------------------------------------------

/**
 * Applies the role-flag update for one user. Extracted from `action`
 * so the test pool can exercise the capability-aware skip-write
 * behaviour without paying for the full i18n / Host-header /
 * middleware wiring (the route module imports `~/locales` which is
 * not aliased in `vitest.config.ts`).
 *
 * Behaviour contract:
 *
 *   - The four always-rendered flags (`isAdmin`, `isSuperAdmin`,
 *     `isArchiveUser`, `isUserManager`) are always written from the
 *     form-data; an unchecked checkbox arrives as missing and reads
 *     as `false`, which clears the flag (existing v0.3 semantics).
 *   - When `crowdsourcingEnabled === false`, `isCollabAdmin` and
 *     `isCataloguer` are NOT included in the UPDATE — their DB
 *     values stay intact. This is the "no auto-clear of dormant
 *     flags" rule from CONTEXT.md C-05; it also defends against a
 *     tampered POST body that re-adds a hidden `isCataloguer=on`
 *     field (defence-in-depth — the parent layout's 404 already
 *     makes the persisted flag a no-op, but skipping the write
 *     avoids accidentally toggling state from the admin UI either
 *     way).
 *   - When `crowdsourcingEnabled === true`, both flags are written
 *     from the form-data; an unchecked checkbox clears the flag,
 *     same as the always-rendered four.
 *
 * The UPDATE is scoped to `(tenantId, userId)` so a cross-tenant
 * id-guess on the URL cannot rewrite another tenant's user row.
 */
export async function applyUpdateRoles(args: {
  db: import("drizzle-orm/d1").DrizzleD1Database<any>;
  tenantId: string;
  crowdsourcingEnabled: boolean;
  targetUserId: string;
  formData: FormData;
}): Promise<void> {
  const { eq, and } = await import("drizzle-orm");
  const { users } = await import("../db/schema");

  const isAdmin = args.formData.get("isAdmin") === "on";
  const isSuperAdmin = args.formData.get("isSuperAdmin") === "on";
  const isArchiveUser = args.formData.get("isArchiveUser") === "on";
  const isUserManager = args.formData.get("isUserManager") === "on";

  // Build the update set. Only include the two capability-dependent
  // fields when the tenant has crowdsourcing on.
  const updateSet: Record<string, unknown> = {
    isAdmin,
    isSuperAdmin,
    isArchiveUser,
    isUserManager,
  };
  if (args.crowdsourcingEnabled) {
    updateSet.isCollabAdmin = args.formData.get("isCollabAdmin") === "on";
    updateSet.isCataloguer = args.formData.get("isCataloguer") === "on";
  }

  await args.db
    .update(users)
    .set(updateSet)
    .where(and(eq(users.tenantId, args.tenantId), eq(users.id, args.targetUserId)));
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { users, projectMembers } = await import("../db/schema");

  const { getInstance } = await import("~/middleware/i18next");
  const currentUser = context.get(userContext);
  const i18n = getInstance(context);
  if (!currentUser.isSuperAdmin && !currentUser.isUserManager) {
    throw new Response(i18n.t("user_admin:error_forbidden"), { status: 403 });
  }
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "updateProfile") {
    const name = (formData.get("name") as string)?.trim() || null;
    const email = (formData.get("email") as string)?.trim();

    if (!email) {
      return { ok: false, error: i18n.t("user_admin:error_email_required") };
    }

    // Check for duplicate email (excluding this user). Email is globally
    // unique on `users` (schema-level), so the duplicate check is across
    // tenants; the UPDATE is scoped to the calling tenant so a cross-tenant
    // id-guess cannot rename another tenant's user.
    const { ne } = await import("drizzle-orm");
    const [duplicate] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, params.id)))
      .limit(1)
      .all();
    if (duplicate) {
      return { ok: false, error: i18n.t("user_admin:error_email_duplicate") };
    }

    await db
      .update(users)
      .set({ name, email })
      .where(and(eq(users.tenantId, tenant.id), eq(users.id, params.id)));

    return { ok: true, message: i18n.t("user_admin:success_profile_updated") };
  }

  if (intent === "updateRoles") {
    if (!currentUser.isSuperAdmin) {
      return { ok: false, error: i18n.t("user_admin:error_only_superadmin_roles") };
    }
    if (currentUser.id === params.id) {
      return { ok: false, error: i18n.t("user_admin:error_cannot_change_own_roles") };
    }

    await applyUpdateRoles({
      db,
      tenantId: tenant.id,
      crowdsourcingEnabled: tenant.crowdsourcingEnabled,
      targetUserId: params.id,
      formData,
    });

    return { ok: true, message: i18n.t("user_admin:success_roles_updated") };
  }

  if (intent === "assignToProject") {
    const projectId = formData.get("projectId") as string;
    const role = formData.get("role") as ProjectRole;

    if (!projectId || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }

    const existing = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, params.id)
        )
      )
      .limit(1)
      .all();
    if (existing.length > 0) {
      return { ok: false, error: i18n.t("user_admin:error_already_member") };
    }

    await db.insert(projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: params.id,
      role,
      createdAt: Math.floor(Date.now() / 1000),
    });

    return { ok: true, message: i18n.t("user_admin:success_assigned") };
  }

  if (intent === "changeRole") {
    const membershipId = formData.get("membershipId") as string;
    const role = formData.get("role") as ProjectRole;

    if (!membershipId || !(PROJECT_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
    }

    await db
      .update(projectMembers)
      .set({ role })
      .where(eq(projectMembers.id, membershipId));

    return { ok: true, message: i18n.t("user_admin:success_role_updated") };
  }

  if (intent === "removeFromProject") {
    const membershipId = formData.get("membershipId") as string;
    if (!membershipId) return { ok: false, error: i18n.t("user_admin:error_invalid_request") };

    await db
      .delete(projectMembers)
      .where(eq(projectMembers.id, membershipId));

    return { ok: true, message: i18n.t("user_admin:success_removed") };
  }

  return { ok: false, error: i18n.t("user_admin:error_invalid_request") };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

// Project-role chips follow the design system colour map: lead and cataloguer
// share verdigris (brand / approved / lead); reviewer is madder (the only
// system colour reserved for review and send-back actions). The previous
// assignment had lead, cataloguer, and reviewer scrambled across saffron,
// indigo, and verdigris and read inconsistently against the boundary markers
// in the IIIF viewer, where cataloguer = verdigris and reviewer = madder.
const ROLE_BADGE_COLORS: Record<string, string> = {
  lead: "bg-verdigris-tint text-verdigris-deep",
  cataloguer: "bg-verdigris-tint text-verdigris-deep",
  reviewer: "bg-madder-tint text-madder-deep",
};

function RoleCheckbox({
  label,
  description,
  name,
  checked,
  disabled,
}: {
  label: string;
  description: string;
  name: string;
  checked: boolean;
  disabled?: boolean;
}) {
  return (
    <label
      className={`font-medium flex items-start gap-3 rounded-lg border border-stone-200 px-4 py-3 ${ disabled ? "opacity-60" : "hover:bg-stone-50 cursor-pointer" }`}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
      />
      <div>
        <div className="font-sans text-sm font-semibold text-stone-700">
          {label}
        </div>
        <div className="font-sans text-xs text-stone-500">{description}</div>
      </div>
    </label>
  );
}

export default function UserDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    targetUser: u,
    memberships,
    assignableProjects,
    isSelf,
    canEditRoles,
    tenant,
  } = loaderData;
  const { t } = useTranslation("user_admin");
  const fetcher = useFetcher();
  const [showAssignForm, setShowAssignForm] = useState(false);

  const result = fetcher.data as
    | { ok: boolean; message?: string; error?: string }
    | undefined;

  return (
    <div className="mx-auto max-w-3xl px-8 py-8 space-y-8">
      {/* Breadcrumb */}
      <nav className="font-sans text-sm text-stone-500">
        <Link to="/admin/users" className="hover:text-stone-700">
          {t("breadcrumb_system_users")}
        </Link>
        <span className="mx-2">&rsaquo;</span>
        <span className="text-stone-700">{u.name || u.email}</span>
      </nav>

      {/* Profile */}
      <fetcher.Form method="post" className="space-y-4">
        <input type="hidden" name="_action" value="updateProfile" />
        <div className="flex gap-4">
          <div className="flex-1">
            <label
              htmlFor="user-name"
              className="mb-1 block font-sans text-xs font-medium text-indigo"
            >
              {t("name_label")}
            </label>
            <input
              id="user-name"
              type="text"
              name="name"
              defaultValue={u.name || ""}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
          <div className="flex-1">
            <label
              htmlFor="user-email"
              className="mb-1 block font-sans text-xs font-medium text-indigo"
            >
              {t("email_label")}
            </label>
            <input
              id="user-email"
              type="email"
              name="email"
              required
              defaultValue={u.email}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="font-sans text-xs text-stone-400">
            {t("last_login_label")}: {u.lastActiveAt ? formatDate(u.lastActiveAt) : t("never")}
            {" · "}
            {t("created_label")}: {formatDate(u.createdAt)}
          </p>
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("save_profile")}
          </button>
        </div>
      </fetcher.Form>

      {/* Feedback */}
      {result?.ok && result.message && (
        <div className="rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 font-sans text-sm text-stone-700">
          {result.message}
        </div>
      )}
      {result && !result.ok && result.error && (
        <div className="rounded-md border border-indigo bg-indigo-tint px-4 py-3 font-sans text-sm text-stone-700">
          {result.error}
        </div>
      )}

      {/* Role edit warnings */}
      {isSelf && (
        <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3 font-sans text-sm text-stone-700">
          {t("self_warning")}
        </div>
      )}
      {!canEditRoles && !isSelf && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-500">
          {t("non_superadmin_notice")}
        </div>
      )}

      {/* Roles */}
      <fetcher.Form method="post">
        <input type="hidden" name="_action" value="updateRoles" />

        <div className="space-y-6">
          {/* System */}
          <div>
            <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
              {t("section_system")}
            </h2>
            <div className="space-y-2">
              <RoleCheckbox
                label={t("role_super_admin")}
                description={t("super_admin_description")}
                name="isSuperAdmin"
                checked={!!u.isSuperAdmin}
                disabled={isSelf || !canEditRoles}
              />
              <RoleCheckbox
                label={t("role_user_manager")}
                description={t("user_manager_description")}
                name="isUserManager"
                checked={!!u.isUserManager}
                disabled={isSelf || !canEditRoles}
              />
            </div>
          </div>

          {/* Cataloguing — hidden entirely when crowdsourcing
              capability is off. Dormant DB values for
              `isCollabAdmin` / `isCataloguer` are not auto-cleared
              and the matching action helper skips writing them; the
              surface they gate (cataloguing routes) 404s at the
              parent layout's capability check. */}
          {tenant.crowdsourcingEnabled && (
            <div>
              <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
                {t("section_cataloguing")}
              </h2>
              <div className="space-y-2">
                <RoleCheckbox
                  label={t("role_cataloguing_admin")}
                  description={t("cataloguing_admin_description")}
                  name="isCollabAdmin"
                  checked={!!u.isCollabAdmin}
                  disabled={isSelf || !canEditRoles}
                />
                <RoleCheckbox
                  label={t("role_cataloguer")}
                  description={t("cataloguer_description")}
                  name="isCataloguer"
                  checked={!!u.isCataloguer}
                  disabled={isSelf || !canEditRoles}
                />
              </div>
            </div>
          )}

          {/* Records management */}
          <div>
            <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
              {t("section_records_management")}
            </h2>
            <div className="space-y-2">
              <RoleCheckbox
                label={t("role_records_admin")}
                description={t("records_admin_description")}
                name="isAdmin"
                checked={!!u.isAdmin}
                disabled={isSelf || !canEditRoles}
              />
              <RoleCheckbox
                label={t("role_archive_user")}
                description={t("archive_user_description")}
                name="isArchiveUser"
                checked={!!u.isArchiveUser}
                disabled={isSelf || !canEditRoles}
              />
            </div>
          </div>

          {canEditRoles && !isSelf && (
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("save_roles")}
            </button>
          )}
        </div>
      </fetcher.Form>

      {/* Project memberships */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
            {t("section_project_memberships")}
          </h2>
          {assignableProjects.length > 0 && (
            <button
              type="button"
              onClick={() => setShowAssignForm(!showAssignForm)}
              className="font-sans text-xs font-semibold text-indigo hover:text-indigo-deep"
            >
              {showAssignForm ? t("cancel") : t("assign_to_project")}
            </button>
          )}
        </div>

        {showAssignForm && (
          <fetcher.Form
            method="post"
            className="mb-4 flex items-end gap-2 rounded-lg border border-stone-200 bg-stone-50 p-3"
            onSubmit={() => setTimeout(() => setShowAssignForm(false), 100)}
          >
            <input type="hidden" name="_action" value="assignToProject" />
            <div className="flex-1">
              <label className="mb-1 block font-sans text-xs font-medium text-indigo">
                {t("project_label")}
              </label>
              <select
                name="projectId"
                required
                className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              >
                <option value="">{t("select_project")}</option>
                {assignableProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block font-sans text-xs font-medium text-indigo">
                {t("role_label")}
              </label>
              <select
                name="role"
                required
                className="rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              >
                <option value="">{t("select_role")}</option>
                <option value="lead">{t("role_lead")}</option>
                <option value="cataloguer">{t("role_cataloguer")}</option>
                <option value="reviewer">{t("role_reviewer")}</option>
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("assign")}
            </button>
          </fetcher.Form>
        )}

        {memberships.length === 0 ? (
          <p className="rounded-lg border border-stone-200 px-4 py-6 text-center font-sans text-sm text-stone-400">
            {t("no_memberships")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("project_label")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("role_label")}
                  </th>
                  <th className="px-4 py-2.5 text-right font-sans text-xs font-medium uppercase text-stone-500">
                    &nbsp;
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {memberships.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3 font-sans text-sm font-semibold text-stone-700">
                      {m.projectName}
                    </td>
                    <td className="px-4 py-3">
                      <fetcher.Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="_action"
                          value="changeRole"
                        />
                        <input
                          type="hidden"
                          name="membershipId"
                          value={m.id}
                        />
                        <select
                          name="role"
                          defaultValue={m.role}
                          onChange={(e) => e.target.form?.requestSubmit()}
                          className="rounded-lg border border-stone-200 px-2 py-1 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
                        >
                          <option value="lead">{t("role_lead")}</option>
                          <option value="cataloguer">{t("role_cataloguer")}</option>
                          <option value="reviewer">{t("role_reviewer")}</option>
                        </select>
                      </fetcher.Form>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <fetcher.Form method="post" className="inline">
                        <input
                          type="hidden"
                          name="_action"
                          value="removeFromProject"
                        />
                        <input
                          type="hidden"
                          name="membershipId"
                          value={m.id}
                        />
                        <button
                          type="submit"
                          className="font-sans text-xs text-stone-400 hover:text-indigo"
                          onClick={(e) => {
                            if (
                              !confirm(
                                t("remove_confirm", { project: m.projectName })
                              )
                            ) {
                              e.preventDefault();
                            }
                          }}
                        >
                          {t("remove")}
                        </button>
                      </fetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
