/**
 * Imports Admin — stewardship run detail + revert action
 *
 * This page reads one run (imports spec §5; stewardship record spec §§4-5):
 * the required message and optional justification, the author, the pinned
 * profile + version, the counts by kind, the Workflow progress/steps, an
 * error message if the run failed, download links to the run's artefacts,
 * the two-way revert linkage (this run's target and/or the revert that
 * reverted it), and — for a revertable run — the gated revert action.
 *
 * The revert action (spec §4) requires its OWN message; it mints a
 * kind='revert' run pointing at this one and stamps this run's
 * `reverted_by_run_id` ATOMICALLY (the double-submit mutex, mirroring the
 * commit mint), then launches the Cloudflare Workflow under a
 * target-derived deterministic instance id. It refuses a target that is
 * not complete, already reverted, or has no message. Reverting a revert is
 * allowed — it re-applies the original.
 *
 * The loader and action both gate on the admin role + the `imports`
 * capability and read the run tenant-scoped through `getRun` (a
 * first-class `tenant_id` filter), so a cross-tenant run id 404s.
 *
 * @version v0.6.0
 */

import { useEffect, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";
import { isPendingIntent, BusySpinner } from "../components/imports/busy-submit";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { formatIsoDateTime } from "../lib/format-date";
import type { Route } from "./+types/_auth.admin.imports.runs.$runId";

/** One recorded readiness-check acceptance, as snapshotted on the run. */
interface AcceptedFinding {
  classKeys?: string[];
  level?: string;
  fields?: string[];
  count?: number;
  cascadeCount?: number;
}

/** Import-shaped counts (created/updated/…); a subset of fields is present. */
interface ImportCounts {
  created: number;
  updated: number;
  unchanged?: number;
  skipped: number;
  rejected: number;
  /** Created rows whose computed pathCache exceeded the cap (cap-and-warn). */
  pathCacheCapped?: number;
}

/** Revert-shaped counts (spec §4). */
interface RevertCounts {
  deleted: number;
  restored: number;
  reinserted: number;
  skippedEdited: number;
  skippedForeignChildren: number;
  skippedConflict: number;
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { getRun } = await import("~/lib/import/runs.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const db = drizzle(context.cloudflare.env.DB);
  const run = await getRun(db, tenant.id, params.runId);
  if (!run) throw new Response(null, { status: 404 });

  let counts: Record<string, number> | null = null;
  if (run.recordCounts) {
    try {
      counts = JSON.parse(run.recordCounts);
    } catch {
      counts = null;
    }
  }

  // A run is revertable when it is a completed import or revert that has
  // not itself been reverted. (Reverting a revert re-applies the original.)
  const canRevert =
    (run.kind === "import" || run.kind === "revert") &&
    run.status === "complete" &&
    !run.revertedByRunId;

  return { run, counts, canRevert };
}

export async function action({ context, params, request }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { getRun } = await import("~/lib/import/runs.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  if (formData.get("intent") !== "revert") {
    return { ok: false as const, error: "revertFailed" };
  }

  // The target must be this tenant's completed, not-yet-reverted import or
  // revert. This read is the friendly path; the atomic mutex against a
  // double-submit race lives in `mintRevertRun`.
  const target = await getRun(db, tenant.id, params.runId);
  if (!target) throw new Response(null, { status: 404 });
  if (target.kind !== "import" && target.kind !== "revert") {
    return { ok: false as const, error: "notRevertable" };
  }
  if (target.status !== "complete") {
    return { ok: false as const, error: "notComplete" };
  }
  if (target.revertedByRunId) {
    return { ok: false as const, error: "alreadyReverted" };
  }

  const message = String(formData.get("message") ?? "").trim();
  if (message === "") {
    return { ok: false as const, error: "messageRequired" };
  }
  const justificationRaw = String(formData.get("justification") ?? "").trim();
  const justification = justificationRaw === "" ? null : justificationRaw;

  const { mintRevertRun } = await import("~/lib/import/revert.server");
  const minted = await mintRevertRun(db, {
    tenantId: tenant.id,
    userId: user.id,
    message,
    justification,
    targetRunId: target.id,
  });
  // Null = the atomic mutex fired: another revert claimed this target
  // between our read and the mint. Nothing was minted; do NOT launch a
  // Workflow.
  if (!minted) {
    return { ok: false as const, error: "alreadyReverted" };
  }
  const { runId: revertRunId } = minted;

  // Launch the Workflow after the mint has landed (the commit pattern). The
  // instance id derives from the TARGET (a target is reverted at most once,
  // so a duplicate create() collides at the Workflows layer too). A create
  // failure tombstones the revert run AND releases the target lock, since
  // nothing was applied yet.
  context.cloudflare.ctx.waitUntil(
    env.IMPORT_REVERT.create({ id: `revert-${target.id}`, params: { runId: revertRunId } })
      .then(() => undefined)
      .catch(async (err: unknown) => {
        const { drizzle } = await import("drizzle-orm/d1");
        const { failRun } = await import("~/lib/import/commit.server");
        const { releaseRevertLock } = await import("~/lib/import/revert.server");
        const d = drizzle(env.DB);
        const msg =
          err instanceof Error ? err.message : "failed to create import-revert workflow";
        await failRun(d, revertRunId, `workflow create failed: ${msg}`);
        await releaseRevertLock(d, target.id, revertRunId);
      }),
  );

  return redirect(`/admin/imports/runs/${revertRunId}`);
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-stone-200 px-4 py-3">
      <div className="font-mono text-2xl text-stone-700">{value}</div>
      <div className="text-xs uppercase tracking-wider text-stone-500">{label}</div>
    </div>
  );
}

export default function ImportRunDetailPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("imports");
  const { run, counts, canRevert } = loaderData;
  const actionData = useActionData<typeof action>();
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const reverting = isPendingIntent(navigation.state, navigation.formData, "revert");
  const [confirmed, setConfirmed] = useState(false);

  const inFlight = run.status === "pending" || run.status === "running";
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(id);
  }, [inFlight, revalidator]);

  const progressPct =
    run.totalSteps > 0 ? Math.min(100, Math.round((run.stepsCompleted / run.totalSteps) * 100)) : 0;

  const isRevert = run.kind === "revert";
  const acceptedFindings: AcceptedFinding[] = (() => {
    if (!run.acceptedFindings) return [];
    try {
      const value = JSON.parse(run.acceptedFindings);
      return Array.isArray(value) ? (value as AcceptedFinding[]) : [];
    } catch {
      return [];
    }
  })();
  const levelLabel = (level: string) => {
    const key = `check.levels.${level}`;
    const label = t(key);
    return label === key ? level : label;
  };
  const fieldsLabel = (fields: string[]) =>
    fields
      .map((f) => {
        const key = `check.fieldNames.${f}`;
        const label = t(key);
        return label === key ? f : label;
      })
      .join(", ");
  const revertError = actionData && !actionData.ok ? actionData.error : undefined;
  const importCounts = !isRevert ? (counts as ImportCounts | null) : null;
  const revertCounts = isRevert ? (counts as unknown as RevertCounts | null) : null;
  // In-flight revert heartbeats write the adapter-shaped counts (no
  // revert-native fields), so every read must default — otherwise the
  // auto-refreshing detail renders NaN until finalize lands the real shape.
  const revertedTotal = revertCounts
    ? (revertCounts.deleted ?? 0) + (revertCounts.restored ?? 0) + (revertCounts.reinserted ?? 0)
    : 0;
  const keptTotal = revertCounts
    ? (revertCounts.skippedEdited ?? 0) +
      (revertCounts.skippedForeignChildren ?? 0) +
      (revertCounts.skippedConflict ?? 0)
    : 0;

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      <nav aria-label={t("nav.breadcrumb")} className="mb-4 text-sm">
        <Link to="/admin/imports/runs" className="text-stone-500 hover:text-stone-700">
          {t("runDetail.back")}
        </Link>
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">{run.message}</h1>
        <span className="rounded bg-stone-100 px-2 py-0.5 font-mono text-xs text-stone-600">
          {t(`runs.status.${run.status}`)}
        </span>
        <span className="rounded bg-indigo-tint px-2 py-0.5 text-xs font-semibold text-indigo">
          {t(`runs.kind.${run.kind}`)}
        </span>
      </div>

      {run.justification && (
        <p className="mt-3 max-w-2xl text-sm text-stone-600">{run.justification}</p>
      )}

      {/* Two-way revert linkage (spec §2). */}
      {(run.revertsRun || run.revertedByRun) && (
        <div className="mt-4 space-y-1 text-sm">
          {run.revertsRun && (
            <p className="text-stone-600">
              {t("revert.revertsLabel")}{" "}
              <Link
                to={`/admin/imports/runs/${run.revertsRun.id}`}
                className="font-semibold text-indigo hover:underline"
              >
                {run.revertsRun.message}
              </Link>
            </p>
          )}
          {run.revertedByRun && (
            <p className="text-stone-600">
              {t("revert.revertedByLabel")}{" "}
              <Link
                to={`/admin/imports/runs/${run.revertedByRun.id}`}
                className="font-semibold text-indigo hover:underline"
              >
                {run.revertedByRun.message}
              </Link>
              {/* A non-complete revert stamped this target at mint (the
                  mutex), so without the status the target reads as fully
                  reverted while the revert may have failed partway. */}
              {run.revertedByRun.status !== "complete" && (
                <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-amber-700">
                  {t(`runs.status.${run.revertedByRun.status}`)}
                </span>
              )}
            </p>
          )}
        </div>
      )}

      <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        {!isRevert && (
          <div>
            <dt className="text-xs uppercase tracking-wider text-stone-400">{t("runDetail.profile")}</dt>
            <dd className="text-stone-700">
              {run.profileName ?? t("runDetail.profileDeleted")}
              {run.profileVersion != null && (
                <span className="ml-1 font-mono text-xs text-stone-400">
                  {t("profiles.version", { version: run.profileVersion })}
                </span>
              )}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase tracking-wider text-stone-400">{t("runDetail.created")}</dt>
          <dd className="font-mono text-xs text-stone-600">{formatIsoDateTime(run.createdAt)}</dd>
        </div>
      </dl>

      {inFlight && (
        <section className="mt-8" aria-live="polite">
          <div className="flex items-center justify-between text-sm text-stone-600">
            <span>{run.currentStep ? t("runDetail.step", { step: run.currentStep }) : t("runDetail.starting")}</span>
            <span className="font-mono text-xs">
              {run.stepsCompleted}/{run.totalSteps}
            </span>
          </div>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-stone-100"
            role="progressbar"
            aria-label={t("runDetail.progressLabel")}
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full bg-indigo transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </section>
      )}

      {run.status === "error" && run.errorMessage && (
        <div role="alert" className="mt-8 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
          {t("runDetail.errorHeading")}: {run.errorMessage}
        </div>
      )}

      {/* Import counts. */}
      {importCounts && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            {t("runDetail.countsHeading")}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat value={importCounts.created} label={t("report.creates")} />
            <Stat value={importCounts.updated} label={t("report.updates")} />
            <Stat value={importCounts.unchanged ?? 0} label={t("runs.unchanged")} />
            <Stat value={importCounts.skipped} label={t("report.skips")} />
            <Stat value={importCounts.rejected} label={t("report.rejects")} />
          </div>
          {/* The "warn" half of the pathCache cap-and-warn: shown only when
              a run actually capped something, never as a permanent zero. */}
          {(importCounts.pathCacheCapped ?? 0) > 0 && (
            <p className="mt-3 rounded-md border border-saffron bg-saffron-tint px-4 py-3 text-sm text-saffron-deep">
              {t("runDetail.pathCapped", { capped: importCounts.pathCacheCapped })}
            </p>
          )}
        </section>
      )}

      {/* Accepted incompleteness (design §3.5): which required-field gaps the
          operator knowingly imported, per class with counts. */}
      {!isRevert && acceptedFindings.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            {t("runDetail.acceptedHeading")}
          </h2>
          <p className="mt-1 text-sm text-stone-500">{t("runDetail.acceptedIntro")}</p>
          <ul className="mt-3 space-y-2">
            {acceptedFindings.map((a, i) => (
              <li
                key={(a.classKeys ?? []).join(",") || i}
                className="rounded-lg border border-sage-tint bg-sage-wash px-4 py-3 text-sm text-sage-deep"
              >
                {t("runDetail.acceptedItem", {
                  count: a.count ?? 0,
                  level: levelLabel(a.level ?? "item"),
                  fields: fieldsLabel(a.fields ?? []),
                })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Revert counts — the reverted/kept split, stated honestly (spec §4). */}
      {revertCounts && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
            {t("revert.countsHeading")}
          </h2>
          <p className="mt-1 text-sm text-stone-500">
            {t("revert.split", { reverted: revertedTotal, kept: keptTotal })}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat value={revertCounts.deleted ?? 0} label={t("revert.deleted")} />
            <Stat value={revertCounts.restored ?? 0} label={t("revert.restored")} />
            <Stat value={revertCounts.reinserted ?? 0} label={t("revert.reinserted")} />
            <Stat value={revertCounts.skippedEdited ?? 0} label={t("revert.skippedEdited")} />
            <Stat value={revertCounts.skippedForeignChildren ?? 0} label={t("revert.skippedForeignChildren")} />
            <Stat value={revertCounts.skippedConflict ?? 0} label={t("revert.skippedConflict")} />
          </div>
        </section>
      )}

      {/* Artefact downloads. Import runs link the upload's artefacts; a
          revert run streams its own run-scoped report. */}
      {!isRevert && run.uploadId && (
        <section className="mt-8 flex flex-wrap gap-3">
          <a
            href={`/admin/imports/uploads/${run.uploadId}/download/source`}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("runDetail.downloadSource")}
          </a>
          <a
            href={`/admin/imports/uploads/${run.uploadId}/download/report`}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("runDetail.downloadReport")}
          </a>
          <a
            href={`/admin/imports/uploads/${run.uploadId}/download/rejects`}
            className="rounded-md border border-verdigris bg-verdigris-tint px-4 py-2 text-sm font-semibold text-verdigris-deep hover:bg-verdigris-wash"
          >
            {t("runDetail.downloadRejects")}
          </a>
        </section>
      )}
      {isRevert && run.reportArtifact && (
        <section className="mt-8 flex flex-wrap gap-3">
          <a
            href={`/admin/imports/runs/${run.id}/report`}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("revert.downloadReport")}
          </a>
        </section>
      )}

      {/* Revert action (spec §4): its own required message + a confirm. */}
      {canRevert && (
        <section className="mt-10 rounded-lg border border-madder bg-madder-tint/40 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-madder-deep">
            {t("revert.heading")}
          </h2>
          <p className="mt-2 text-sm text-stone-600">
            {isRevert ? t("revert.helpRevertOfRevert") : t("revert.help")}
          </p>

          {revertError && (
            <div role="alert" className="mt-3 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
              {t(`revert.errors.${revertError}`)}
            </div>
          )}

          <Form method="post" className="mt-4 space-y-4">
            <input type="hidden" name="intent" value="revert" />
            <div>
              <label htmlFor="message" className="mb-1 block text-xs font-medium text-madder-deep">
                {t("revert.messageLabel")}
              </label>
              <input
                type="text"
                id="message"
                name="message"
                required
                maxLength={500}
                placeholder={t("revert.messagePlaceholder")}
                className="block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none"
              />
              <p className="mt-1 text-xs text-stone-400">{t("revert.messageHelp")}</p>
            </div>
            <div>
              <label htmlFor="justification" className="mb-1 block text-xs font-medium text-madder-deep">
                {t("revert.justificationLabel")}
              </label>
              <textarea
                id="justification"
                name="justification"
                rows={2}
                className="block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none"
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-stone-200 text-madder focus:ring-madder"
              />
              {t("revert.confirm")}
            </label>
            <button
              type="submit"
              disabled={!confirmed || reverting}
              aria-disabled={!confirmed || reverting}
              aria-busy={reverting || undefined}
              className={`rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment ${
                reverting
                  ? "cursor-progress opacity-70"
                  : confirmed
                    ? "hover:bg-madder-deep"
                    : "cursor-not-allowed opacity-40"
              }`}
            >
              {reverting && <BusySpinner />}
              {reverting ? t("busy.revert") : t("revert.submit")}
            </button>
            <p className="text-xs text-stone-400">{t("revert.note")}</p>
          </Form>
        </section>
      )}
    </div>
  );
}
