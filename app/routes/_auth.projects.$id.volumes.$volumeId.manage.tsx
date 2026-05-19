/**
 * Volume Management Page
 *
 * This page is the lead-only surface for project leads to operate on
 * one volume in depth: change its status, reassign the cataloguer and
 * reviewer, edit its
 * metadata, review open QC flags reported against its pages, and — when
 * the volume is still empty and unstarted — delete it altogether.
 *
 * The loader bundles every payload the page needs in a single round-trip:
 * the volume row with its project context, the caller's project role,
 * and the list of non-resolved QC flags with reporter names denormalised
 * at read time. Non-lead members who land here through a direct link are
 * rejected by the project-role guard before the UI renders, so the page
 * can assume it is always running as a lead.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Form, Link, useFetcher, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.projects.$id.volumes.$volumeId.manage";
import type { VolumeStatus, WorkflowRole } from "../lib/workflow";
import { QcFlagCard, type QcFlagCardData } from "../components/qc-flags/qc-flag-card";
import { ResolveQcFlagDialog } from "../components/qc-flags/resolve-qc-flag-dialog";

const STATUS_BADGE_COLORS: Record<string, string> = {
  unstarted: "bg-stone-200 text-stone-500",
  in_progress: "bg-saffron-tint text-saffron-deep",
  segmented: "bg-sage-tint text-sage-deep",
  reviewed: "bg-verdigris-tint text-verdigris",
  approved: "bg-verdigris-tint text-verdigris",
  sent_back: "bg-indigo-tint text-indigo",
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql, and, inArray } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { volumes, entries, users, projectMembers } = await import("../db/schema");
  const { getValidTransitions } = await import("../lib/workflow");
  const { getQcFlagsForVolume } = await import("../lib/qc-flags.server");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const [volume] = await db
    .select()
    .from(volumes)
    .where(eq(volumes.id, params.volumeId))
    .limit(1)
    .all();

  if (!volume || volume.projectId !== params.id) {
    throw new Response("Volume not found", { status: 404 });
  }

  // Entry status counts for progress summary
  const entryCounts = await db
    .select({
      status: entries.descriptionStatus,
      count: sql<number>`COUNT(*)`,
    })
    .from(entries)
    .where(eq(entries.volumeId, params.volumeId))
    .groupBy(entries.descriptionStatus)
    .all();

  // Project members for assignment dropdowns
  const members = await db
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
      name: users.name,
      email: users.email,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, params.id))
    .all();

  // Resolve assigned user names
  const userIds = [volume.assignedTo, volume.assignedReviewer].filter(
    Boolean
  ) as string[];
  const userMap = new Map<string, { name: string | null; email: string }>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds))
      .all();
    for (const r of rows) userMap.set(r.id, { name: r.name, email: r.email });
  }

  // Valid transitions for this user's project role
  const [membership] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, params.id),
        eq(projectMembers.userId, user.id)
      )
    )
    .limit(1)
    .all();

  const workflowRole: WorkflowRole =
    user.isAdmin || !membership
      ? "lead"
      : (membership.role as WorkflowRole);

  const validTransitions = getValidTransitions(
    volume.status as VolumeStatus,
    workflowRole
  );

  // open QC flags on this volume, with denormalised
  // reporter / resolver display names so the card renders without the
  // caller doing any joining. The loader is already behind the lead-only
  // requireProjectRole guard at the top of this function, so every flag
  // row the caller sees belongs to a project they can read (no cross-
  // project disclosure).
  const openQcFlags = await getQcFlagsForVolume(db, params.volumeId, {
    statuses: ["open"],
  });
  const reporterIds = Array.from(
    new Set(openQcFlags.map((f) => f.reportedBy).filter(Boolean))
  ) as string[];
  const reporterMap = new Map<string, { name: string | null; email: string }>();
  if (reporterIds.length > 0) {
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, reporterIds))
      .all();
    for (const r of rows) reporterMap.set(r.id, { name: r.name, email: r.email });
  }

  const qcFlags: QcFlagCardData[] = openQcFlags.map((f) => {
    const reporter = reporterMap.get(f.reportedBy);
    return {
      id: f.id,
      pageId: f.pageId,
      problemType: f.problemType,
      description: f.description,
      status: f.status,
      resolutionAction: f.resolutionAction,
      resolverNote: f.resolverNote,
      reportedBy: f.reportedBy,
      reportedByName: reporter?.name ?? reporter?.email ?? f.reportedBy,
      resolvedBy: f.resolvedBy ?? null,
      resolvedByName: null,
      resolvedAt: f.resolvedAt ?? null,
      createdAt: f.createdAt,
    };
  });

  // The loader's top-line requireProjectRole already restricted access to
  // leads; surface the role explicitly so the client dialog's role-gate
  // has a single source of truth.
  const userRole: "lead" | "cataloguer" | "reviewer" = "lead";

  return {
    volume,
    projectId: params.id,
    entryCounts,
    members,
    userMap: Object.fromEntries(userMap),
    validTransitions,
    canDelete: !volume.assignedTo && volume.status === "unstarted",
    canForceDelete: !!user.isSuperAdmin,
    qcFlags,
    userRole,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and } = await import("drizzle-orm");
  const { redirect } = await import("react-router");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { volumes, projectMembers } = await import("../db/schema");
  const { deleteVolume, forceDeleteVolume } = await import("../lib/volumes.server");
  const { transitionVolumeStatus } = await import("../lib/workflow.server");
  const { getInstance } = await import("~/middleware/i18next");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  if (intent === "updateMetadata") {
    const name = (formData.get("name") as string)?.trim();
    const referenceCode = (formData.get("referenceCode") as string)?.trim();

    if (!name || !referenceCode) {
      return { ok: false, error: i18n.t("volume_admin:error_name_required") };
    }

    await db
      .update(volumes)
      .set({ name, referenceCode, updatedAt: Date.now() })
      .where(eq(volumes.id, params.volumeId));

    return { ok: true, message: i18n.t("volume_admin:metadata_updated") };
  }

  if (intent === "assignCataloguer") {
    const userId = formData.get("userId") as string;
    await db
      .update(volumes)
      .set({
        assignedTo: userId || null,
        updatedAt: Date.now(),
      })
      .where(eq(volumes.id, params.volumeId));

    return {
      ok: true,
      message: i18n.t(
        userId
          ? "volume_admin:cataloguer_assigned"
          : "volume_admin:cataloguer_unassigned"
      ),
    };
  }

  if (intent === "assignReviewer") {
    const userId = formData.get("userId") as string;
    await db
      .update(volumes)
      .set({
        assignedReviewer: userId || null,
        updatedAt: Date.now(),
      })
      .where(eq(volumes.id, params.volumeId));

    return {
      ok: true,
      message: i18n.t(
        userId
          ? "volume_admin:reviewer_assigned"
          : "volume_admin:reviewer_unassigned"
      ),
    };
  }

  if (intent === "transitionStatus") {
    const targetStatus = formData.get("targetStatus") as VolumeStatus;
    const comment = formData.get("comment") as string | null;

    // Determine workflow role
    const [membership] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, params.id),
          eq(projectMembers.userId, user.id)
        )
      )
      .limit(1)
      .all();

    const workflowRole: WorkflowRole =
      user.isAdmin || !membership
        ? "lead"
        : (membership.role as WorkflowRole);

    try {
      await transitionVolumeStatus(
        db,
        params.volumeId,
        targetStatus,
        user.id,
        workflowRole,
        comment || undefined
      );
      return {
        ok: true,
        message: i18n.t("volume_admin:status_changed", {
          status: i18n.t(`workflow:status.${targetStatus}`),
        }),
      };
    } catch (err) {
      const msg =
        err instanceof Response
          ? await err.text()
          : i18n.t("volume_admin:error_transition_failed");
      return { ok: false, error: msg };
    }
  }

  if (intent === "delete" || intent === "forceDelete") {
    // Force delete requires superadmin
    if (intent === "forceDelete" && !user.isSuperAdmin) {
      return { ok: false, error: i18n.t("volume_admin:error_unknown_action") };
    }
    try {
      if (intent === "forceDelete") {
        await forceDeleteVolume(db, params.volumeId);
      } else {
        await deleteVolume(db, params.volumeId);
      }
      throw redirect(`/projects/${params.id}/volumes`);
    } catch (err) {
      if (
        err instanceof Response &&
        err.status >= 300 &&
        err.status < 400
      ) {
        throw err;
      }
      const msg =
        err instanceof Response
          ? await err.text()
          : i18n.t("project:error.delete_failed");
      return { ok: false, error: msg };
    }
  }

  return { ok: false, error: i18n.t("volume_admin:error_unknown_action") };
}

function StatusTransitionForm({
  validTransitions,
}: {
  validTransitions: VolumeStatus[];
}) {
  const { t } = useTranslation(["volume_admin", "workflow"]);
  const fetcher = useFetcher();
  const [selected, setSelected] = useState<VolumeStatus | "">("");
  const [comment, setComment] = useState("");
  const isApplying = fetcher.state !== "idle";

  if (validTransitions.length === 0) {
    return (
      <p className="font-sans text-sm text-stone-400">
        {t("volume_admin:no_transitions")}
      </p>
    );
  }

  return (
    <fetcher.Form method="post" className="space-y-3">
      <input type="hidden" name="_action" value="transitionStatus" />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className="mb-1 block font-sans text-xs font-medium text-indigo">
            {t("volume_admin:change_status_to")}
          </label>
          <select
            name="targetStatus"
            value={selected}
            onChange={(e) => setSelected(e.target.value as VolumeStatus)}
            required
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
          >
            <option value="">{t("volume_admin:select_new_status")}</option>
            {validTransitions.map((s) => (
              <option key={s} value={s}>
                {t(`workflow:status.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={!selected || isApplying}
          className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:opacity-50"
        >
          {isApplying && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("volume_admin:apply")}
        </button>
      </div>
      {selected === "sent_back" && (
        <div>
          <label className="mb-1 block font-sans text-xs font-medium text-indigo">
            {t("volume_admin:sent_back_reason")}
          </label>
          <textarea
            name="comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
          />
        </div>
      )}
    </fetcher.Form>
  );
}

function DangerZone({
  volume,
  canDelete,
  canForceDelete,
}: {
  volume: { id: string; name: string };
  canDelete: boolean;
  canForceDelete: boolean;
}) {
  const { t } = useTranslation("volume_admin");
  const deleteFetcher = useFetcher();
  const forceFetcher = useFetcher();
  const [deleteTyped, setDeleteTyped] = useState("");
  const [forceTyped, setForceTyped] = useState("");

  const deleteResult = deleteFetcher.data as
    | { ok: boolean; message?: string; error?: string }
    | undefined;
  const forceResult = forceFetcher.data as
    | { ok: boolean; message?: string; error?: string }
    | undefined;

  const isNothingShown = !canDelete && !canForceDelete;

  return (
    <section>
      <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-indigo">
        {t("section_danger_zone")}
      </h2>
      <div className="space-y-4 rounded-md border border-indigo bg-indigo-tint p-4">
        {isNothingShown && (
          <p className="font-sans text-sm text-stone-700">
            {t("delete_ineligible")}
          </p>
        )}

        {canDelete && (
          <div>
            <p className="mb-2 font-sans text-sm font-semibold text-indigo">
              {t("delete_button")}
            </p>
            <p className="mb-3 font-sans text-sm text-stone-700">
              {t("delete_eligible")}
            </p>
            <deleteFetcher.Form method="post">
              <input type="hidden" name="_action" value="delete" />
              <label
                htmlFor={`delete-confirm-${volume.id}`}
                className="mb-1 block font-sans text-xs font-medium text-indigo"
              >
                {t("force_delete_type_name", { name: volume.name })}
              </label>
              <input
                id={`delete-confirm-${volume.id}`}
                type="text"
                value={deleteTyped}
                onChange={(e) => setDeleteTyped(e.target.value)}
                autoComplete="off"
                className="mb-3 w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              />
              {deleteResult && !deleteResult.ok && deleteResult.error && (
                <p className="mb-2 font-sans text-sm text-indigo">
                  {deleteResult.error}
                </p>
              )}
              <button
                type="submit"
                disabled={deleteTyped !== volume.name}
                className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("delete_button")}
              </button>
            </deleteFetcher.Form>
          </div>
        )}

        {canForceDelete && (
          <div className={canDelete ? "border-t border-indigo/30 pt-4" : ""}>
            <p className="mb-2 font-sans text-sm font-semibold text-indigo">
              {t("force_delete_heading")}
            </p>
            <p className="mb-3 font-sans text-sm text-stone-700">
              {t("force_delete_warning")}
            </p>
            <forceFetcher.Form method="post">
              <input type="hidden" name="_action" value="forceDelete" />
              <label
                htmlFor={`force-confirm-${volume.id}`}
                className="mb-1 block font-sans text-xs font-medium text-indigo"
              >
                {t("force_delete_type_name", { name: volume.name })}
              </label>
              <input
                id={`force-confirm-${volume.id}`}
                type="text"
                value={forceTyped}
                onChange={(e) => setForceTyped(e.target.value)}
                autoComplete="off"
                className="mb-3 w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              />
              {forceResult && !forceResult.ok && forceResult.error && (
                <p className="mb-2 font-sans text-sm text-indigo">
                  {forceResult.error}
                </p>
              )}
              <button
                type="submit"
                disabled={forceTyped !== volume.name}
                className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("force_delete_button")}
              </button>
            </forceFetcher.Form>
          </div>
        )}
      </div>
    </section>
  );
}

export default function VolumeManagePage({
  loaderData,
}: Route.ComponentProps) {
  const {
    volume,
    projectId,
    entryCounts,
    members,
    userMap,
    validTransitions,
    canDelete,
    canForceDelete,
    qcFlags,
    userRole,
  } = loaderData;
  const { t } = useTranslation([
    "volume_admin",
    "workflow",
    "common",
    "qc_flags",
  ]);
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  // single shared ResolveQcFlagDialog instance. State
  // carries the target flag id plus an open flag; onResolved triggers a
  // revalidation so the just-resolved card drops out of the list.
  const [resolveState, setResolveState] = useState<{
    open: boolean;
    flagId: string | null;
  }>({ open: false, flagId: null });

  const result = fetcher.data as
    | { ok: boolean; message?: string; error?: string }
    | undefined;

  const cataloguers = members.filter(
    (m) => m.role === "cataloguer" || m.role === "lead"
  );
  const reviewers = members.filter(
    (m) => m.role === "reviewer" || m.role === "lead"
  );

  const totalEntries = entryCounts.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* Breadcrumb */}
      <nav className="font-sans text-sm text-stone-500">
        <Link
          to={`/projects/${projectId}/volumes`}
          className="hover:text-stone-700"
        >
          {t("volume_admin:breadcrumb_volumes")}
        </Link>
        <span className="mx-2">&rsaquo;</span>
        <span className="text-stone-700">{volume.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold text-stone-700">
            {volume.name}
          </h1>
          <p className="mt-1 font-mono text-sm text-stone-500">
            {volume.referenceCode}
          </p>
          <div className="mt-2 flex items-center gap-3 font-sans text-sm text-stone-500">
            <span>{t("volume_admin:pages", { count: volume.pageCount })}</span>
            <span className="text-stone-300">·</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_BADGE_COLORS[volume.status] || "bg-stone-200 text-stone-500"}`}
            >
              {t(`workflow:status.${volume.status}`)}
            </span>
          </div>
        </div>
        <Link
          to={`/projects/${projectId}/volumes/${volume.id}`}
          className="rounded-md border border-indigo px-4 py-2 font-sans text-sm font-semibold text-indigo hover:bg-indigo-tint"
        >
          {t("volume_admin:open_in_viewer")}
        </Link>
      </div>

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

      {/* Progress */}
      <section>
        <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
          {t("volume_admin:section_progress")}
        </h2>
        {totalEntries === 0 ? (
          <p className="rounded-lg border border-stone-200 px-4 py-3 font-sans text-sm text-stone-400">
            {t("volume_admin:entries_empty")}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("volume_admin:col_description_status")}
                  </th>
                  <th className="px-4 py-2 text-right font-sans text-xs font-medium uppercase text-stone-500">
                    {t("volume_admin:col_count")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {entryCounts.map((c) => (
                  <tr key={c.status || "none"}>
                    <td className="px-4 py-2 font-sans text-sm text-stone-700">
                      {c.status || "—"}
                    </td>
                    <td className="px-4 py-2 text-right font-sans text-sm text-stone-700">
                      {c.count}
                    </td>
                  </tr>
                ))}
                <tr className="bg-stone-50">
                  <td className="px-4 py-2 font-sans text-sm font-semibold text-stone-700">
                    {t("volume_admin:col_total")}
                  </td>
                  <td className="px-4 py-2 text-right font-sans text-sm font-semibold text-stone-700">
                    {totalEntries}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* QC flags */}
      <section>
        <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
          {t("qc_flags:card.status.open")}
        </h2>
        {qcFlags.length === 0 ? (
          <p className="rounded-lg border border-stone-200 px-4 py-3 font-sans text-sm text-stone-400">
            {t("qc_flags:badge.no_flags")}
          </p>
        ) : (
          <>
            <p className="mb-3 font-sans text-sm text-stone-500">
              {t("qc_flags:badge.open_count", { count: qcFlags.length })}
            </p>
            <div className="space-y-3">
              {qcFlags.map((flag) => (
                <QcFlagCard
                  key={flag.id}
                  flag={flag}
                  onResolveClick={
                    userRole === "lead"
                      ? () =>
                          setResolveState({ open: true, flagId: flag.id })
                      : undefined
                  }
                />
              ))}
            </div>
          </>
        )}
      </section>

      {/* Assignments */}
      <section>
        <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
          {t("volume_admin:section_assignments")}
        </h2>
        <div className="space-y-3 rounded-lg border border-stone-200 p-4">
          <fetcher.Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="_action" value="assignCataloguer" />
            <div className="flex-1">
              <label className="mb-1 block font-sans text-xs font-medium text-indigo">
                {t("volume_admin:cataloguer_label")}
              </label>
              <select
                name="userId"
                defaultValue={volume.assignedTo || ""}
                onChange={(e) => e.target.form?.requestSubmit()}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              >
                <option value="">{t("volume_admin:unassigned")}</option>
                {cataloguers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name || m.email} ({m.role})
                  </option>
                ))}
              </select>
            </div>
          </fetcher.Form>

          <fetcher.Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="_action" value="assignReviewer" />
            <div className="flex-1">
              <label className="mb-1 block font-sans text-xs font-medium text-indigo">
                {t("volume_admin:reviewer_label")}
              </label>
              <select
                name="userId"
                defaultValue={volume.assignedReviewer || ""}
                onChange={(e) => e.target.form?.requestSubmit()}
                className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
              >
                <option value="">{t("volume_admin:unassigned")}</option>
                {reviewers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name || m.email} ({m.role})
                  </option>
                ))}
              </select>
            </div>
          </fetcher.Form>
        </div>
      </section>

      {/* Status workflow */}
      <section>
        <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
          {t("volume_admin:section_workflow")}
        </h2>
        <div className="rounded-lg border border-stone-200 p-4">
          {volume.reviewComment && (
            <div className="mb-3 rounded-md bg-indigo-tint px-3 py-2 font-sans text-sm text-stone-700">
              <span className="font-semibold">{t("volume_admin:sent_back_prefix")} </span>
              {volume.reviewComment}
            </div>
          )}
          <StatusTransitionForm validTransitions={validTransitions} />
        </div>
      </section>

      {/* Metadata */}
      <section>
        <h2 className="mb-3 font-sans text-xs font-semibold uppercase tracking-wider text-stone-500">
          {t("volume_admin:section_metadata")}
        </h2>
        <fetcher.Form
          method="post"
          className="space-y-3 rounded-lg border border-stone-200 p-4"
        >
          <input type="hidden" name="_action" value="updateMetadata" />
          <div>
            <label className="mb-1 block font-sans text-xs font-medium text-indigo">
              {t("volume_admin:name_label")}
            </label>
            <input
              type="text"
              name="name"
              defaultValue={volume.name}
              required
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block font-sans text-xs font-medium text-indigo">
              {t("volume_admin:reference_code_label")}
            </label>
            <input
              type="text"
              name="referenceCode"
              defaultValue={volume.referenceCode}
              required
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("volume_admin:save_metadata")}
          </button>
        </fetcher.Form>
      </section>

      {/* Danger zone */}
      <DangerZone
        volume={volume}
        canDelete={canDelete}
        canForceDelete={canForceDelete}
      />

      {/* single shared resolve dialog. Only renders
       *  for leads (the component returns null for non-lead roles); on
       *  success the page revalidates to refresh the open-flags list. */}
      {resolveState.open && resolveState.flagId && (
        <ResolveQcFlagDialog
          open={resolveState.open}
          flagId={resolveState.flagId}
          userRole={userRole}
          onClose={() => setResolveState({ open: false, flagId: null })}
          onResolved={() => {
            setResolveState({ open: false, flagId: null });
            revalidator.revalidate();
          }}
        />
      )}
    </div>
  );
}

