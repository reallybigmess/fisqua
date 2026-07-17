/**
 * Imports Admin — the landing is step 1 of the pipeline
 *
 * This page is the entry point for the imports module at `/admin/imports`
 * (spec §1; readiness-check design §8a). It renders the SAME four-step rail
 * as the journey page — Upload current with the intake form as its pane;
 * Check / Dry run / Import locked — so the chain reads as one visual system
 * from first click to commit. A successful upload redirects straight into
 * the journey at the Check step.
 *
 * "Imports in progress" lists the staged uploads as resumable chains: the
 * whole row links into the journey, with a mini-rail and a state line
 * derived from the CACHED check columns (`cachedCheckSummary`) — the
 * landing loader never recomputes findings and never writes. "Finished"
 * lists committed uploads (linking to their run) and discarded ones, which
 * keep the read-only journey View and may be hard-deleted (design §8a
 * ruling) behind a two-step confirm.
 *
 * The action carries four intents. `upload` validates encoding FIRST — a
 * non-UTF-8 file is rejected by name, stages NOTHING, and writes NO row
 * (spec §4.1); only a decoded, parsed CSV reaches the staging store and
 * gets an `import_uploads` row, then redirects into the journey. `discard`
 * flips a staged upload to `discarded` (the journey's quiet link is the
 * primary surface; this stays as defence). `delete` hard-deletes a
 * DISCARDED upload — row, staged object, report artefact — refusing any
 * other status by name. `mintStarter` mints a starter profile.
 *
 * Profile management and the starter/template sections stay below the
 * pipeline — workshop tooling, not chain steps.
 *
 * @version v0.6.0
 */

import { useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { formatIsoDateTime } from "../lib/format-date";
import { StepRail, MiniRail, type RailStep, type RailStepState } from "../components/imports/step-rail";
import { isPendingIntent, BusySpinner } from "../components/imports/busy-submit";
import type { Route } from "./+types/_auth.admin.imports";

/** Where a staged chain stands, derived from the cached check columns. */
type ProgressStage = "needsProfile" | "checkPending" | "check" | "dryRunReady" | "importReady";

interface ProgressRow {
  id: string;
  filename: string;
  rowCount: number | null;
  byteSize: number;
  createdAt: number;
  stage: ProgressStage;
  decisionsMade: number;
  decisionsTotal: number;
}

interface FinishedRowData {
  id: string;
  filename: string;
  rowCount: number | null;
  updatedAt: number;
  status: "committed" | "discarded";
  runId: string | null;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { listUploads } = await import("~/lib/import/uploads.server");
  const { cachedCheckSummary } = await import("~/lib/import/check.server");
  const { listOwnProfiles, listSharedProfiles } = await import(
    "~/lib/import/profiles.server"
  );
  const { allowedTargetFields } = await import("~/lib/import/target-fields");
  const { startersForStandard } = await import("~/lib/import/starters");
  const { CANONICAL_STARTER_KEY } = await import(
    "~/lib/import/canonical-template"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const db = drizzle(context.cloudflare.env.DB);
  const [uploads, ownProfiles, sharedProfiles] = await Promise.all([
    listUploads(db, tenant.id),
    listOwnProfiles(db, tenant.id),
    listSharedProfiles(db, tenant),
  ]);

  // In-progress rows: state derived from the CACHED check columns only —
  // no findings recompute, no write, however many rows the tenant has. The
  // live profile versions come from the lists already loaded for the
  // profiles section: a row whose pinned profileVersion lags the live
  // profile is NOT dry-run/import ready — the journey relocks it on visit
  // (profile drift resets the check), so the landing must say the same
  // ("Check pending"). A pinned profile that resolves to no live profile
  // means the journey will ask for a profile again — needs-profile.
  const liveProfileVersions = new Map<string, number>(
    [...ownProfiles, ...sharedProfiles].map((p) => [p.id, p.version]),
  );
  const inProgress: ProgressRow[] = uploads
    .filter((u) => u.status === "staged")
    .map((u) => {
      const summary = cachedCheckSummary(u);
      const liveVersion = u.profileId ? liveProfileVersions.get(u.profileId) : undefined;
      const profileGone = summary.hasProfile && liveVersion === undefined;
      const profileDrifted =
        summary.hasProfile && liveVersion !== undefined && liveVersion !== u.profileVersion;
      const stage: ProgressStage =
        !summary.hasProfile || profileGone
          ? "needsProfile"
          : !summary.checked || profileDrifted
            ? "checkPending"
            : !summary.unlocked
              ? "check"
              : u.reportArtifact
                ? "importReady"
                : "dryRunReady";
      return {
        id: u.id,
        filename: u.filename,
        rowCount: u.rowCount,
        byteSize: u.byteSize,
        createdAt: u.createdAt,
        stage,
        decisionsMade: summary.decisionsMade,
        decisionsTotal: summary.decisionsTotal,
      };
    });

  const finished: FinishedRowData[] = uploads
    .filter((u) => u.status !== "staged")
    .map((u) => ({
      id: u.id,
      filename: u.filename,
      rowCount: u.rowCount,
      updatedAt: u.updatedAt,
      status: u.status as "committed" | "discarded",
      runId: u.runId,
    }));

  const standard = tenant.descriptiveStandard;
  const targetFields = standard ? allowedTargetFields(standard) : [];

  // Starter pick-cards for this tenant's standard (only starters valid for
  // it are offered), plus the always-offered generated canonical template.
  // Only the serialisable card fields cross the loader boundary — the
  // bindings stay server-side and are re-read at mint time.
  const starters = standard
    ? [
        ...startersForStandard(standard).map((s) => ({
          key: s.key,
          nameKey: s.nameKey,
          descriptionKey: s.descriptionKey,
        })),
        {
          key: CANONICAL_STARTER_KEY,
          nameKey: "starters.canonical.name",
          descriptionKey: "starters.canonical.desc",
        },
      ]
    : [];

  return { inProgress, finished, ownProfiles, sharedProfiles, targetFields, starters };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "discard") {
    const { discardUpload } = await import("~/lib/import/uploads.server");
    const uploadId = String(formData.get("uploadId") ?? "");
    const ok = await discardUpload(db, tenant.id, uploadId);
    return { ok, intent: "discard" as const };
  }

  if (intent === "delete") {
    // Hard-delete a DISCARDED upload (design §8a): objects first, then the
    // row; any other status refuses by name; an unknown or cross-tenant id
    // 404s like every other tenant-scoped miss.
    const { deleteDiscardedUpload } = await import("~/lib/import/uploads.server");
    const { getStagingStore } = await import("~/lib/import/staging.server");
    const uploadId = String(formData.get("uploadId") ?? "");
    const result = await deleteDiscardedUpload(
      db,
      getStagingStore(env),
      tenant.id,
      uploadId,
    );
    if (result === "not_found") throw new Response(null, { status: 404 });
    if (result === "not_discarded") {
      return { ok: false as const, intent: "delete" as const, error: "notDiscarded" };
    }
    return { ok: true as const, intent: "delete" as const };
  }

  if (intent === "mintStarter") {
    // Picking a starter mints a normal per-tenant profile from the code
    // definition, then hands off to the editor for review before first use
    // (mint → redirect to editor). A second mint of the same starter hits
    // the unique-name path; surface it so the admin renames and re-picks.
    if (tenant.descriptiveStandard == null) {
      throw new Error(
        "Schema invariant violation: tenant.descriptiveStandard is null on a tenant route",
      );
    }
    const { redirect } = await import("react-router");
    const { mintStarter } = await import("~/lib/import/starters.server");
    const starterKey = String(formData.get("starterKey") ?? "");
    const result = await mintStarter(db, {
      tenantId: tenant.id,
      standard: tenant.descriptiveStandard,
      userId: user.id,
      starterKey,
    });
    if (result.ok) {
      return redirect(`/admin/imports/profiles/${result.id}`);
    }
    return {
      ok: false as const,
      intent: "mintStarter" as const,
      error: result.error,
      // On duplicate_name: the conflicting profile's id, so the error can
      // link to it (a notice proposes the fix, never just names the problem).
      existingId: "existingId" in result ? result.existingId : undefined,
    };
  }

  if (intent === "upload") {
    const { decodeUtf8, parseCsv, CsvEncodingError, CsvParseError } =
      await import("~/lib/import/csv");
    const { getStagingStore, stagingKey } = await import(
      "~/lib/import/staging.server"
    );
    const { createUpload } = await import("~/lib/import/uploads.server");

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { ok: false as const, intent: "upload" as const, error: "noFile" };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    let text: string;
    try {
      text = decodeUtf8(bytes);
    } catch (e) {
      // Encoding-rejected: stage nothing, write no row (spec §4.1).
      if (e instanceof CsvEncodingError) {
        return { ok: false as const, intent: "upload" as const, error: "encoding" };
      }
      throw e;
    }

    let parsed;
    try {
      parsed = parseCsv(text);
    } catch (e) {
      // Structural rejects, each by name: no header row, an unterminated
      // quote, or duplicated header names (spec §4 — nothing ambiguous
      // reaches the staging store).
      if (e instanceof CsvParseError) {
        if (e.code === "unterminated_quote") {
          return {
            ok: false as const,
            intent: "upload" as const,
            error: "unterminatedQuote",
          };
        }
        if (e.code === "duplicate_headers") {
          return {
            ok: false as const,
            intent: "upload" as const,
            error: "duplicateHeaders",
            errorParams: { headers: (e.headers ?? []).join(", ") },
          };
        }
        return { ok: false as const, intent: "upload" as const, error: "empty" };
      }
      throw e;
    }

    // A header-only file has nothing to import — reject at intake
    // rather than staging a useless artefact.
    if (parsed.rowCount === 0) {
      return { ok: false as const, intent: "upload" as const, error: "empty" };
    }

    const uploadId = crypto.randomUUID();
    const store = getStagingStore(env);
    const artifactKey = stagingKey.upload(tenant.id, uploadId);
    try {
      await store.put(artifactKey, bytes, {
        contentType: "text/csv; charset=utf-8",
      });
    } catch {
      return { ok: false as const, intent: "upload" as const, error: "uploadFailed" };
    }

    try {
      await createUpload(db, {
        id: uploadId,
        tenantId: tenant.id,
        userId: user.id,
        filename: file.name || "upload.csv",
        artifactKey,
        byteSize: bytes.byteLength,
        rowCount: parsed.rowCount,
        headers: parsed.headers,
      });
    } catch {
      // The staged object must not outlive a failed metadata row —
      // best-effort cleanup, then surface the failure.
      try {
        await store.delete(artifactKey);
      } catch {
        /* cleanup is best-effort; the failure below is what matters */
      }
      return { ok: false as const, intent: "upload" as const, error: "uploadFailed" };
    }

    // The landing IS step 1 (design §8a): staging lands the operator
    // directly in the journey at the Check step.
    const { redirect } = await import("react-router");
    return redirect(`/admin/imports/uploads/${uploadId}?step=check`);
  }

  return { ok: false as const, intent: "unknown" as const };
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The mini-rail dot states for one in-progress row. */
function dotsFor(row: ProgressRow): RailStepState[] {
  const check: RailStepState =
    row.stage === "needsProfile" || row.stage === "checkPending" || row.stage === "check"
      ? "current"
      : "done";
  const dryRun: RailStepState =
    row.stage === "dryRunReady" ? "current" : row.stage === "importReady" ? "done" : "locked";
  const importStep: RailStepState = row.stage === "importReady" ? "current" : "locked";
  return ["done", check, dryRun, importStep];
}

/** A discarded row's Delete control: a two-step confirm, no JS dialogs. */
function DeleteControl({
  t,
  uploadId,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  uploadId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-madder-tint px-3 py-1 text-xs font-semibold text-madder-deep hover:bg-madder-wash"
      >
        {t("finished.delete")}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-madder-deep">{t("finished.deleteConfirm")}</span>
      <Form method="post" className="inline">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="uploadId" value={uploadId} />
        <button
          type="submit"
          className="rounded-md bg-madder px-3 py-1 text-xs font-semibold text-parchment hover:bg-madder-deep"
        >
          {t("finished.deleteConfirmAction")}
        </button>
      </Form>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-md border border-stone-200 px-3 py-1 text-xs font-semibold text-stone-600 hover:bg-stone-50"
      >
        {t("finished.deleteCancel")}
      </button>
    </span>
  );
}

export default function AdminImportsPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("imports");
  const actionData = useActionData<typeof action>();
  const { inProgress, finished, ownProfiles, sharedProfiles, starters } = loaderData;
  // Busy while the file upload is in flight — a large CSV takes a visible
  // moment between click and the redirect into the journey.
  const navigation = useNavigation();
  const uploading = isPendingIntent(navigation.state, navigation.formData, "upload");

  const mintFailure =
    actionData && actionData.intent === "mintStarter" && !actionData.ok
      ? (actionData as { error: string; existingId?: string })
      : undefined;

  const uploadFailure =
    actionData && actionData.intent === "upload" && !actionData.ok
      ? (actionData as { error: string; errorParams?: Record<string, string> })
      : undefined;

  const deleteFailure =
    actionData && actionData.intent === "delete" && !actionData.ok
      ? (actionData as { error: string })
      : undefined;

  const railSteps: RailStep[] = [
    {
      id: "upload",
      number: 1,
      state: "current",
      name: t("journey.step.upload"),
      sub: t("landing.rail.upload"),
      active: true,
    },
    { id: "check", number: 2, state: "locked", name: t("journey.step.check"), sub: t("landing.rail.check") },
    { id: "dryRun", number: 3, state: "locked", name: t("journey.step.dryRun"), sub: t("landing.rail.dryRun") },
    { id: "import", number: 4, state: "locked", name: t("journey.step.import"), sub: t("landing.rail.import") },
  ];

  const stateLine = (row: ProgressRow): string => {
    if (row.stage === "needsProfile") return t("landing.state.needsProfile");
    if (row.stage === "checkPending") return t("landing.state.checkPending");
    if (row.stage === "check")
      return t("landing.state.check", { made: row.decisionsMade, total: row.decisionsTotal });
    if (row.stage === "dryRunReady") return t("landing.state.dryRunReady");
    return t("landing.state.importReady");
  };

  return (
    <div className="mx-auto max-w-5xl px-8 py-12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-serif text-4xl font-semibold text-stone-700">
          {t("title")}
        </h1>
        <Link
          to="/admin/imports/runs"
          className="mt-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-indigo hover:bg-stone-50"
        >
          {t("runs.link")}
        </Link>
      </div>
      <p className="mt-3 max-w-2xl font-sans text-sm text-stone-500">
        {t("intro")}
      </p>

      {/* Step 1: the pipeline rail with the upload form as its pane. On
          narrow viewports the rail collapses above the pane. */}
      <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        <StepRail label={t("journey.stepsLabel")} steps={railSteps} />

        <div className="min-w-0">
          {uploadFailure && (
            <div role="alert" className="mb-4 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
              {t(`errors.${uploadFailure.error}`, uploadFailure.errorParams)}
            </div>
          )}
          <Form
            method="post"
            encType="multipart/form-data"
            className="rounded-lg border border-stone-200 bg-white p-6"
          >
            <input type="hidden" name="intent" value="upload" />
            <label
              htmlFor="file"
              className="mb-1 block text-xs font-medium text-indigo"
            >
              {t("upload.fileLabel")}
            </label>
            <input
              type="file"
              id="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="block w-full text-sm text-stone-700 file:mr-4 file:rounded-md file:border-0 file:bg-indigo file:px-4 file:py-2 file:text-sm file:font-semibold file:text-parchment hover:file:bg-indigo-deep"
            />
            <p className="mt-2 text-xs text-stone-400">
              {t("upload.help")} {t("upload.stagingNote")}
            </p>
            <div className="mt-4">
              <button
                type="submit"
                disabled={uploading}
                aria-busy={uploading || undefined}
                className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment ${
                  uploading ? "cursor-progress opacity-70" : "hover:bg-indigo-deep"
                }`}
              >
                {uploading && <BusySpinner />}
                {uploading ? t("busy.upload") : t("landing.uploadContinue")}
              </button>
            </div>
          </Form>
        </div>
      </div>

      {/* Imports in progress: resumable chains. */}
      <section className="mt-10">
        <h2 className="font-serif text-xl font-semibold text-stone-700">
          {t("landing.inProgressHeading")}
        </h2>
        {inProgress.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">{t("landing.inProgressEmpty")}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {inProgress.map((row) => (
              <li key={row.id}>
                <Link
                  to={`/admin/imports/uploads/${row.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-stone-200 bg-white px-4 py-3 hover:border-indigo-soft hover:shadow-sm"
                >
                  <span className="font-mono text-xs font-medium text-stone-700">
                    {row.filename}
                  </span>
                  <span className="text-xs text-stone-500">
                    {t("landing.rowMeta", {
                      rows: row.rowCount ?? 0,
                      size: formatBytes(row.byteSize),
                      staged: formatIsoDateTime(row.createdAt),
                    })}
                  </span>
                  <span className="ml-auto flex items-center gap-3">
                    <MiniRail states={dotsFor(row)} />
                    <span className="text-xs font-semibold text-saffron-deep">
                      {stateLine(row)}
                    </span>
                    <span className="rounded-md border border-stone-200 px-3 py-1 text-xs font-semibold text-indigo">
                      {t("landing.resume")}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Finished: imported rows link to their run; discarded keep View + Delete. */}
      {finished.length > 0 && (
        <section className="mt-10">
          <h2 className="font-serif text-xl font-semibold text-stone-700">
            {t("finished.heading")}
          </h2>
          {deleteFailure && (
            <div role="alert" className="mt-3 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
              {t(`finished.errors.${deleteFailure.error}`)}
            </div>
          )}
          <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs uppercase tracking-wider text-stone-500">
                  <th scope="col" className="px-4 py-2">{t("uploads.colFile")}</th>
                  <th scope="col" className="px-4 py-2">{t("uploads.colRows")}</th>
                  <th scope="col" className="px-4 py-2">{t("finished.colFinished")}</th>
                  <th scope="col" className="px-4 py-2">{t("finished.colOutcome")}</th>
                  <th scope="col" className="px-4 py-2">{t("uploads.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {finished.map((row) => (
                  <tr key={row.id} className="border-b border-stone-100">
                    <td className="px-4 py-2 font-mono text-xs text-stone-700">{row.filename}</td>
                    <td className="px-4 py-2 text-stone-600">{row.rowCount ?? "—"}</td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-600">
                      {formatIsoDateTime(row.updatedAt)}
                    </td>
                    <td className="px-4 py-2">
                      {row.status === "committed" ? (
                        <span className="rounded bg-verdigris-tint px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-verdigris-deep">
                          {t("finished.imported")}
                        </span>
                      ) : (
                        <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
                          {t("uploads.status.discarded")}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3">
                        {row.status === "committed" && row.runId ? (
                          <Link
                            to={`/admin/imports/runs/${row.runId}`}
                            className="text-xs font-semibold text-indigo hover:underline"
                          >
                            {t("finished.viewRun")}
                          </Link>
                        ) : (
                          <>
                            <Link
                              to={`/admin/imports/uploads/${row.id}`}
                              className="text-xs font-semibold text-indigo hover:underline"
                            >
                              {t("uploads.view")}
                            </Link>
                            {row.status === "discarded" && (
                              <DeleteControl t={t} uploadId={row.id} />
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-stone-400">{t("finished.deleteNote")}</p>
        </section>
      )}

      {/* Starter pick — "my data comes from…" */}
      <section className="mt-10">
        <h2 className="font-serif text-xl font-semibold text-stone-700">
          {t("starters.heading")}
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-stone-500">
          {t("starters.intro")}
        </p>

        {mintFailure && (
          <div role="alert" className="mt-4 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
            {mintFailure.error === "duplicate_name" ? (
              // The fix is a click away: the conflicting profile opens in
              // the editor for the rename the notice asks for.
              <Trans
                i18nKey="starters.errors.duplicate_name"
                ns="imports"
                components={{
                  profile: mintFailure.existingId ? (
                    <Link
                      to={`/admin/imports/profiles/${mintFailure.existingId}`}
                      className="font-semibold underline"
                    />
                  ) : (
                    <span />
                  ),
                }}
              />
            ) : (
              t(`starters.errors.${mintFailure.error}`)
            )}
          </div>
        )}

        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {starters.map((s) => (
            <li
              key={s.key}
              className="flex flex-col justify-between rounded-lg border border-stone-200 bg-white p-4"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-stone-700">
                    {t(s.nameKey)}
                  </span>
                  <span className="rounded bg-saffron-tint px-2 py-0.5 text-xs font-semibold text-saffron-deep">
                    {t("profiles.starterBadge")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-stone-500">
                  {t(s.descriptionKey)}
                </p>
              </div>
              <Form method="post" className="mt-3">
                <input type="hidden" name="intent" value="mintStarter" />
                <input type="hidden" name="starterKey" value={s.key} />
                <button
                  type="submit"
                  className="rounded-md border border-indigo px-3 py-1.5 text-xs font-semibold text-indigo hover:bg-indigo-tint"
                >
                  {t("starters.use")}
                </button>
              </Form>
            </li>
          ))}

          {/* Start from scratch — the existing create flow. */}
          <li className="flex flex-col justify-between rounded-lg border border-dashed border-stone-300 bg-white p-4">
            <div>
              <span className="font-semibold text-stone-700">
                {t("starters.fromScratch.name")}
              </span>
              <p className="mt-1 text-xs text-stone-500">
                {t("starters.fromScratch.desc")}
              </p>
            </div>
            <Link
              to="/admin/imports/profiles/new"
              className="mt-3 inline-block rounded-md border border-stone-200 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("starters.fromScratch.action")}
            </Link>
          </li>
        </ul>

        <p className="mt-4 text-sm text-stone-500">
          {t("starters.templateIntro")}{" "}
          <a
            href="/admin/imports/template"
            className="font-semibold text-indigo hover:underline"
          >
            {t("starters.templateDownload")}
          </a>
        </p>
      </section>

      {/* Profiles */}
      <section className="mt-10">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-xl font-semibold text-stone-700">
            {t("profiles.heading")}
          </h2>
          <Link
            to="/admin/imports/profiles/new"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("profiles.create")}
          </Link>
        </div>
        <p className="mt-2 max-w-2xl text-sm text-stone-500">
          {t("profiles.intro")}
        </p>

        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-stone-500">
          {t("profiles.ownHeading")}
        </h3>
        {ownProfiles.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">{t("profiles.empty")}</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {ownProfiles.map((p) => (
              <li
                key={p.id}
                className="rounded-lg border border-stone-200 bg-white p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-stone-700">{p.name}</span>
                  <span className="font-mono text-xs text-stone-400">
                    {t("profiles.version", { version: p.version })}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {p.starterKey && (
                    <span className="rounded bg-saffron-tint px-2 py-0.5 text-xs font-semibold text-saffron-deep">
                      {t("profiles.starterBadge")}
                    </span>
                  )}
                  <Link
                    to={`/admin/imports/profiles/${p.id}`}
                    className="text-xs font-semibold text-indigo hover:underline"
                  >
                    {t("profiles.edit")}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}

        {sharedProfiles.length > 0 && (
          <>
            <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-stone-500">
              {t("profiles.sharedHeading")}
            </h3>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {sharedProfiles.map((p) => (
                <li
                  key={p.id}
                  className="rounded-lg border border-stone-200 bg-white p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-stone-700">
                      {p.name}
                    </span>
                    <span className="font-mono text-xs text-stone-400">
                      {t("profiles.version", { version: p.version })}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="rounded bg-indigo-tint px-2 py-0.5 text-xs font-semibold text-indigo">
                      {t("profiles.sharedBadge")}
                    </span>
                    <Link
                      to={`/admin/imports/profiles/${p.id}`}
                      className="text-xs font-semibold text-indigo hover:underline"
                    >
                      {t("profiles.view")}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
