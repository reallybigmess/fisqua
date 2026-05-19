/**
 * Project Settings Page
 *
 * This page is the lead-only general settings surface for one
 * project, enforced in both loader and action through
 * `requireProjectRole`. It hosts three groups
 * of controls: the project name / description / conventions / settings
 * JSON form, the Colombian Spanish document subtype list editor, and
 * the danger-zone archive and delete actions.
 *
 * The settings JSON blob is split into typed helpers in
 * `app/lib/project-settings.ts`; this page still exposes a raw JSON
 * textarea for any future per-project flags not yet modelled at the
 * type level, while `documentSubtypes` owns its own dedicated form
 * and action handler.
 *
 * @version v0.3.0
 */
import { useState } from "react";
import { Form, useActionData, useNavigate, useNavigation } from "react-router";
import { useTranslation } from "react-i18next";
import { Loader2, GripVertical, Plus, X } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.projects.$id.settings";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProject } = await import("../lib/projects.server");
  const { getDocumentSubtypes } = await import("../lib/project-settings");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const project = await getProject(db, params.id);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const documentSubtypes = getDocumentSubtypes(project.settings);

  return { project, isSuperAdmin: user.isSuperAdmin, documentSubtypes };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { requireSuperAdmin } = await import("../lib/superadmin.server");
  const { getInstance } = await import("~/middleware/i18next");
  const {
    projects,
    projectMembers,
    projectInvites,
    volumes,
    volumePages,
    entries,
    activityLog,
  } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "updateSettings") {
    const name = ((formData.get("name") as string) || "").trim();
    const description = ((formData.get("description") as string) || "").trim();
    const conventions = ((formData.get("conventions") as string) || "").trim();
    const settings = ((formData.get("settings") as string) || "").trim();

    const errors: Record<string, string> = {};

    if (!name || name.length === 0) {
      errors.name = i18n.t("project:error.name_required");
    } else if (name.length > 200) {
      errors.name = i18n.t("project:error.name_too_long");
    }

    if (settings) {
      try {
        JSON.parse(settings);
      } catch {
        errors.settings = i18n.t("project:error.invalid_json");
      }
    }

    if (Object.keys(errors).length > 0) {
      return { ok: false, errors, _action: "updateSettings" };
    }

    await db
      .update(projects)
      .set({
        name,
        description: description || null,
        conventions: conventions || null,
        settings: settings || null,
        updatedAt: Date.now(),
      })
      .where(eq(projects.id, params.id));

    return { ok: true, message: i18n.t("project:settings.saved"), _action: "updateSettings" };
  }

  if (intent === "updateDocumentSubtypes") {
    // Lead-only editor for the project's Colombian Spanish document
    // subtype list. Accepts a newline-separated textarea payload so the
    // server does not depend on any specific client-side control
    // (drag-reorder, chip list, etc.). Reordering is expressed by
    // rewriting the list wholesale.
    const { setDocumentSubtypes } = await import("../lib/project-settings");
    const raw = ((formData.get("documentSubtypes") as string) || "").trim();
    const subtypes = raw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Re-read the project so we only update the `settings` column and
    // leave name / description / conventions untouched.
    const row = await db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, params.id))
      .get();

    const nextSettings = setDocumentSubtypes(row?.settings ?? null, subtypes);

    await db
      .update(projects)
      .set({ settings: nextSettings, updatedAt: Date.now() })
      .where(eq(projects.id, params.id));

    return {
      ok: true,
      message: i18n.t("project:settings.subtypes_saved"),
      _action: "updateDocumentSubtypes",
    };
  }

  if (intent === "archiveProject") {
    await db
      .update(projects)
      .set({ archivedAt: Date.now() })
      .where(eq(projects.id, params.id));

    const { redirect } = await import("react-router");
    return redirect("/admin/cataloguing/projects");
  }

  if (intent === "restoreProject") {
    await db
      .update(projects)
      .set({ archivedAt: null })
      .where(eq(projects.id, params.id));

    return { ok: true, message: i18n.t("project:settings.restored"), _action: "restoreProject" };
  }

  if (intent === "deleteProject") {
    requireSuperAdmin(user);

    const projectVolumes = await db
      .select({ id: volumes.id })
      .from(volumes)
      .where(eq(volumes.projectId, params.id))
      .all();
    const volumeIds = projectVolumes.map((v) => v.id);

    for (const volId of volumeIds) {
      await db.delete(entries).where(eq(entries.volumeId, volId));
      await db.delete(volumePages).where(eq(volumePages.volumeId, volId));
    }

    await db.delete(volumes).where(eq(volumes.projectId, params.id));
    await db.delete(activityLog).where(eq(activityLog.projectId, params.id));
    await db.delete(projectInvites).where(eq(projectInvites.projectId, params.id));
    await db.delete(projectMembers).where(eq(projectMembers.projectId, params.id));
    await db.delete(projects).where(eq(projects.id, params.id));

    const { redirect } = await import("react-router");
    return redirect("/admin/cataloguing/projects");
  }

  return { ok: false, error: "Unknown action" };
}

export default function ProjectSettings({ loaderData }: Route.ComponentProps) {
  const { project, isSuperAdmin, documentSubtypes } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { t } = useTranslation(["project", "common"]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  // Local draft of the document-subtype list. Seeded from the loader;
  // reset to the server value whenever the lead saves or cancels. The
  // form submits a newline-joined serialisation so the server handler
  // stays framework-free.
  const [subtypeDraft, setSubtypeDraft] =
    useState<string[]>(documentSubtypes);
  const [newSubtype, setNewSubtype] = useState("");
  const isArchived = !!project.archivedAt;
  const isSaving =
    navigation.state === "submitting" &&
    navigation.formData?.get("_action") === "updateSettings";
  const isSavingSubtypes =
    navigation.state === "submitting" &&
    navigation.formData?.get("_action") === "updateDocumentSubtypes";

  function addSubtype() {
    const clean = newSubtype.trim();
    if (clean.length === 0) return;
    if (subtypeDraft.includes(clean)) {
      setNewSubtype("");
      return;
    }
    setSubtypeDraft([...subtypeDraft, clean]);
    setNewSubtype("");
  }

  function removeSubtype(index: number) {
    setSubtypeDraft(subtypeDraft.filter((_, i) => i !== index));
  }

  function moveSubtype(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= subtypeDraft.length) return;
    const next = [...subtypeDraft];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setSubtypeDraft(next);
  }

  function resetSubtypes() {
    setSubtypeDraft(documentSubtypes);
    setNewSubtype("");
  }

  return (
    <div className="space-y-10">
      {/* Settings form */}
      <section>
        <h2 className="font-sans text-[1.5rem] font-semibold text-stone-700">
          {t("project:settings.heading")}
        </h2>

        {actionData?.ok && actionData?.message && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
            <svg className="h-5 w-5 shrink-0 text-verdigris" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
            {actionData.message}
          </div>
        )}

        <Form method="post" className="mt-6 max-w-xl space-y-5">
          <input type="hidden" name="_action" value="updateSettings" />
          <div>
            <label
              htmlFor="name"
              className="block font-sans text-[0.875rem] font-medium text-indigo"
            >
              {t("project:settings.project_name")}
            </label>
            <input
              type="text"
              id="name"
              name="name"
              required
              maxLength={200}
              defaultValue={project.name}
              className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-serif text-[1rem] text-stone-700 shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
            {actionData?.errors?.name && (
              <p className="mt-1 text-sm text-madder-deep">
                {actionData.errors.name}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="description"
              className="block font-sans text-[0.875rem] font-medium text-indigo"
            >
              {t("project:settings.description")}
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={project.description || ""}
              className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="conventions"
              className="block font-sans text-[0.875rem] font-medium text-indigo"
            >
              {t("project:settings.conventions")}
            </label>
            <p className="font-sans text-xs text-stone-400">
              {t("project:settings.conventions_help")}
            </p>
            <textarea
              id="conventions"
              name="conventions"
              rows={6}
              defaultValue={project.conventions || ""}
              className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-sm text-stone-700 shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="settings"
              className="block font-sans text-[0.875rem] font-medium text-indigo"
            >
              {t("project:settings.settings_json")}
            </label>
            <p className="font-sans text-xs text-stone-400">
              {t("project:settings.settings_json_help")}
            </p>
            <textarea
              id="settings"
              name="settings"
              rows={4}
              defaultValue={project.settings || ""}
              className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-sm text-stone-700 shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
            {actionData?.errors?.settings && (
              <p className="mt-1 text-sm text-madder-deep">
                {actionData.errors.settings}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-md bg-indigo px-5 py-2.5 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:opacity-70"
          >
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("project:settings.save")}
          </button>
        </Form>
      </section>

      {/* Document subtypes editor */}
      <section className="border-t border-stone-200 pt-8">
        <h2 className="font-sans text-[1.5rem] font-semibold text-stone-700">
          {t("project:settings.subtypes_heading")}
        </h2>
        <p className="mt-2 max-w-2xl font-sans text-sm text-stone-500">
          {t("project:settings.subtypes_help")}
        </p>

        {actionData?.ok &&
          actionData?.message &&
          actionData._action === "updateDocumentSubtypes" && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
              <svg
                className="h-5 w-5 shrink-0 text-verdigris"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                />
              </svg>
              {actionData.message}
            </div>
          )}

        <Form method="post" className="mt-6 max-w-2xl">
          <input type="hidden" name="_action" value="updateDocumentSubtypes" />
          <input
            type="hidden"
            name="documentSubtypes"
            value={subtypeDraft.join("\n")}
          />

          <ul className="space-y-2">
            {subtypeDraft.map((subtype, index) => (
              <li
                key={`${subtype}-${index}`}
                className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <GripVertical
                  className="h-4 w-4 shrink-0 text-stone-400"
                  aria-hidden="true"
                />
                <span className="flex-1 font-serif text-[1rem] text-stone-700">
                  {subtype}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveSubtype(index, -1)}
                    disabled={index === 0}
                    className="rounded-md p-1 text-stone-500 hover:bg-stone-50 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label={t("project:settings.subtypes_move_up")}
                    title={t("project:settings.subtypes_move_up")}
                  >
                    {"\u2191"}
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSubtype(index, 1)}
                    disabled={index === subtypeDraft.length - 1}
                    className="rounded-md p-1 text-stone-500 hover:bg-stone-50 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label={t("project:settings.subtypes_move_down")}
                    title={t("project:settings.subtypes_move_down")}
                  >
                    {"\u2193"}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSubtype(index)}
                    className="rounded-md p-1 text-stone-500 hover:bg-indigo-tint hover:text-indigo"
                    aria-label={t("project:settings.subtypes_remove")}
                    title={t("project:settings.subtypes_remove")}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
            {subtypeDraft.length === 0 && (
              <li className="rounded-lg border border-dashed border-stone-200 px-3 py-4 text-center font-sans text-sm text-stone-400">
                {t("project:settings.subtypes_empty_hint")}
              </li>
            )}
          </ul>

          <div className="mt-4 flex items-center gap-2">
            <input
              type="text"
              value={newSubtype}
              onChange={(e) => setNewSubtype(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSubtype();
                }
              }}
              placeholder={t("project:settings.subtypes_add_placeholder")}
              className="flex-1 rounded-lg border border-stone-200 px-3 py-2 font-serif text-[1rem] text-stone-700 shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
            <button
              type="button"
              onClick={addSubtype}
              disabled={newSubtype.trim().length === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 px-3 py-2 font-sans text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("project:settings.subtypes_add")}
            </button>
          </div>

          <div className="mt-5 flex items-center gap-3">
            <button
              type="submit"
              disabled={isSavingSubtypes}
              className="inline-flex items-center gap-2 rounded-md bg-indigo px-5 py-2.5 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:opacity-70"
            >
              {isSavingSubtypes && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t("project:settings.subtypes_save")}
            </button>
            <button
              type="button"
              onClick={resetSubtypes}
              className="font-sans text-sm text-stone-500 hover:text-stone-700"
            >
              {t("project:settings.subtypes_reset")}
            </button>
          </div>
        </Form>
      </section>

      {/* Danger zone */}
      <section className="border-t border-stone-200 pt-8">
        <h2 className="font-sans text-[1.5rem] font-semibold text-stone-700">
          {t("project:settings.danger_zone")}
        </h2>
        <div className="mt-4 max-w-xl space-y-4">
          {/* Archive / Restore */}
          <div className="flex items-center justify-between rounded-lg border border-stone-200 px-4 py-3">
            <div>
              <p className="font-sans text-sm font-medium text-stone-700">
                {isArchived
                  ? t("project:settings.restore_title")
                  : t("project:settings.archive_title")}
              </p>
              <p className="font-sans text-xs text-stone-400">
                {isArchived
                  ? t("project:settings.restore_description")
                  : t("project:settings.archive_description")}
              </p>
            </div>
            <Form method="post">
              <input
                type="hidden"
                name="_action"
                value={isArchived ? "restoreProject" : "archiveProject"}
              />
              <button
                type="submit"
                className="rounded-md px-3 py-1.5 font-sans text-sm font-medium text-stone-500 ring-1 ring-stone-200 hover:bg-stone-50 hover:text-stone-700"
              >
                {isArchived
                  ? t("project:settings.restore")
                  : t("project:settings.archive")}
              </button>
            </Form>
          </div>

          {/* Delete (superadmin only) */}
          {isSuperAdmin && (
            <div className="rounded-lg border border-indigo/30 px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-sans text-sm font-medium text-indigo">
                    {t("project:settings.delete_title")}
                  </p>
                  <p className="font-sans text-xs text-stone-400">
                    {t("project:settings.delete_description")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(!showDeleteConfirm)}
                  className="rounded-md px-3 py-1.5 font-sans text-sm font-medium text-indigo ring-1 ring-indigo/30 hover:bg-indigo-tint"
                >
                  {t("common:button.delete")}
                </button>
              </div>
              {showDeleteConfirm && (
                <div className="mt-3 rounded-md border border-madder bg-madder-tint p-4">
                  <p className="font-sans text-sm text-stone-700">
                    {t("project:settings.delete_confirm", { name: project.name })}
                  </p>
                  <input
                    type="text"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder={project.name}
                    className="mt-2 block w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
                  />
                  <div className="mt-3 flex gap-2">
                    <Form method="post">
                      <input type="hidden" name="_action" value="deleteProject" />
                      <button
                        type="submit"
                        disabled={confirmName !== project.name}
                        className="rounded-md bg-indigo px-3 py-1.5 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t("project:settings.delete_permanently")}
                      </button>
                    </Form>
                    <button
                      type="button"
                      onClick={() => {
                        setShowDeleteConfirm(false);
                        setConfirmName("");
                      }}
                      className="rounded-lg border border-stone-200 px-3 py-1.5 font-sans text-sm text-stone-500 hover:bg-stone-50"
                    >
                      {t("common:button.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

//
