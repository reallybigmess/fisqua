/**
 * Imports Admin — mapping profile create / edit
 *
 * This page is the mapping surface (spec §2). A profile binds uploaded
 * CSV header NAMES to the tenant's descriptive-standard fields, each
 * binding carrying an optional transform. `profileId === "new"` is the
 * create form; any other id edits an existing profile.
 *
 * The loader gates on admin + the `imports` capability, resolves the
 * profile through `getVisibleProfile` (a federation-shared profile is
 * visible READ-ONLY, editable only by the owning lead tenant, spec §7.3),
 * and derives the bindable target fields from the tenant's standard —
 * never a hardcoded list.
 *
 * Editor state is the pure `profile-editor` module; its invariant — a
 * load-then-save round-trip is LOSSLESS for every transform kind —
 * belongs there, and this component only owns React state around it.
 * The share toggle renders (and is honoured by the action) only for the
 * federation-lead tenant: sharing is a lead-only act (spec §7.3), so a
 * member tenant never sees or sets it.
 *
 * The save action validates the bindings against the schema AND the
 * standard, then creates (version 1) or updates (version bumped only on
 * a bindings change, `updatedBy` / `updatedAt` stamped) a single mutable
 * row. Delete is allowed: runs and uploads keep FK-free pointers, so a
 * deleted profile leaves those intact.
 *
 * @version v0.6.0
 */

import { useMemo, useState } from "react";
import { Form, Link, redirect, useActionData, useSearchParams } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  EDITOR_TRANSFORM_KINDS,
  PARAM_KINDS,
  bindingsFromRows,
  emptyRow,
  kindOfRow,
  paramOfRow,
  rowsFromBindings,
  withKind,
  withParam,
  type EditorRow,
  type EditorTransformKind,
} from "../lib/import/profile-editor";
import type { Route } from "./+types/_auth.admin.imports.profiles.$profileId";

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { allowedTargetFields } = await import("~/lib/import/target-fields");
  const { federationLeadTenantId } = await import(
    "~/lib/import/profiles.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null on a tenant route",
    );
  }

  const db = drizzle(context.cloudflare.env.DB);
  const targetFields = allowedTargetFields(tenant.descriptiveStandard);
  const isFederationLead =
    (await federationLeadTenantId(db, tenant)) === tenant.id;

  // Optional upload context: pre-populate the source-header suggestions.
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  let availableHeaders: string[] = [];
  if (uploadId) {
    const { getUpload } = await import("~/lib/import/uploads.server");
    const upload = await getUpload(db, tenant.id, uploadId);
    if (upload?.headers) {
      try {
        availableHeaders = JSON.parse(upload.headers) as string[];
      } catch {
        availableHeaders = [];
      }
    }
  }

  if (params.profileId === "new") {
    return {
      mode: "create" as const,
      profile: null,
      readOnly: false,
      isFederationLead,
      targetFields,
      availableHeaders,
    };
  }

  const { getVisibleProfile } = await import("~/lib/import/profiles.server");
  const profile = await getVisibleProfile(db, tenant, params.profileId);
  if (!profile) throw new Response(null, { status: 404 });

  return {
    mode: "edit" as const,
    profile: {
      id: profile.id,
      name: profile.name,
      version: profile.version,
      bindings: profile.bindings,
      sharedWithFederation: profile.sharedWithFederation,
    },
    readOnly: profile.readOnly,
    isFederationLead,
    targetFields,
    availableHeaders,
  };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null on a tenant route",
    );
  }

  const db = drizzle(context.cloudflare.env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const { deleteProfile } = await import("~/lib/import/profiles.server");
    if (params.profileId !== "new") {
      await deleteProfile(db, tenant.id, params.profileId);
    }
    return redirect("/admin/imports");
  }

  // Save (create or update).
  const name = String(formData.get("name") ?? "").trim();
  if (name === "") {
    return { ok: false as const, error: "name_required" };
  }

  let bindings: unknown;
  try {
    bindings = JSON.parse(String(formData.get("bindings") ?? "[]"));
  } catch {
    return { ok: false as const, error: "invalid_bindings", issues: [] as string[] };
  }

  const { createProfile, updateProfile, federationLeadTenantId } =
    await import("~/lib/import/profiles.server");

  // Sharing is a lead-only act (spec §7.3): a non-lead tenant's checkbox
  // value is ignored, whatever the client posted.
  const isFederationLead =
    (await federationLeadTenantId(db, tenant)) === tenant.id;
  const sharedWithFederation =
    isFederationLead && formData.get("sharedWithFederation") === "on";

  const input = {
    tenantId: tenant.id,
    standard: tenant.descriptiveStandard,
    name,
    bindings,
    sharedWithFederation,
    userId: user.id,
  };

  const result =
    params.profileId === "new"
      ? await createProfile(db, input)
      : await updateProfile(db, params.profileId, input);

  if (!result.ok) {
    return {
      ok: false as const,
      error: result.error,
      issues: result.issues ?? [],
      // On duplicate_name: the conflicting profile's id, so the error can
      // link to it (a notice proposes the fix, never just names the problem).
      existingId: result.existingId,
    };
  }
  // On CREATE, a guarded returnTo (internal paths only) wins — the imports
  // journey's "create a profile, then come back to check" hand-back.
  if (params.profileId === "new") {
    const { safeReturnTo } = await import("~/lib/return-to");
    const returnTo = safeReturnTo(formData.get("returnTo"));
    if (returnTo) return redirect(returnTo);
  }
  return redirect("/admin/imports");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProfileEditorPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("imports");
  const actionData = useActionData<typeof action>();
  // The imports journey's hand-back (create a profile, return to Check).
  // Preserved through validation-error re-renders: the POST re-renders the
  // same URL, so the query parameter re-seeds the hidden field each time.
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get("returnTo");
  const {
    mode,
    profile,
    readOnly,
    isFederationLead,
    targetFields,
    availableHeaders,
  } = loaderData;

  const initialRows = useMemo<EditorRow[]>(
    () => rowsFromBindings(profile?.bindings),
    [profile],
  );

  const [rows, setRows] = useState<EditorRow[]>(initialRows);

  const bindingsJson = useMemo(
    () => JSON.stringify(bindingsFromRows(rows)),
    [rows],
  );

  const heading =
    mode === "create"
      ? t("profileEditor.createHeading")
      : readOnly
        ? t("profileEditor.viewHeading")
        : t("profileEditor.editHeading");

  function replaceRow(i: number, next: EditorRow) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? next : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }
  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  const errorToken = actionData && !actionData.ok ? actionData.error : undefined;
  const issues = actionData && !actionData.ok ? (actionData.issues ?? []) : [];
  const existingId =
    actionData && !actionData.ok ? (actionData as { existingId?: string }).existingId : undefined;

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      <nav aria-label={t("nav.breadcrumb")} className="mb-4 text-sm">
        <Link to="/admin/imports" className="text-stone-500 hover:text-stone-700">
          {t("nav.back")}
        </Link>
      </nav>

      <h1 className="font-serif text-2xl font-semibold text-stone-700">{heading}</h1>

      {readOnly && (
        <p className="mt-3 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {t("profileEditor.readOnlyNote")}
        </p>
      )}

      {errorToken && (
        <div role="alert" className="mt-4 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
          <p>
            {errorToken === "duplicate_name" ? (
              // The fix is a click away: the conflicting profile opens here
              // in the editor, ready for the rename.
              <Trans
                i18nKey="profileEditor.errors.duplicate_name"
                ns="imports"
                components={{
                  profile: existingId ? (
                    <Link
                      to={`/admin/imports/profiles/${existingId}`}
                      className="font-semibold underline"
                    />
                  ) : (
                    <span />
                  ),
                }}
              />
            ) : (
              t(`profileEditor.errors.${errorToken}`)
            )}
          </p>
          {issues.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {issues.map((iss, idx) => (
                <li key={idx}>{iss}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Form method="post" className="mt-6 space-y-6">
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="bindings" value={bindingsJson} />
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}

        <div>
          <label htmlFor="name" className="mb-1 block text-xs font-medium text-indigo">
            {t("profileEditor.name")}
          </label>
          <input
            type="text"
            id="name"
            name="name"
            defaultValue={profile?.name ?? ""}
            placeholder={t("profileEditor.namePlaceholder")}
            disabled={readOnly}
            className="w-full max-w-md rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-50"
          />
        </div>

        {isFederationLead && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sharedWithFederation"
                name="sharedWithFederation"
                defaultChecked={profile?.sharedWithFederation ?? false}
                disabled={readOnly}
                className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
              />
              <label htmlFor="sharedWithFederation" className="text-sm text-stone-700">
                {t("profileEditor.sharedToggle")}
              </label>
            </div>
            <p className="-mt-4 text-xs text-stone-400">
              {t("profileEditor.sharedHelp")}
            </p>
          </>
        )}

        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            {t("profileEditor.bindingsHeading")}
          </h2>
          <p className="mt-1 text-xs text-stone-400">{t("profileEditor.bindingsHelp")}</p>
          {availableHeaders.length > 0 && (
            <p className="mt-1 text-xs text-stone-400">
              {t("profileEditor.availableHeaders")}: {availableHeaders.join(", ")}
            </p>
          )}

          <div className="mt-3 space-y-3">
            {rows.map((row, i) => (
              <div
                key={i}
                className="grid gap-2 rounded-lg border border-stone-200 bg-white p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
              >
                <input
                  type="text"
                  aria-label={t("profileEditor.sourceHeader")}
                  placeholder={t("profileEditor.sourceHeader")}
                  value={row.source}
                  list="import-headers"
                  disabled={readOnly}
                  onChange={(e) => replaceRow(i, { ...row, source: e.target.value })}
                  className="rounded-lg border border-stone-200 px-3 py-2 font-mono text-xs text-stone-700 focus:border-indigo focus:outline-none disabled:bg-stone-50"
                />
                <select
                  aria-label={t("profileEditor.targetField")}
                  value={row.target}
                  disabled={readOnly}
                  onChange={(e) => replaceRow(i, { ...row, target: e.target.value })}
                  className="rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-700 focus:border-indigo focus:outline-none disabled:bg-stone-50"
                >
                  <option value="">{t("profileEditor.chooseTarget")}</option>
                  {targetFields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <div className="flex flex-col gap-1">
                  <select
                    aria-label={t("profileEditor.transform")}
                    value={kindOfRow(row)}
                    disabled={readOnly}
                    onChange={(e) =>
                      replaceRow(i, withKind(row, e.target.value as EditorTransformKind))
                    }
                    className="rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-700 focus:border-indigo focus:outline-none disabled:bg-stone-50"
                  >
                    {EDITOR_TRANSFORM_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(`profileEditor.transformKind.${k}`)}
                      </option>
                    ))}
                  </select>
                  {PARAM_KINDS.has(kindOfRow(row)) && (
                    <input
                      type="text"
                      aria-label={t("profileEditor.transform")}
                      value={paramOfRow(row)}
                      disabled={readOnly}
                      onChange={(e) => replaceRow(i, withParam(row, e.target.value))}
                      className="rounded-lg border border-stone-200 px-3 py-2 text-xs text-stone-700 focus:border-indigo focus:outline-none disabled:bg-stone-50"
                    />
                  )}
                </div>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="self-start text-xs font-semibold text-madder-deep hover:underline"
                  >
                    {t("profileEditor.removeBinding")}
                  </button>
                )}
              </div>
            ))}
          </div>
          <datalist id="import-headers">
            {availableHeaders.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>

          {!readOnly && (
            <button
              type="button"
              onClick={addRow}
              className="mt-3 rounded-md border border-stone-200 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("profileEditor.addBinding")}
            </button>
          )}
        </div>

        {!readOnly && (
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("profileEditor.save")}
            </button>
            <Link
              to="/admin/imports"
              className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("profileEditor.cancel")}
            </Link>
          </div>
        )}
      </Form>

      {mode === "edit" && !readOnly && (
        <Form method="post" className="mt-6">
          <input type="hidden" name="intent" value="delete" />
          <button
            type="submit"
            className="text-sm font-semibold text-madder-deep hover:underline"
          >
            {t("profileEditor.delete")}
          </button>
        </Form>
      )}
    </div>
  );
}
