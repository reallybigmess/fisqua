/**
 * Repositories Admin — Edit
 *
 * This page is the edit form for a single repository. Every
 * ISAD-adjacent field is editable here, including the display metadata
 * that the public
 * frontend surfaces -- display title, subtitle, hero image -- plus the
 * institution's rights statement. Autosaves to `drafts` via useFetcher
 * on a debounce so a curator's work survives a page reload, and
 * commits a final row to the `changelog` table on explicit save so
 * editors can audit who changed what and when. A draft conflict banner
 * appears if another user has an open draft on the same record.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `repositories`,
 * `descriptions`, and `users` is filtered by `tenant.id`.
 *
 * @version v0.4.0
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Form,
  useLoaderData,
  useActionData,
  useFetcher,
  redirect,
  Link,
} from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import { DescriptionTree } from "~/components/descriptions/description-tree";
import type { Route } from "./+types/_auth.admin.repositories.$id";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, asc, sql } = await import("drizzle-orm");
  const { repositories, descriptions } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const repository = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)))
    .get();

  if (!repository) {
    throw new Response("Not found", { status: 404 });
  }

  // Count linked descriptions
  const [{ count: descriptionCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.repositoryId, id)
      )
    )
    .all();

  // Top-level descriptions for the tree (SSR initial data)
  const topLevelDescriptions = descriptionCount > 0
    ? await db
        .select({
          id: descriptions.id,
          title: descriptions.title,
          referenceCode: descriptions.referenceCode,
          descriptionLevel: descriptions.descriptionLevel,
          childCount: descriptions.childCount,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.repositoryId, id),
            eq(descriptions.depth, 0)
          )
        )
        .orderBy(asc(descriptions.position))
        .all()
    : [];

  // Check for another user's draft on this record
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, id, "repository", user.id);
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .where(
        and(eq(users.tenantId, tenant.id), eq(users.id, conflictRaw.userId))
      )
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  return { repository, descriptionCount, topLevelDescriptions, conflictDraft };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { repositories, descriptions } = await import("~/db/schema");
  const { updateRepositorySchema } = await import(
    "~/lib/validation/repository"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, id, "repository", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      // Normalise empty strings to undefined for optional fields
      const code = (formData.get("code") as string)?.trim() || undefined;
      const name = (formData.get("name") as string)?.trim() || undefined;
      const shortName =
        (formData.get("shortName") as string)?.trim() || undefined;
      const countryCode =
        (formData.get("countryCode") as string)?.trim() || undefined;
      const country =
        (formData.get("country") as string)?.trim() || undefined;
      const city = (formData.get("city") as string)?.trim() || undefined;
      const address =
        (formData.get("address") as string)?.trim() || undefined;
      const website =
        (formData.get("website") as string)?.trim() || undefined;
      const notes = (formData.get("notes") as string)?.trim() || undefined;
      const rightsText =
        (formData.get("rightsText") as string)?.trim() || undefined;
      const displayTitle =
        (formData.get("displayTitle") as string)?.trim() || null;
      const subtitle =
        (formData.get("subtitle") as string)?.trim() || null;
      const heroImageUrl =
        (formData.get("heroImageUrl") as string)?.trim() || null;
      const enabled = formData.get("enabled") === "on";

      // T-28-01: Validate heroImageUrl — only http/https protocols
      if (heroImageUrl) {
        try {
          const parsed = new URL(heroImageUrl);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return {
              ok: false as const,
              errors: { heroImageUrl: ["URL must use http or https protocol"] },
            };
          }
        } catch {
          return {
            ok: false as const,
            errors: { heroImageUrl: ["Invalid URL"] },
          };
        }
      }

      const parsed = updateRepositorySchema.safeParse({
        id,
        code,
        name,
        shortName,
        countryCode,
        country,
        city,
        address,
        website,
        notes,
        enabled,
      });

      if (!parsed.success) {
        return {
          ok: false as const,
          errors: parsed.error.flatten().fieldErrors,
        };
      }

      // Fetch original for changelog diff
      const original = await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)))
        .get();

      // Optimistic lock check
      const formUpdatedAt = formData.get("_updatedAt") as string;
      const forceOverwrite = formData.get("_force") === "true";
      if (
        !forceOverwrite &&
        formUpdatedAt &&
        original &&
        String(original.updatedAt) !== formUpdatedAt
      ) {
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedAt: original.updatedAt,
        };
      }

      const { id: _id, ...updates } = parsed.data;
      const updatedFields = {
        ...updates,
        shortName: updates.shortName ?? null,
        country: updates.country ?? null,
        city: updates.city ?? null,
        address: updates.address ?? null,
        website: updates.website ?? null,
        notes: updates.notes ?? null,
        rightsText: rightsText ?? null,
        displayTitle,
        subtitle,
        heroImageUrl,
      };

      try {
        await db
          .update(repositories)
          .set({
            ...updatedFields,
            updatedAt: Date.now(),
          })
          .where(
            and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id))
          );
      } catch (e) {
        if (String(e).includes("UNIQUE constraint failed")) {
          return { ok: false as const, error: "duplicate_code" };
        }
        return { ok: false as const, error: "generic" };
      }

      // Compute diff and create changelog entry
      if (original) {
        const { computeDiff, createChangelogEntry } = await import(
          "~/lib/changelog.server"
        );
        const diff = computeDiff(
          original as unknown as Record<string, unknown>,
          updatedFields as unknown as Record<string, unknown>
        );
        if (diff) {
          const commitNote =
            (formData.get("commitNote") as string)?.trim() || undefined;
          await createChangelogEntry(
            db,
            id,
            "repository",
            user.id,
            diff,
            commitNote
          );
        }
      }

      // Delete draft after successful save
      const { deleteDraft } = await import("~/lib/drafts.server");
      await deleteDraft(db, id, "repository");

      return { ok: true as const, message: "updated" };
    }

    case "delete": {
      // Safety: check description count before deleting
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.repositoryId, id)
          )
        )
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      await db
        .delete(repositories)
        .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.id, id)));
      return redirect("/admin/repositories");
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RepositoryDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const { repository, descriptionCount, topLevelDescriptions, conflictDraft } =
    loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("repositories");

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const hasDescriptions = descriptionCount > 0;

  // Show conflict dialog when server returns optimistic lock error
  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error === "conflict") {
      setShowConflictDialog(true);
    }
  }, [actionData]);

  // Autosave via useFetcher
  const draftFetcher = useFetcher();
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const triggerAutosave = useCallback(() => {
    if (!formRef.current || !isEditing) return;
    const fd = new FormData(formRef.current);
    const snapshot: Record<string, string> = {};
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith("_")) {
        snapshot[key] = value as string;
      }
    }
    draftFetcher.submit(
      { _action: "autosave", snapshot: JSON.stringify(snapshot) },
      { method: "post" }
    );
  }, [isEditing, draftFetcher]);

  const handleFormChange = useCallback(() => {
    if (!isEditing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(triggerAutosave, 2000);
  }, [isEditing, triggerAutosave]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isEditing]);

  const draftStatus =
    draftFetcher.state === "submitting"
      ? "saving"
      : draftFetcher.data && "autosaved" in draftFetcher.data
        ? "saved"
        : null;

  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;
  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const successMessage =
    actionData && "message" in actionData && actionData.ok
      ? actionData.message
      : undefined;

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/repositories"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{repository.name}</li>
        </ol>
      </nav>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">
          {repository.name}
        </h1>

        {!isEditing ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Pencil className="h-4 w-4" />
              {t("edit")}
            </button>
            <button
              type="button"
              onClick={() => !hasDescriptions && setShowDeleteModal(true)}
              disabled={hasDescriptions}
              aria-disabled={hasDescriptions ? "true" : undefined}
              title={
                hasDescriptions
                  ? t("delete_blocked", { count: descriptionCount })
                  : undefined
              }
              className={
                hasDescriptions
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                  : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
              }
            >
              <Trash2 className="h-4 w-4" />
              {t("delete")}
            </button>
          </div>
        ) : null}
      </div>

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
            namespace="repositories"
          />
        </div>
      )}

      {/* Autosave status */}
      {isEditing && draftStatus && (
        <p className="mt-2 text-xs text-stone-400">
          {draftStatus === "saving"
            ? t("autosave_saving")
            : t("autosave_saved")}
        </p>
      )}

      {/* Success banner */}
      {successMessage === "updated" && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
          {t("success_updated")}
        </div>
      )}

      {/* Error banner */}
      {globalError && globalError !== "conflict" && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "duplicate_code"
            ? t("error_duplicate_code")
            : globalError === "has_descriptions"
              ? t("delete_blocked", { count: descriptionCount })
              : t("error_generic")}
        </div>
      )}

      {/* Linked descriptions tree */}
      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
          {t("linked_descriptions")}
        </h2>
        <div className="rounded-lg border border-stone-200 bg-white p-4">
          <DescriptionTree
            repositoryId={repository.id}
            descriptionCount={descriptionCount}
            initialDescriptions={topLevelDescriptions}
          />
        </div>
        {hasDescriptions && (
          <p className="mt-2 text-xs text-stone-400">
            {t("delete_blocked_inline", { count: descriptionCount })}
          </p>
        )}
      </div>

      {/* Detail card */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        {isEditing ? (
          <EditMode
            repository={repository}
            errors={errors}
            t={t}
            onDiscard={() => setIsEditing(false)}
            formRef={formRef}
            onFormChange={handleFormChange}
          />
        ) : (
          <ViewMode repository={repository} t={t} />
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowDeleteModal(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="delete-modal-title"
            aria-describedby="delete-modal-body"
            className="max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("delete_modal_title")}
            </h2>
            <p
              id="delete-modal-body"
              className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto"
            >
              {t("delete_modal_body", { name: repository.name })}
            </p>
            <div className="mt-3">
              <label
                htmlFor="delete-confirm-input"
                className="block text-xs font-medium text-indigo mb-1"
              >
                {t("delete_modal_confirm_label", { code: repository.code })}
              </label>
              <input
                id="delete-confirm-input"
                type="text"
                autoComplete="off"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none focus:ring-1 focus:ring-madder"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmation("");
                }}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("delete_modal_dismiss")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  disabled={deleteConfirmation !== repository.code}
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("delete")}
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}
      {/* Optimistic lock conflict dialog */}
      {showConflictDialog &&
        actionData &&
        "error" in actionData &&
        actionData.error === "conflict" && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
              <h2 className="text-lg font-semibold text-stone-700">
                {t("overwrite_confirm", {
                  name: "",
                  time:
                    "modifiedAt" in actionData
                      ? new Date(
                          actionData.modifiedAt as number
                        ).toLocaleString()
                      : "",
                })}
              </h2>
              <div className="mt-4 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowConflictDialog(false)}
                  className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
                >
                  {t("overwrite_cancel")}
                </button>
                <Form method="post">
                  <input type="hidden" name="_action" value="update" />
                  <input type="hidden" name="_force" value="true" />
                  <input
                    type="hidden"
                    name="_updatedAt"
                    value={String(repository.updatedAt)}
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
                  >
                    {t("overwrite_button")}
                  </button>
                </Form>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

function ViewMode({
  repository,
  t,
}: {
  repository: Awaited<ReturnType<typeof loader>>["repository"];
  t: (key: string) => string;
}) {
  return (
    <div className="space-y-6">
      {/* Identity area */}
      <section>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
          {t("section_identity")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay label={t("field.code")} value={repository.code} />
          <FieldDisplay label={t("field.name")} value={repository.name} />
          <FieldDisplay
            label={t("field.shortName")}
            value={repository.shortName}
          />
        </div>
      </section>

      {/* Contact area */}
      <section>
        <h2 className="mt-6 mb-4 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
          {t("section_contact")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay
            label={t("field.countryCode")}
            value={repository.countryCode}
          />
          <FieldDisplay
            label={t("field.country")}
            value={repository.country}
          />
          <FieldDisplay label={t("field.city")} value={repository.city} />
          <FieldDisplay
            label={t("field.address")}
            value={repository.address}
          />
          {repository.website ? (
            <div>
              <p className="text-xs text-stone-500">{t("field.website")}</p>
              <a
                href={repository.website}
                target="_blank"
                rel="noopener"
                className="text-sm text-indigo-deep hover:underline"
              >
                {repository.website}
              </a>
            </div>
          ) : (
            <FieldDisplay
              label={t("field.website")}
              value={null}
            />
          )}
        </div>
      </section>

      {/* Administrative */}
      <section>
        <h2 className="mt-6 mb-4 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
          {t("section_admin")}
        </h2>
        <div className="space-y-3">
          <FieldDisplay label={t("field.notes")} value={repository.notes} />
          <FieldDisplay label={t("field.rightsText")} value={repository.rightsText} />
          <FieldDisplay label={t("display_title_label")} value={repository.displayTitle} />
          <FieldDisplay label={t("subtitle_label")} value={repository.subtitle} />
          <FieldDisplay label={t("hero_image_url_label")} value={repository.heroImageUrl} />
          <div>
            <p className="text-xs text-stone-500">{t("field.enabled")}</p>
            {repository.enabled ? (
              <span className="mt-1 inline-block rounded-full bg-verdigris-tint px-2 py-0.5 text-xs font-medium text-verdigris">
                {t("badge_enabled")}
              </span>
            ) : (
              <span className="mt-1 inline-block rounded-full bg-indigo-tint px-2 py-0.5 text-xs font-medium text-indigo">
                {t("badge_disabled")}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function FieldDisplay({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-sm text-stone-700">{value || "\u2014"}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditMode({
  repository,
  errors,
  t,
  onDiscard,
  formRef,
  onFormChange,
}: {
  repository: Awaited<ReturnType<typeof loader>>["repository"];
  errors?: Record<string, string[]> | undefined;
  t: (key: string) => string;
  onDiscard: () => void;
  formRef?: React.Ref<HTMLFormElement>;
  onFormChange?: () => void;
}) {
  return (
    <Form method="post" ref={formRef} onChange={onFormChange}>
      <input type="hidden" name="_action" value="update" />
      <input
        type="hidden"
        name="_updatedAt"
        value={String(repository.updatedAt)}
      />

      {/* Identity area */}
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
        {t("section_identity")}
      </h2>
      <div className="space-y-4">
        <EditField
          name="code"
          label={t("field.code")}
          defaultValue={repository.code}
          required
          error={errors?.code?.[0]}
        />
        <EditField
          name="name"
          label={t("field.name")}
          defaultValue={repository.name}
          required
          error={errors?.name?.[0]}
        />
        <EditField
          name="shortName"
          label={t("field.shortName")}
          defaultValue={repository.shortName ?? ""}
          error={errors?.shortName?.[0]}
        />
      </div>

      {/* Contact area */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
        {t("section_contact")}
      </h2>
      <div className="space-y-4">
        <EditField
          name="countryCode"
          label={t("field.countryCode")}
          defaultValue={repository.countryCode ?? "COL"}
          required
          error={errors?.countryCode?.[0]}
        />
        <EditField
          name="country"
          label={t("field.country")}
          defaultValue={repository.country ?? ""}
          error={errors?.country?.[0]}
        />
        <EditField
          name="city"
          label={t("field.city")}
          defaultValue={repository.city ?? ""}
          error={errors?.city?.[0]}
        />
        <EditTextarea
          name="address"
          label={t("field.address")}
          defaultValue={repository.address ?? ""}
          error={errors?.address?.[0]}
        />
        <EditField
          name="website"
          label={t("field.website")}
          defaultValue={repository.website ?? ""}
          error={errors?.website?.[0]}
        />
      </div>

      {/* Administrative */}
      <h2 className="mb-4 mt-6 text-sm font-semibold uppercase tracking-[0.05em] text-stone-500">
        {t("section_admin")}
      </h2>
      <div className="space-y-4">
        <EditTextarea
          name="notes"
          label={t("field.notes")}
          defaultValue={repository.notes ?? ""}
          error={errors?.notes?.[0]}
        />
        <EditTextarea
          name="rightsText"
          label={t("field.rightsText")}
          defaultValue={repository.rightsText ?? ""}
          error={errors?.rightsText?.[0]}
        />
        <EditField
          name="displayTitle"
          label={t("display_title_label")}
          defaultValue={repository.displayTitle ?? ""}
          error={errors?.displayTitle?.[0]}
          helperText={t("display_title_helper")}
        />
        <EditField
          name="subtitle"
          label={t("subtitle_label")}
          defaultValue={repository.subtitle ?? ""}
          error={errors?.subtitle?.[0]}
          helperText={t("subtitle_helper")}
        />
        <EditField
          name="heroImageUrl"
          label={t("hero_image_url_label")}
          defaultValue={repository.heroImageUrl ?? ""}
          error={errors?.heroImageUrl?.[0]}
          helperText={t("hero_image_url_helper")}
          type="url"
        />
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="enabled"
            name="enabled"
            defaultChecked={repository.enabled ?? true}
            className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
          />
          <label htmlFor="enabled" className="text-sm font-medium text-indigo">
            {t("badge_enabled")}
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-6 space-y-3 border-t border-stone-200 pt-4">
        <input
          type="text"
          name="commitNote"
          placeholder={t("commit_note_placeholder")}
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        />
        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("save")}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("discard")}
          </button>
        </div>
      </div>
    </Form>
  );
}

function EditField({
  name,
  label,
  defaultValue,
  required,
  error,
  helperText,
  type = "text",
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  error?: string;
  helperText?: string;
  type?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  const helperId = helperText ? `${name}-helper` : undefined;
  const describedBy = [errorId, helperId].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        {required && <span className="text-madder"> *</span>}
      </label>
      <input
        type={type}
        id={name}
        name={name}
        defaultValue={defaultValue}
        aria-required={required ? "true" : undefined}
        aria-describedby={describedBy}
        className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {helperText && (
        <p id={helperId} className="mt-1 text-xs text-stone-400">
          {helperText}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}

function EditTextarea({
  name,
  label,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  defaultValue: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={3}
        defaultValue={defaultValue}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}
