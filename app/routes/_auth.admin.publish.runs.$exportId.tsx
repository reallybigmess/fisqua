/**
 * Publish Run Detail
 *
 * This page is the per-run detail surface reached from the publish
 * dashboard history table. It shows the row as it currently stands in
 * `export_runs` — the
 * selected fonds and types, the step counter, the record counts, and
 * any error message — plus a link into the workflow dashboard keyed
 * by `workflowInstanceId`. Used to diagnose runs that stalled or
 * failed.
 *
 * @version v0.3.0
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { userContext } from "../context";
import { formatIsoDateTime } from "~/lib/format-date";
import type { Route } from "./+types/_auth.admin.publish.runs.$exportId";

/**
 * Publish run detail page.
 *
 * Shows the full export_runs row for a single export, rendered in readable
 * sections: overview, timings, per-step record counts, error (if any), raw
 * data. All timestamps go through formatIsoDateTime. Link back to
 * /admin/publish at the top.
 */

interface RunDetailLoaderData {
  authorized: boolean;
  run: {
    id: string;
    status: string;
    triggeredBy: string | null;
    selectedFonds: string[];
    selectedTypes: string[];
    workflowInstanceId: string | null;
    currentStep: string | null;
    stepsCompleted: number;
    totalSteps: number;
    recordCounts: Record<string, number> | null;
    errorMessage: string | null;
    startedAt: number | null;
    completedAt: number | null;
    currentStepStartedAt: number | null;
    currentStepCompletedAt: number | null;
    lastHeartbeatAt: number | null;
    createdAt: number;
  } | null;
}

export async function loader({
  params,
  context,
}: Route.LoaderArgs): Promise<RunDetailLoaderData> {
  const user = context.get(userContext);
  if (!user.isSuperAdmin) {
    return { authorized: false, run: null };
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { exportRuns, users } = await import("../db/schema");

  const db = drizzle(context.cloudflare.env.DB);

  const row = await db
    .select({
      id: exportRuns.id,
      status: exportRuns.status,
      triggeredBy: users.email,
      selectedFonds: exportRuns.selectedFonds,
      selectedTypes: exportRuns.selectedTypes,
      workflowInstanceId: exportRuns.workflowInstanceId,
      currentStep: exportRuns.currentStep,
      stepsCompleted: exportRuns.stepsCompleted,
      totalSteps: exportRuns.totalSteps,
      recordCounts: exportRuns.recordCounts,
      errorMessage: exportRuns.errorMessage,
      startedAt: exportRuns.startedAt,
      completedAt: exportRuns.completedAt,
      currentStepStartedAt: exportRuns.currentStepStartedAt,
      currentStepCompletedAt: exportRuns.currentStepCompletedAt,
      lastHeartbeatAt: exportRuns.lastHeartbeatAt,
      createdAt: exportRuns.createdAt,
    })
    .from(exportRuns)
    .leftJoin(users, eq(exportRuns.triggeredBy, users.id))
    .where(eq(exportRuns.id, params.exportId))
    .get();

  if (!row) {
    return { authorized: true, run: null };
  }

  const parseJsonArray = (s: string): string[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  };
  const parseCounts = (s: string | null): Record<string, number> | null => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  return {
    authorized: true,
    run: {
      id: row.id,
      status: row.status,
      triggeredBy: row.triggeredBy,
      selectedFonds: parseJsonArray(row.selectedFonds),
      selectedTypes: parseJsonArray(row.selectedTypes),
      workflowInstanceId: row.workflowInstanceId,
      currentStep: row.currentStep,
      stepsCompleted: row.stepsCompleted,
      totalSteps: row.totalSteps,
      recordCounts: parseCounts(row.recordCounts),
      errorMessage: row.errorMessage,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      currentStepStartedAt: row.currentStepStartedAt,
      currentStepCompletedAt: row.currentStepCompletedAt,
      lastHeartbeatAt: row.lastHeartbeatAt,
      createdAt: row.createdAt,
    },
  };
}

const STATUS_STYLES: Record<string, string> = {
  complete: "bg-verdigris-tint text-verdigris-deep",
  error: "bg-madder-tint text-madder-deep",
  running: "bg-saffron-tint text-saffron-deep",
  pending: "bg-stone-100 text-stone-600",
};

function formatDuration(
  startedAt: number | null,
  completedAt: number | null
): string {
  if (!startedAt || !completedAt) return "\u2014";
  const seconds = Math.round((completedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[14rem_1fr]">
      <dt className="font-sans text-xs font-medium uppercase tracking-wide text-stone-500">
        {label}
      </dt>
      <dd className="font-sans text-sm text-stone-800 break-words">{children}</dd>
    </div>
  );
}

export default function PublishRunDetail({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("publish");
  const { authorized, run } = loaderData;

  if (!authorized) {
    return (
      <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3">
        <p className="font-sans text-sm text-saffron-deep">
          {t("superadminRequired")}
        </p>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="space-y-4">
        <Link
          to="/admin/publish"
          className="inline-flex items-center gap-1.5 font-sans text-sm text-indigo hover:underline"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          {t("detail.backToPublish")}
        </Link>
        <div className="rounded-lg border border-stone-200 bg-stone-50 px-4 py-3">
          <p className="font-sans text-sm text-stone-600">
            {t("detail.notFound")}
          </p>
        </div>
      </div>
    );
  }

  const allRecordCountsEntries = run.recordCounts
    ? Object.entries(run.recordCounts)
    : [];
  const childrenEntries = allRecordCountsEntries.filter(([step]) =>
    step.startsWith("children:") || step === "children"
  );
  const recordCountsEntries = allRecordCountsEntries.filter(
    ([step]) => !(step.startsWith("children:") || step === "children")
  );
  const childrenTotal = childrenEntries.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/admin/publish"
          className="inline-flex items-center gap-1.5 font-sans text-sm text-indigo hover:underline"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          {t("detail.backToPublish")}
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold text-stone-700">
          {t("detail.title")}
        </h1>
      </div>

      {/* Overview */}
      <section className="rounded-lg border border-stone-200 p-5">
        <h2 className="font-sans text-lg font-semibold text-stone-800">
          {t("detail.overview")}
        </h2>
        <dl className="mt-4 space-y-3">
          <Field label={t("detail.runId")}>
            <code className="font-mono text-xs">{run.id}</code>
          </Field>
          <Field label={t("detail.workflowInstanceId")}>
            {run.workflowInstanceId ? (
              <code className="font-mono text-xs">{run.workflowInstanceId}</code>
            ) : (
              "\u2014"
            )}
          </Field>
          <Field label={t("detail.status")}>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 font-sans text-xs font-medium ${
                STATUS_STYLES[run.status] ?? STATUS_STYLES.pending
              }`}
            >
              {t(`history.${run.status}` as const)}
            </span>
          </Field>
          <Field label={t("detail.triggeredBy")}>{run.triggeredBy ?? "\u2014"}</Field>
          <Field label={t("detail.selectedFonds")}>
            {run.selectedFonds.length > 0
              ? run.selectedFonds.join(", ")
              : "\u2014"}
          </Field>
          <Field label={t("detail.selectedTypes")}>
            {run.selectedTypes.length > 0
              ? run.selectedTypes.join(", ")
              : "\u2014"}
          </Field>
          <Field label={t("detail.stepsCompleted")}>
            {run.stepsCompleted} / {run.totalSteps}
          </Field>
        </dl>
      </section>

      {/* Timings */}
      <section className="rounded-lg border border-stone-200 p-5">
        <h2 className="font-sans text-lg font-semibold text-stone-800">
          {t("detail.timings")}
        </h2>
        <dl className="mt-4 space-y-3">
          <Field label={t("detail.createdAt")}>
            {formatIsoDateTime(run.createdAt)}
          </Field>
          <Field label={t("detail.startedAt")}>
            {formatIsoDateTime(run.startedAt)}
          </Field>
          <Field label={t("detail.completedAt")}>
            {formatIsoDateTime(run.completedAt)}
          </Field>
          <Field label={t("detail.duration")}>
            {formatDuration(run.startedAt, run.completedAt)}
          </Field>
          <Field label={t("detail.currentStep")}>{run.currentStep ?? "\u2014"}</Field>
          <Field label={t("detail.stepStartedAt")}>
            {formatIsoDateTime(run.currentStepStartedAt)}
          </Field>
          <Field label={t("detail.stepCompletedAt")}>
            {formatIsoDateTime(run.currentStepCompletedAt)}
          </Field>
          <Field label={t("detail.lastHeartbeatAt")}>
            {formatIsoDateTime(run.lastHeartbeatAt)}
          </Field>
        </dl>
      </section>

      {/* Error */}
      {run.errorMessage && (
        <section className="rounded-md border border-madder bg-madder-tint p-5">
          <h2 className="font-sans text-lg font-semibold text-madder-deep">
            {t("detail.errorTitle")}
          </h2>
          <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-madder-deep">
            {run.errorMessage}
          </pre>
        </section>
      )}

      {/* Per-step record counts */}
      <section className="rounded-lg border border-stone-200 p-5">
        <h2 className="font-sans text-lg font-semibold text-stone-800">
          {t("detail.recordCounts")}
        </h2>
        {recordCountsEntries.length === 0 ? (
          <p className="mt-3 font-sans text-sm text-stone-500">
            {t("detail.noRecordCounts")}
          </p>
        ) : (
          <div className="mt-4 overflow-hidden rounded border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    Step
                  </th>
                  <th className="px-4 py-2 text-right font-sans text-xs font-medium uppercase text-stone-500">
                    Count
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {recordCountsEntries.map(([step, count]) => (
                  <tr key={step}>
                    <td className="px-4 py-2 font-mono text-xs text-stone-700">
                      {step}
                    </td>
                    <td className="px-4 py-2 text-right font-sans text-sm text-stone-800">
                      {count.toLocaleString("en-US")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Children files */}
      {childrenEntries.length > 0 && (
        <section className="rounded-lg border border-stone-200 p-5">
          <h2 className="font-sans text-lg font-semibold text-stone-800">
            {t("detail.childrenFiles")}
          </h2>
          <p className="mt-1 font-sans text-xs text-stone-500">
            {t("detail.childrenFilesTotal", {
              count: childrenTotal,
              defaultValue: "",
            })}
          </p>
          <div className="mt-4 overflow-hidden rounded border border-stone-200">
            <table className="min-w-full divide-y divide-stone-200">
              <thead className="bg-stone-50">
                <tr>
                  <th className="px-4 py-2 text-left font-sans text-xs font-medium uppercase text-stone-500">
                    {t("detail.childrenFilesFonds")}
                  </th>
                  <th className="px-4 py-2 text-right font-sans text-xs font-medium uppercase text-stone-500">
                    {t("detail.childrenFilesCount")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {childrenEntries.map(([step, count]) => (
                  <tr key={step}>
                    <td className="px-4 py-2 font-mono text-xs text-stone-700">
                      {step.replace(/^children:/, "")}
                    </td>
                    <td className="px-4 py-2 text-right font-sans text-sm text-stone-800">
                      {count.toLocaleString("en-US")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Raw JSON */}
      <section className="rounded-lg border border-stone-200 p-5">
        <h2 className="font-sans text-lg font-semibold text-stone-800">
          {t("detail.rawJson")}
        </h2>
        <pre className="mt-3 overflow-x-auto rounded bg-stone-50 p-3 font-mono text-xs text-stone-700">
          {JSON.stringify(run, null, 2)}
        </pre>
      </section>
    </div>
  );
}
