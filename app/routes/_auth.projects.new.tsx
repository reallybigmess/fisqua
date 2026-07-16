/**
 * Project Create Form
 *
 * This page is the admin-only create-project surface reached from the
 * sidebar's "New project" link in the cataloguing admin subsection.
 * The loader is a thin admin guard — `requireAdmin(user)` — and the
 * action validates the submitted form through `validateProjectForm`
 * before delegating to `createProject` in `projects.server`, which
 * inserts the row and seeds the project-membership table with the
 * caller as the initial lead. On success the action throws a redirect
 * to the new project's overview; on validation failure it returns
 * `{errors, values}` so the form re-renders with field-level errors
 * and the user's input preserved.
 *
 * The form is deliberately minimal — name and description only — so
 * an admin can start a project in seconds; richer settings (document
 * subtypes, conventions, JSON settings blob) live on the per-project
 * settings page once the row exists.
 *
 * @version v0.4.2
 */

import { Form, redirect, useActionData, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import type { Route } from "./+types/_auth.projects.new";

export function meta() {
  return [{ title: "Nuevo proyecto" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("../lib/permissions.server");
  const user = context.get(userContext);
  requireAdmin(user);
  return {};
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireAdmin } = await import("../lib/permissions.server");
  const {
    validateProjectForm,
    createProject,
  } = await import("../lib/projects.server");

  const user = context.get(userContext);
  requireAdmin(user);

  const formData = await request.formData();
  const raw = {
    name: formData.get("name") as string || "",
    description: formData.get("description") as string || "",
  };

  const result = validateProjectForm(raw);
  if (!result.success) {
    return { errors: result.errors, values: raw };
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const tenant = context.get(tenantContext);

  const project = await createProject(
    db,
    tenant.id,
    {
      name: result.data.name,
      description: result.data.description || null,
    },
    user.id
  );

  throw redirect(`/projects/${project.id}`);
}

export default function NewProject() {
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation(["project", "common"]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <Link
          to="/dashboard"
          className="text-sm text-stone-500 hover:text-stone-700"
        >
          &larr; {t("project:heading.back_to_dashboard")}
        </Link>
      </div>

      <h1 className="text-xl font-semibold text-stone-900">
        {t("project:heading.create_project")}
      </h1>

      <Form method="post" className="mt-6 space-y-6">
        {/* Project name */}
        <div>
          <label
            htmlFor="name"
            className="block text-sm font-medium text-indigo"
          >
            {t("project:settings.project_name")}
          </label>
          <input
            type="text"
            id="name"
            name="name"
            required
            maxLength={200}
            defaultValue={actionData?.values?.name}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-soft focus:ring-1 focus:ring-indigo-soft focus:outline-none"
          />
          {actionData?.errors?.name && (
            <p className="mt-1 text-sm text-madder-deep">
              {actionData.errors.name}
            </p>
          )}
        </div>

        {/* Description */}
        <div>
          <label
            htmlFor="description"
            className="block text-sm font-medium text-indigo"
          >
            {t("project:settings.description")}{" "}
            <span className="text-stone-400">{t("project:settings.description_optional")}</span>
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={actionData?.values?.description}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-soft focus:ring-1 focus:ring-indigo-soft focus:outline-none"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep"
          >
            {t("project:new.create")}
          </button>
        </div>
      </Form>
    </div>
  );
}
