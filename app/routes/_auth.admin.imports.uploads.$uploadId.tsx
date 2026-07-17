/**
 * Imports Admin — the upload journey (Upload → Check → Dry run → Import)
 *
 * This page is the Option C two-pane journey (readiness-check design §2): a
 * fixed step chain on the left, the current step's work area on the right.
 * The four steps carry the ruled flow (imports spec §§3-5) plus the new
 * Check step: findings aggregated by problem class, decided once per class
 * before a dry run is allowed to run.
 *
 * Rail semantics: steps are done (verdigris) / current (saffron) / locked
 * (dashed grey), each locked step naming its unlock condition in its
 * sub-line. Discard is a quiet destructive link near the file summary, not a
 * step. On narrow viewports the rail collapses above the pane.
 *
 * The Check step (design §3): profile selection moves here if the upload has
 * none; findings are computed and cached on the upload row (pinned to the
 * profile version) via `check.server`; decision findings gate the dry run —
 * accepting a class imports those rows honestly sparse, and the acceptance
 * travels with the run's stewardship record. Blocking findings never gate;
 * informational findings never act.
 *
 * The action carries the journey's intents: `selectProfile` (Check),
 * `accept` / `undo` (decisions), `run` (dry run, refused while the gate is
 * locked, threading the recorded acceptances), `commit` (Import), and
 * `discard`. Commit re-derives verdicts inside the Workflow under the
 * acceptances read from the upload row — never from client input.
 *
 * @version v0.6.0
 */

import { useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { formatIsoDateTime } from "../lib/format-date";
import type { DryRunReport } from "../lib/import/dry-run.server";
import type { CheckState } from "../lib/import/check.server";
import type { Finding, DecisionFinding, BlockingFinding, InfoFinding } from "../lib/import/check";
import { StepRail, type RailStep, type RailStepState } from "../components/imports/step-rail";
import { withReturnTo } from "../lib/return-to";
import { commitBlockedReason } from "../lib/import/commit-blocked";
import { isPendingIntent, BusySpinner } from "../components/imports/busy-submit";
import type { Route } from "./+types/_auth.admin.imports.uploads.$uploadId";

type StepId = "upload" | "check" | "dryRun" | "import";
type StepState = RailStepState;

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { repositories } = await import("~/db/schema");
  const { getUpload } = await import("~/lib/import/uploads.server");
  const { listOwnProfiles, listSharedProfiles, getVisibleProfile } = await import(
    "~/lib/import/profiles.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const upload = await getUpload(db, tenant.id, params.uploadId);
  if (!upload) throw new Response(null, { status: 404 });

  const [ownProfiles, sharedProfiles, repoList] = await Promise.all([
    listOwnProfiles(db, tenant.id),
    listSharedProfiles(db, tenant),
    db
      .select({ id: repositories.id, name: repositories.name })
      .from(repositories)
      .where(and(eq(repositories.tenantId, tenant.id), eq(repositories.enabled, true)))
      .all(),
  ]);

  // Resolve the profile currently on the upload (if any). The Check step
  // computes findings against it; without one, the Check step asks for it.
  // Compute-and-cache runs for STAGED uploads only: a committed/discarded
  // upload is a record — its staged object may already be deleted (the
  // delete flow), and a read-only surface must not write — so its check
  // renders from the cached columns alone (`cachedCheckState`), or not at
  // all.
  let currentProfile: { id: string; name: string; version: number } | null = null;
  let check: CheckState | null = null;
  if (upload.profileId && tenant.descriptiveStandard) {
    const profile = await getVisibleProfile(db, tenant, upload.profileId);
    if (profile) {
      currentProfile = { id: profile.id, name: profile.name, version: profile.version };
      if (upload.status === "staged") {
        const { parseProfileBindings } = await import("~/lib/import/profile-schema");
        const parsed = parseProfileBindings(JSON.parse(profile.bindings));
        if (parsed.success) {
          const { getStagingStore } = await import("~/lib/import/staging.server");
          const { computeAndCacheFindings } = await import("~/lib/import/check.server");
          check = await computeAndCacheFindings({
            db,
            store: getStagingStore(env),
            tenantId: tenant.id,
            upload,
            standard: tenant.descriptiveStandard,
            profile: { id: profile.id, version: profile.version, bindings: parsed.data },
          });
        } else {
          currentProfile = null;
        }
      }
    }
  }
  if (upload.status !== "staged") {
    const { cachedCheckState } = await import("~/lib/import/check.server");
    check = cachedCheckState(upload);
  }

  // Read the dry-run report (the Dry run pane) and detect profile drift (the
  // commit gate, spec §5).
  let report: DryRunReport | null = null;
  let profileStale = false;
  if (upload.reportArtifact) {
    const { getStagingStore } = await import("~/lib/import/staging.server");
    const bytes = await getStagingStore(env).getBytes(upload.reportArtifact);
    if (bytes) {
      try {
        report = JSON.parse(new TextDecoder().decode(bytes)) as DryRunReport;
      } catch {
        report = null;
      }
    }
    if (report && upload.profileId) {
      const current = await getVisibleProfile(db, tenant, upload.profileId);
      profileStale = !current || current.version !== report.profileVersion;
    }
  }

  const committed = upload.status === "committed";
  const hasProfile = currentProfile !== null;
  const checkUnlocked = check ? check.unlocked : false;
  // A report only counts as a live dry run while the gate is open and the
  // profile has not drifted — undoing a decision after a dry run re-locks the
  // journey and hides the now-stale report.
  const reportLive = report !== null && !profileStale && checkUnlocked;

  const stepState = (id: StepId): StepState => {
    if (id === "upload") return "done";
    if (id === "check") {
      if (committed) return "done";
      if (!hasProfile || !checkUnlocked) return "current";
      return "done";
    }
    if (id === "dryRun") {
      if (committed) return "done";
      if (!hasProfile || !checkUnlocked) return "locked";
      return reportLive ? "done" : "current";
    }
    // import
    if (committed) return "done";
    if (!reportLive) return "locked";
    return "current";
  };
  const steps: Record<StepId, StepState> = {
    upload: stepState("upload"),
    check: stepState("check"),
    dryRun: stepState("dryRun"),
    import: stepState("import"),
  };

  const viewable = (id: StepId): boolean => {
    if (id === "upload" || id === "check") return true;
    if (id === "dryRun") return committed || (hasProfile && checkUnlocked);
    return committed || reportLive; // import
  };

  const defaultStep: StepId = committed
    ? "import"
    : !hasProfile || !checkUnlocked
      ? "check"
      : !reportLive
        ? "dryRun"
        : "import";

  const requested = new URL(request.url).searchParams.get("step") as StepId | null;
  const activeStep: StepId =
    requested && ["upload", "check", "dryRun", "import"].includes(requested) && viewable(requested)
      ? requested
      : defaultStep;

  return {
    upload: {
      id: upload.id,
      filename: upload.filename,
      rowCount: upload.rowCount,
      byteSize: upload.byteSize,
      status: upload.status,
      profileId: upload.profileId,
      runId: upload.runId,
      headerCount: upload.headers ? (JSON.parse(upload.headers) as string[]).length : 0,
      createdAt: upload.createdAt,
    },
    profiles: [
      ...ownProfiles.map((p) => ({ id: p.id, name: p.name, version: p.version, shared: false })),
      ...sharedProfiles.map((p) => ({ id: p.id, name: p.name, version: p.version, shared: true })),
    ],
    repositories: repoList,
    currentProfile,
    check,
    report,
    profileStale,
    steps,
    activeStep,
    reportLive,
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

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent");

  const { getUpload } = await import("~/lib/import/uploads.server");
  const upload = await getUpload(db, tenant.id, params.uploadId);
  if (!upload) throw new Response(null, { status: 404 });

  if (intent === "discard") {
    const { discardUpload } = await import("~/lib/import/uploads.server");
    await discardUpload(db, tenant.id, upload.id);
    return redirect("/admin/imports");
  }

  if (intent === "commit") {
    return commitImport({ context, db, env, tenant, user, upload, formData });
  }

  // Everything below acts on the Check/Dry-run steps and needs a staged
  // upload plus a resolvable profile. The refusal names the POSTED intent so
  // the error surfaces in the right channel; the check pane renders
  // read-only on non-staged uploads, so this is defence, not the primary
  // guard.
  if (upload.status !== "staged") {
    const guardIntent =
      intent === "selectProfile" || intent === "accept" || intent === "undo"
        ? intent
        : ("run" as const);
    return { ok: false as const, intent: guardIntent, error: "notStaged" as const };
  }

  if (intent === "selectProfile") {
    const profileId = String(formData.get("profileId") ?? "");
    if (profileId === "") return { ok: false as const, intent: "selectProfile" as const, error: "noProfile" };
    const { getVisibleProfile } = await import("~/lib/import/profiles.server");
    const profile = await getVisibleProfile(db, tenant, profileId);
    if (!profile) return { ok: false as const, intent: "selectProfile" as const, error: "noProfile" };
    const { parseProfileBindings } = await import("~/lib/import/profile-schema");
    if (!parseProfileBindings(JSON.parse(profile.bindings)).success) {
      return { ok: false as const, intent: "selectProfile" as const, error: "invalidProfile" };
    }
    const { setUploadProfile } = await import("~/lib/import/uploads.server");
    await setUploadProfile(db, tenant.id, upload.id, {
      profileId: profile.id,
      profileVersion: profile.version,
    });
    return redirect(`/admin/imports/uploads/${upload.id}?step=check`);
  }

  // The remaining intents (accept/undo/run) all need the current profile +
  // freshly computed findings, so acceptance is recorded against server-side
  // data, never client-posted counts.
  if (!upload.profileId) {
    return { ok: false as const, intent: "run" as const, error: "noProfile" };
  }
  const { getVisibleProfile } = await import("~/lib/import/profiles.server");
  const profile = await getVisibleProfile(db, tenant, upload.profileId);
  if (!profile) return { ok: false as const, intent: "run" as const, error: "noProfile" };
  const { parseProfileBindings } = await import("~/lib/import/profile-schema");
  const parsedBindings = parseProfileBindings(JSON.parse(profile.bindings));
  if (!parsedBindings.success) {
    return { ok: false as const, intent: "run" as const, error: "invalidProfile" };
  }

  const { getStagingStore } = await import("~/lib/import/staging.server");
  const store = getStagingStore(env);
  const {
    computeAndCacheFindings,
    acceptDecision,
    undoDecision,
    deriveAcceptedClasses,
    parseDecisions,
  } = await import("~/lib/import/check.server");

  const profileArg = { id: profile.id, version: profile.version, bindings: parsedBindings.data };
  const state = await computeAndCacheFindings({
    db,
    store,
    tenantId: tenant.id,
    upload,
    standard: tenant.descriptiveStandard,
    profile: profileArg,
  });

  if (intent === "accept" || intent === "undo") {
    const findingKey = String(formData.get("findingKey") ?? "");
    const decision = state.findings.find(
      (f): f is DecisionFinding => f.kind === "decision" && f.key === findingKey,
    );
    if (!decision) {
      return { ok: false as const, intent: intent as "accept" | "undo", error: "unknownFinding" };
    }
    // Re-read the upload so the decisions column reflects any write above.
    const fresh = (await getUpload(db, tenant.id, upload.id))!;
    if (intent === "accept") {
      await acceptDecision(
        db,
        tenant.id,
        fresh,
        {
          key: decision.key,
          classKeys: decision.classKeys,
          level: decision.level,
          fields: decision.fields,
          count: decision.count,
          cascadeCount: decision.cascadeCount,
        },
        user.id,
      );
    } else {
      await undoDecision(db, tenant.id, fresh, decision.key);
    }
    return redirect(`/admin/imports/uploads/${upload.id}?step=check`);
  }

  if (intent === "run") {
    // Gate (design §3.4): the dry run is refused while any decision is
    // pending. Blocking findings do not gate — the rows simply reject.
    if (!state.unlocked) {
      return { ok: false as const, intent: "run" as const, error: "locked" };
    }
    const fresh = (await getUpload(db, tenant.id, upload.id))!;
    const acceptedClasses = deriveAcceptedClasses(parseDecisions(fresh.checkDecisions));
    const { runDryRun } = await import("~/lib/import/dry-run.server");
    const updateExisting = formData.get("updateExisting") === "on";
    try {
      await runDryRun({
        db,
        store,
        tenantId: tenant.id,
        upload: fresh,
        profile: profileArg,
        standard: tenant.descriptiveStandard,
        updateExisting,
        acceptedClasses,
      });
    } catch {
      return { ok: false as const, intent: "run" as const, error: "runFailed" };
    }
    return redirect(`/admin/imports/uploads/${upload.id}?step=dryRun`);
  }

  return { ok: false as const, intent: "unknown" as const };
}

/**
 * The commit act (spec §5; stewardship spec §2). Gated twice, as the mockup
 * rules: a dry-run report must exist AND its profile must still be at the
 * version the report was generated against. The acceptances travel with the
 * run — `mintImportRun` copies the upload's `check_decisions` into the run's
 * `accepted_findings` atomically, so the commit re-derives verdicts under the
 * recorded acceptances, never from client input.
 */
async function commitImport(args: {
  context: Route.ActionArgs["context"];
  db: import("drizzle-orm/d1").DrizzleD1Database<any>;
  env: Env;
  tenant: import("../context").Tenant;
  user: import("../context").User;
  upload: import("~/lib/import/uploads.server").UploadRow;
  formData: FormData;
}) {
  const { context, db, env, tenant, user, upload, formData } = args;

  if (upload.status === "committed") {
    return { ok: false as const, intent: "commit" as const, error: "alreadyCommitted" };
  }
  if (upload.status !== "staged") {
    return { ok: false as const, intent: "commit" as const, error: "notStaged" };
  }
  if (!upload.reportArtifact || !upload.profileId || upload.profileVersion == null) {
    return { ok: false as const, intent: "commit" as const, error: "noReport" };
  }

  const message = String(formData.get("message") ?? "").trim();
  if (message === "") {
    return { ok: false as const, intent: "commit" as const, error: "messageRequired" };
  }
  const justificationRaw = String(formData.get("justification") ?? "").trim();
  const justification = justificationRaw === "" ? null : justificationRaw;

  const repositoryId = String(formData.get("repositoryId") ?? "");
  if (repositoryId === "") {
    return { ok: false as const, intent: "commit" as const, error: "noRepository" };
  }
  const { and, eq } = await import("drizzle-orm");
  const { repositories } = await import("~/db/schema");
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(
      and(
        eq(repositories.id, repositoryId),
        eq(repositories.tenantId, tenant.id),
        eq(repositories.enabled, true),
      ),
    )
    .get();
  if (!repo) {
    return { ok: false as const, intent: "commit" as const, error: "noRepository" };
  }

  const { getVisibleProfile } = await import("~/lib/import/profiles.server");
  const profile = await getVisibleProfile(db, tenant, upload.profileId);
  if (!profile || profile.version !== upload.profileVersion) {
    return { ok: false as const, intent: "commit" as const, error: "profileStale" };
  }

  const { getStagingStore } = await import("~/lib/import/staging.server");
  const store = getStagingStore(env);
  let updateExisting = false;
  let reportAcceptedClasses: string[] = [];
  const reportBytes = await store.getBytes(upload.reportArtifact);
  if (reportBytes) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(reportBytes)) as DryRunReport;
      updateExisting = parsed.updateExisting === true;
      reportAcceptedClasses = [...(parsed.acceptedClasses ?? [])].sort();
    } catch {
      return { ok: false as const, intent: "commit" as const, error: "noReport" };
    }
  } else {
    return { ok: false as const, intent: "commit" as const, error: "noReport" };
  }

  // The gate must hold AT COMMIT TIME, not merely when the report was
  // generated: a raw POST sequenced accept → dry-run → undo must be refused.
  // Two conditions: every decision must be resolved (pending decisions lock
  // the commit outright), and the CURRENT accepted classes must equal the
  // set the reviewed report was generated under — an undo or a fresh accept
  // since the run invalidates the reviewed counts, so a fresh dry-run is
  // required before any commit.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null on a tenant route",
    );
  }
  const { parseProfileBindings } = await import("~/lib/import/profile-schema");
  const parsedBindings = parseProfileBindings(JSON.parse(profile.bindings));
  if (!parsedBindings.success) {
    return { ok: false as const, intent: "commit" as const, error: "profileStale" };
  }
  const { computeAndCacheFindings, deriveAcceptedClasses, parseDecisions } = await import(
    "~/lib/import/check.server"
  );
  const gate = await computeAndCacheFindings({
    db,
    store,
    tenantId: tenant.id,
    upload,
    standard: tenant.descriptiveStandard,
    profile: { id: profile.id, version: profile.version, bindings: parsedBindings.data },
  });
  if (!gate.unlocked) {
    return { ok: false as const, intent: "commit" as const, error: "decisionsPending" };
  }
  const currentAcceptedClasses = [
    ...deriveAcceptedClasses(parseDecisions(upload.checkDecisions)),
  ].sort();
  if (JSON.stringify(currentAcceptedClasses) !== JSON.stringify(reportAcceptedClasses)) {
    return { ok: false as const, intent: "commit" as const, error: "decisionsChanged" };
  }

  const { mintImportRun } = await import("~/lib/import/commit.server");
  const minted = await mintImportRun(db, {
    tenantId: tenant.id,
    userId: user.id,
    message,
    justification,
    profileId: upload.profileId,
    profileVersion: upload.profileVersion,
    sourceArtifact: upload.artifactKey,
    reportArtifact: upload.reportArtifact,
    uploadId: upload.id,
  });
  if (!minted) {
    return { ok: false as const, intent: "commit" as const, error: "alreadyCommitted" };
  }
  const { runId } = minted;

  const commitParams = { runId, uploadId: upload.id, repositoryId, updateExisting };
  context.cloudflare.ctx.waitUntil(
    env.IMPORT_COMMIT.create({ id: `import-${upload.id}`, params: commitParams })
      .then(() => undefined)
      .catch(async (err: unknown) => {
        const { drizzle } = await import("drizzle-orm/d1");
        const { failRun } = await import("~/lib/import/commit.server");
        const msg =
          err instanceof Error ? err.message : "failed to create import-commit workflow";
        await failRun(drizzle(env.DB), runId, `workflow create failed: ${msg}`);
      }),
  );

  return redirect(`/admin/imports/runs/${runId}`);
}

// ── Presentation helpers ────────────────────────────────────────────────

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render one reject reason with its detail named (design §5). */
function reasonText(
  t: ReturnType<typeof useTranslation>["t"],
  reason: string,
  detail?: Record<string, unknown>,
): string {
  if (reason === "missing_required_field") {
    const fields =
      (detail?.requiredMissing as string[]) ?? (detail?.fields as string[]) ?? [];
    if (fields.length > 0) {
      return t("report.reasonDetail.missing_required_field", { fields: fields.join(", ") });
    }
  }
  if (reason === "parent_rejected") {
    const parent = detail?.parentReferenceCode as string | undefined;
    if (parent) return t("report.reasonDetail.parent_rejected", { parent });
  }
  if (reason === "duplicate_reference_code") {
    const rows = (detail?.rows as number[]) ?? [];
    if (rows.length > 0) {
      return t("report.reasonDetail.duplicate_reference_code", { rows: rows.join(", ") });
    }
  }
  return t(`report.reason.${reason}`);
}

function fieldLabel(t: ReturnType<typeof useTranslation>["t"], field: string): string {
  const key = `check.fieldNames.${field}`;
  const label = t(key);
  return label === key ? field : label;
}

function levelLabel(t: ReturnType<typeof useTranslation>["t"], level: string): string {
  const key = `check.levels.${level}`;
  const label = t(key);
  return label === key ? level : label;
}

// ── Component ────────────────────────────────────────────────────────────

export default function ImportJourneyPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("imports");
  const actionData = useActionData<typeof action>();
  const {
    upload,
    profiles,
    repositories,
    currentProfile,
    check,
    report,
    profileStale,
    steps,
    activeStep,
    reportLive,
  } = loaderData;

  const stepNumber: Record<StepId, number> = { upload: 1, check: 2, dryRun: 3, import: 4 };
  const err = (i: string) =>
    actionData && !actionData.ok && (actionData as { intent?: string }).intent === i
      ? (actionData as { error: string }).error
      : undefined;

  const railSub = (id: StepId): string => {
    if (id === "upload") return t("journey.sub.uploadDone", { rows: upload.rowCount ?? 0 });
    if (id === "check") {
      if (!currentProfile) return t("journey.sub.checkNeedsProfile");
      if (check && !check.unlocked) {
        const blocking = check.findings.filter((f) => f.kind === "blocking").length;
        return blocking > 0
          ? `${t("journey.sub.checkPendingDecisions", { count: check.pending.length })} · ${t("journey.sub.checkBlockingCount", { count: blocking })}`
          : t("journey.sub.checkPending", { pending: check.pending.length });
      }
      return check && check.decisionsTotal > 0 ? t("journey.sub.checkReady") : t("journey.sub.checkClean");
    }
    if (id === "dryRun") {
      if (steps.dryRun === "locked") return t("journey.sub.dryRunLocked");
      if (reportLive && report)
        return t("journey.sub.dryRunDone", {
          creates: report.counts.creates,
          rejects: report.counts.rejects,
        });
      return t("journey.sub.dryRunReady");
    }
    if (steps.import === "locked") return t("journey.sub.importLocked");
    if (upload.status === "committed") return t("journey.sub.importDone");
    return t("journey.sub.importReady");
  };

  const stepViewable = (id: StepId): boolean => {
    if (id === "upload" || id === "check") return true;
    if (id === "dryRun") return steps.dryRun !== "locked";
    return steps.import !== "locked";
  };

  const railItems: StepId[] = ["upload", "check", "dryRun", "import"];

  return (
    <div className="mx-auto max-w-5xl px-8 py-12">
      <nav aria-label={t("nav.breadcrumb")} className="mb-4 text-sm">
        <Link to="/admin/imports" className="text-stone-500 hover:text-stone-700">
          {t("nav.back")}
        </Link>
      </nav>

      <h1 className="font-serif text-2xl font-semibold text-stone-700">{t("report.heading")}</h1>
      <p className="mt-2 text-sm text-stone-500">
        <span className="font-mono text-xs text-stone-500">{upload.filename}</span>
        <span className="mx-2 text-stone-300">·</span>
        <span className="font-mono text-xs">
          {t("journey.fileMeta", {
            rows: upload.rowCount ?? 0,
            size: formatBytes(upload.byteSize),
          })}
        </span>
        {currentProfile && (
          <>
            <span className="mx-2 text-stone-300">·</span>
            {t("journey.profileTag", { profile: currentProfile.name })}
          </>
        )}
        {upload.status === "staged" && (
          <>
            <span className="mx-2 text-stone-300">·</span>
            <Form method="post" className="inline">
              <input type="hidden" name="intent" value="discard" />
              <button
                type="submit"
                className="text-xs font-semibold text-madder-deep hover:underline"
              >
                {t("journey.discard")}
              </button>
            </Form>
          </>
        )}
      </p>

      <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        {/* Step chain (rail). On narrow viewports it collapses above the pane. */}
        <StepRail
          label={t("journey.stepsLabel")}
          steps={railItems.map(
            (id): RailStep => ({
              id,
              number: stepNumber[id],
              state: steps[id],
              name: t(`journey.step.${id}`),
              sub: railSub(id),
              ...(stepViewable(id)
                ? { href: `/admin/imports/uploads/${upload.id}?step=${id}` }
                : {}),
              active: activeStep === id,
            }),
          )}
        />

        {/* Work pane. */}
        <div className="min-w-0">
          {activeStep === "upload" && (
            <UploadPane t={t} upload={upload} />
          )}
          {activeStep === "check" && (
            <CheckPane
              t={t}
              upload={upload}
              profiles={profiles}
              currentProfile={currentProfile}
              check={check}
              readOnly={upload.status !== "staged"}
              selectError={err("selectProfile")}
              runError={err("run")}
              acceptError={err("accept") ?? err("undo")}
            />
          )}
          {activeStep === "dryRun" && (
            <DryRunPane
              t={t}
              upload={upload}
              report={report}
              reportLive={reportLive}
              runError={err("run")}
            />
          )}
          {activeStep === "import" && (
            <ImportPane
              t={t}
              upload={upload}
              report={report}
              repositories={repositories}
              profileStale={profileStale}
              commitError={err("commit")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function UploadPane({
  t,
  upload,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  upload: Route.ComponentProps["loaderData"]["upload"];
}) {
  return (
    <section aria-labelledby="upload-h">
      <h2 id="upload-h" className="text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("journey.step.upload")}
      </h2>
      <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wider text-stone-400">{t("uploads.colRows")}</dt>
          <dd className="font-mono text-stone-700">{upload.rowCount ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-stone-400">{t("journey.columns")}</dt>
          <dd className="font-mono text-stone-700">{upload.headerCount}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-stone-400">{t("uploads.colSize")}</dt>
          <dd className="font-mono text-stone-700">{formatBytes(upload.byteSize)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wider text-stone-400">{t("uploads.colStaged")}</dt>
          <dd className="font-mono text-xs text-stone-600">{formatIsoDateTime(upload.createdAt)}</dd>
        </div>
      </dl>
      <p className="mt-6">
        <Link
          to={`/admin/imports/uploads/${upload.id}?step=check`}
          className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          {t("journey.continue")}
        </Link>
      </p>
    </section>
  );
}

function CheckPane({
  t,
  upload,
  profiles,
  currentProfile,
  check,
  readOnly,
  selectError,
  runError,
  acceptError,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  upload: Route.ComponentProps["loaderData"]["upload"];
  profiles: Route.ComponentProps["loaderData"]["profiles"];
  currentProfile: Route.ComponentProps["loaderData"]["currentProfile"];
  check: CheckState | null;
  /** A committed/discarded upload's check is a record, never a form. */
  readOnly: boolean;
  selectError?: string;
  runError?: string;
  acceptError?: string;
}) {
  // A closed upload renders its check from the cached findings only; with
  // no pinned cache there is nothing to show — a plain note, never a form
  // and never a recompute (the staged object may already be deleted).
  if (readOnly && !check) {
    return (
      <section aria-labelledby="check-h">
        <h2 id="check-h" className="text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("check.heading")}
        </h2>
        <p className="mt-2 text-sm text-stone-500">{t("check.noRecord")}</p>
      </section>
    );
  }
  // Profile selection moves here when the upload has none (design §3.1).
  // Reachable only for STAGED uploads: the read-only no-cache case returned
  // above, and a read-only row with a cache renders the findings below even
  // when its profile cannot be resolved (a deleted or unshared profile).
  if (!readOnly && (!currentProfile || !check)) {
    return (
      <section aria-labelledby="check-h">
        <h2 id="check-h" className="text-sm font-semibold uppercase tracking-wider text-stone-500">
          {t("check.chooseProfileHeading")}
        </h2>
        <p className="mt-2 text-sm text-stone-500">{t("check.chooseProfileHelp")}</p>
        {selectError && (
          <div role="alert" className="mt-4 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
            {t(`report.errors.${selectError}`)}
          </div>
        )}
        {profiles.length === 0 ? (
          // Flag-problems-propose-solutions: the notice teaches what a
          // mapping profile IS, then links to the create surface with a
          // returnTo back to this step.
          <div className="mt-4">
            <p className="max-w-prose text-sm text-stone-500">{t("check.noProfiles")}</p>
            <p className="mt-3">
              <Link
                to={withReturnTo(
                  "/admin/imports/profiles/new",
                  `/admin/imports/uploads/${upload.id}?step=check`,
                )}
                className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
              >
                {t("profiles.create")}
              </Link>
            </p>
          </div>
        ) : (
          <Form method="post" className="mt-4 flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="selectProfile" />
            <div>
              <label htmlFor="profileId" className="mb-1 block text-xs font-medium text-indigo">
                {t("report.profileLabel")}
              </label>
              <select
                id="profileId"
                name="profileId"
                defaultValue={currentProfile?.id ?? ""}
                className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none"
              >
                <option value="">{t("report.chooseProfile")}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {t("profiles.version", { version: p.version })}
                    {p.shared ? ` (${t("profiles.sharedBadge")})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("check.useProfile")}
            </button>
          </Form>
        )}
      </section>
    );
  }

  // Every remaining path carries a check: the read-only branch above covers
  // readOnly-without-cache, the selection branch covers staged-without-check.
  if (!check) return null;

  const decisions = check.findings.filter((f): f is DecisionFinding => f.kind === "decision");
  const blocking = check.findings.filter((f): f is BlockingFinding => f.kind === "blocking");
  const info = check.findings.filter((f): f is InfoFinding => f.kind === "informational");
  const acceptedKeys = new Set(check.decisions.map((d) => d.key));

  return (
    <section aria-labelledby="check-h">
      <h2 id="check-h" className="text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("check.heading")}
      </h2>

      {(runError || acceptError) && (
        <div role="alert" className="mt-3 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
          {t(`check.errors.${runError ?? acceptError}`)}
        </div>
      )}

      {readOnly && <p className="mt-2 text-sm text-stone-500">{t("check.readOnly")}</p>}

      {/* Decisions ledger. */}
      <div
        role="status"
        aria-live="polite"
        className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-indigo-wash px-4 py-3 text-sm text-indigo"
      >
        <span>{t("check.ledger")}</span>
        <span className="font-mono text-xs">
          {t("check.ledgerCount", { made: check.decisionsMade, total: check.decisionsTotal })}
        </span>
      </div>

      {check.findings.length === 0 && (
        <p className="mt-4 rounded-md border border-sage bg-sage-wash px-4 py-3 text-sm text-sage-deep">
          {t("check.noFindings")}
        </p>
      )}

      <div className="mt-4 space-y-3">
        {decisions.map((f) => (
          <DecisionCard
            key={f.key}
            t={t}
            finding={f}
            accepted={acceptedKeys.has(f.key)}
            readOnly={readOnly}
          />
        ))}
        {blocking.map((f) => (
          <BlockingCard key={f.key} t={t} finding={f} />
        ))}
        {info.map((f) => (
          <InfoCard key={f.key} t={t} finding={f} />
        ))}
      </div>

      {/* Dry-run gate bar. */}
      <div
        role="status"
        aria-live="polite"
        className={`mt-6 flex flex-wrap items-center gap-4 rounded-lg px-4 py-3 text-sm ${
          check.unlocked
            ? "border border-verdigris-tint bg-verdigris-wash text-verdigris-deep"
            : "border border-dashed border-stone-300 bg-stone-50 text-stone-500"
        }`}
      >
        <span className="flex-1">
          {check.unlocked
            ? check.decisionsTotal === 0
              ? t("check.gate.trivial")
              : t("check.gate.unlocked")
            : check.pending.length === 1
              ? t("check.gate.lockedOne")
              : t("check.gate.lockedMany", { count: check.pending.length })}
        </span>
        {readOnly ? null : check.unlocked ? (
          <Link
            to={`/admin/imports/uploads/${upload.id}?step=dryRun`}
            className="rounded-md bg-verdigris-deep px-4 py-2 text-sm font-semibold text-parchment hover:opacity-90"
          >
            {t("check.gate.run")}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="cursor-not-allowed rounded-md bg-stone-200 px-4 py-2 text-sm font-semibold text-stone-400"
          >
            {t("check.gate.runLocked")}
          </button>
        )}
      </div>
    </section>
  );
}

function DecisionCard({
  t,
  finding,
  accepted,
  readOnly,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  finding: DecisionFinding;
  accepted: boolean;
  /** A closed upload's decision is a record: static chips, no forms. */
  readOnly: boolean;
}) {
  const [showFix, setShowFix] = useState(false);
  const fieldsText = finding.fields.map((f) => fieldLabel(t, f)).join(", ");
  const level = levelLabel(t, finding.level);
  const title =
    finding.count === 1 && finding.referenceCode
      ? t("check.decisionTitle.single", { code: finding.referenceCode, level, fields: fieldsText })
      : t("check.decisionTitle.multiple", { count: finding.count, level, fields: fieldsText });
  const cascade = accepted
    ? t("check.cascade.accepted")
    : finding.cascadeCount > 0
      ? t("check.cascade.descendants", { cascade: finding.cascadeCount })
      : t("check.cascade.self", { count: finding.count });
  const columns = finding.sourceColumns ?? [];

  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        accepted ? "border-sage-tint" : "border-saffron-tint"
      }`}
    >
      <div className={`flex items-center gap-3 px-4 py-3 ${accepted ? "bg-sage-wash" : "bg-saffron-tint/40"}`}>
        <span
          className={`rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${
            accepted ? "bg-sage-tint text-sage-deep" : "bg-saffron-tint text-saffron-deep"
          }`}
        >
          {accepted ? t("check.accepted") : t("check.kindDecision")}
        </span>
        <span className="text-sm font-semibold text-stone-700">{title}</span>
      </div>
      <div className="px-4 py-3 text-sm text-stone-600">
        <p className="max-w-prose">
          {t("check.decisionBody", { fields: fieldsText, level })}{" "}
          <span className={accepted ? "font-medium text-sage-deep" : "font-medium text-madder-deep"}>
            {cascade}
          </span>
        </p>
        {!readOnly && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Form method="post">
              <input type="hidden" name="intent" value={accepted ? "undo" : "accept"} />
              <input type="hidden" name="findingKey" value={finding.key} />
              <button
                type="submit"
                className={
                  accepted
                    ? "rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:border-stone-300"
                    : "rounded-md bg-indigo px-3 py-1.5 text-sm font-semibold text-parchment hover:bg-indigo-deep"
                }
              >
                {accepted ? t("check.undo") : t("check.accept")}
              </button>
            </Form>
            {!accepted && (
              <button
                type="button"
                onClick={() => setShowFix((v) => !v)}
                aria-expanded={showFix}
                className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:border-stone-300"
              >
                {t("check.howToFix")}
              </button>
            )}
          </div>
        )}
        {showFix && !accepted && !readOnly && (
          <div className="mt-3 rounded-md bg-indigo-wash px-3 py-2 text-sm text-indigo">
            {/* "Stage the corrected file" links to the landing's upload form. */}
            <Trans
              i18nKey={columns.length > 0 ? "check.fixHint" : "check.fixHintNoColumns"}
              ns="imports"
              values={columns.length > 0 ? { columns: columns.join(", ") } : {}}
              components={{ landing: landingLink }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** The fix-path link inside notice copy: back to the landing's upload form. */
const landingLink = (
  <Link to="/admin/imports" className="font-semibold underline" />
);

function BlockingCard({
  t,
  finding,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  finding: BlockingFinding;
}) {
  const rows = finding.rows.join(", ");
  let title: string;
  let bodyKey: string;
  let bodyValues: Record<string, unknown>;
  if (finding.blockingKind === "duplicate_reference_code") {
    title = t("check.blocking.duplicate", { count: finding.count, code: finding.referenceCode ?? "—" });
    bodyKey = "check.blocking.duplicateBody";
    bodyValues = { rows, code: finding.referenceCode ?? "—" };
  } else if (finding.blockingKind === "unresolvable_parent") {
    title = t("check.blocking.unresolvable", { count: finding.count, parent: finding.parentReferenceCode ?? "—" });
    bodyKey = "check.blocking.unresolvableBody";
    bodyValues = { parent: finding.parentReferenceCode ?? "—" };
  } else if (finding.blockingKind === "missing_reference_code") {
    title = t("check.blocking.missing", { count: finding.count });
    bodyKey = "check.blocking.missingBody";
    bodyValues = { count: finding.count };
  } else if (finding.blockingKind === "invalid_values") {
    title = t("check.blocking.invalid", { count: finding.count });
    bodyKey = "check.blocking.invalidBody";
    bodyValues = { rows };
  } else {
    title = t("check.blocking.cycle", { count: finding.count });
    bodyKey = "check.blocking.cycleBody";
    bodyValues = {};
  }
  return (
    <div className="overflow-hidden rounded-lg border border-madder-tint">
      <div className="flex items-center gap-3 bg-madder-wash px-4 py-3">
        <span className="rounded bg-madder-tint px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-madder-deep">
          {t("check.kindBlocking")}
        </span>
        <span className="text-sm font-semibold text-stone-700">{title}</span>
      </div>
      <div className="px-4 py-3 text-sm text-stone-600">
        <p className="max-w-prose">
          {/* The re-upload / import-the-container phrases link to the
              landing, where the upload form lives — never a dead end. */}
          <Trans
            i18nKey={bodyKey}
            ns="imports"
            values={bodyValues}
            components={{ landing: landingLink }}
          />
        </p>
        {finding.count > finding.rows.length && (
          <p className="mt-2 text-xs text-stone-400">
            {t("check.blocking.rowsMore", { shown: finding.rows.length, count: finding.count })}
          </p>
        )}
      </div>
    </div>
  );
}

function InfoCard({
  t,
  finding,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  finding: InfoFinding;
}) {
  const columns = (finding.columns ?? []).join(", ");
  let title: string;
  let body: string;
  if (finding.infoKind === "unmapped_columns") {
    title = t("check.info.unmapped", { count: finding.count });
    body = t("check.info.unmappedBody", { columns });
  } else if (finding.infoKind === "unbound_columns") {
    title = t("check.info.unbound", { count: finding.count });
    body = t("check.info.unboundBody", { columns });
  } else {
    const codeKey = `check.info.warningCode.${finding.code}`;
    const codeLabel = t(codeKey);
    const code = codeLabel === codeKey ? (finding.code ?? "") : codeLabel;
    title = t("check.info.warning", { count: finding.count, code });
    body = t("check.info.warningBody", { count: finding.count });
  }
  return (
    <div className="overflow-hidden rounded-lg border border-indigo-tint">
      <div className="flex items-center gap-3 bg-indigo-wash px-4 py-3">
        <span className="rounded bg-indigo-tint px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-indigo">
          {t("check.kindNote")}
        </span>
        <span className="text-sm font-semibold text-stone-700">{title}</span>
      </div>
      <div className="px-4 py-3 text-sm text-stone-600">
        <p className="max-w-prose">{body}</p>
      </div>
    </div>
  );
}

function CountCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border border-stone-200 px-4 py-3">
      <div className="font-mono text-2xl text-stone-700">{value}</div>
      <div className="text-xs uppercase tracking-wider text-stone-500">{label}</div>
    </div>
  );
}

function DryRunPane({
  t,
  upload,
  report,
  reportLive,
  runError,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  upload: Route.ComponentProps["loaderData"]["upload"];
  report: DryRunReport | null;
  reportLive: boolean;
  runError?: string;
}) {
  // Busy while THIS form's submission is in flight (several forms post to
  // this route, so the pending state is scoped by intent).
  const navigation = useNavigation();
  const running = isPendingIntent(navigation.state, navigation.formData, "run");
  return (
    <section aria-labelledby="dryrun-h">
      <h2 id="dryrun-h" className="text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("report.runHeading")}
      </h2>
      <p className="mt-2 text-sm text-stone-500">{t("report.runHelp")}</p>

      {runError && (
        <div role="alert" className="mt-4 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
          {t(`check.errors.${runError}`)}
        </div>
      )}

      <Form method="post" className="mt-4 flex flex-wrap items-end gap-4">
        <input type="hidden" name="intent" value="run" />
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            name="updateExisting"
            defaultChecked={report?.updateExisting ?? false}
            className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
          />
          {t("report.updateExisting")}
        </label>
        <button
          type="submit"
          disabled={running}
          aria-busy={running || undefined}
          className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment ${
            running ? "cursor-progress opacity-70" : "hover:bg-indigo-deep"
          }`}
        >
          {running && <BusySpinner />}
          {running
            ? t("busy.dryRun")
            : reportLive
              ? t("report.rerun")
              : t("report.run")}
        </button>
      </Form>

      {report && reportLive && (
        <>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-stone-500">
              {t("report.generatedAt", { when: formatIsoDateTime(report.generatedAt) })}
            </p>
            <p className="text-xs text-stone-400">
              {report.updateExisting ? t("report.modeUpsert") : t("report.modeCreateOnly")}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <CountCard value={report.counts.creates} label={t("report.creates")} />
            <CountCard value={report.counts.updates} label={t("report.updates")} />
            <CountCard value={report.counts.skips} label={t("report.skips")} />
            <CountCard value={report.counts.rejects} label={t("report.rejects")} />
            <CountCard value={report.counts.warnings} label={t("report.warnings")} />
          </div>

          {report.rejects.length > 0 && (
            <section className="mt-8">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-stone-500">
                {t("report.rejectsHeading")}
              </h3>
              <div className="mt-3 overflow-x-auto rounded-lg border border-stone-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 text-xs uppercase tracking-wider text-stone-500">
                      <th scope="col" className="px-4 py-2">{t("report.colRow")}</th>
                      <th scope="col" className="px-4 py-2">{t("report.colReference")}</th>
                      <th scope="col" className="px-4 py-2">{t("report.colTitle")}</th>
                      <th scope="col" className="px-4 py-2">{t("report.colReason")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rejects.map((r) => (
                      <tr key={r.rowNumber} className="border-b border-stone-100">
                        <td className="px-4 py-2 text-stone-600">{r.rowNumber}</td>
                        <td className="px-4 py-2 font-mono text-xs text-stone-700">{r.referenceCode || "—"}</td>
                        <td className="px-4 py-2 text-stone-600">{r.title || "—"}</td>
                        <td className="px-4 py-2 text-xs font-semibold text-madder-deep">
                          {reasonText(t, r.reason, r.detail)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="mt-6 flex flex-wrap gap-3">
            <a
              href={`/admin/imports/uploads/${upload.id}/download/rejects`}
              className="rounded-md border border-verdigris bg-verdigris-tint px-4 py-2 text-sm font-semibold text-verdigris-deep hover:bg-verdigris-wash"
            >
              {t("report.downloadRejects")}
            </a>
            <a
              href={`/admin/imports/uploads/${upload.id}/download/report`}
              className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("report.downloadReport")}
            </a>
          </section>

          <p className="mt-6">
            <Link
              to={`/admin/imports/uploads/${upload.id}?step=import`}
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("journey.continueImport")}
            </Link>
          </p>
        </>
      )}
    </section>
  );
}

/**
 * One commit-refusal notice. The three keys whose fix is a journey step
 * (`decisionsPending`, `profileStale`, `decisionsChanged`) link their
 * "resolve them" / "run a fresh dry-run" phrases to that step; every other
 * key renders as plain text.
 */
function CommitErrorText({
  t,
  error,
  uploadId,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  error: string;
  uploadId: string;
}) {
  if (error === "decisionsPending" || error === "profileStale" || error === "decisionsChanged") {
    return (
      <Trans
        i18nKey={`report.commitErrors.${error}`}
        ns="imports"
        components={{
          check: (
            <Link
              to={`/admin/imports/uploads/${uploadId}?step=check`}
              className="font-semibold underline"
            />
          ),
          dryRun: (
            <Link
              to={`/admin/imports/uploads/${uploadId}?step=dryRun`}
              className="font-semibold underline"
            />
          ),
        }}
      />
    );
  }
  return <>{t(`report.commitErrors.${error}`)}</>;
}

function ImportPane({
  t,
  upload,
  report,
  repositories,
  profileStale,
  commitError,
}: {
  t: ReturnType<typeof useTranslation>["t"];
  upload: Route.ComponentProps["loaderData"]["upload"];
  report: DryRunReport | null;
  repositories: Route.ComponentProps["loaderData"]["repositories"];
  profileStale: boolean;
  commitError?: string;
}) {
  const [attested, setAttested] = useState(false);
  // Busy from click to the 302 that lands on the run page (which then
  // shows the Workflow's own step progress).
  const navigation = useNavigation();
  const committing = isPendingIntent(navigation.state, navigation.formData, "commit");
  const alreadyCommitted = upload.status === "committed";
  const canCommit = upload.status === "staged" && !!report && !profileStale && repositories.length > 0;
  // A disabled button must name its reason (the first unmet condition);
  // the no-repositories case is covered by the teaching notice above, so
  // its line is suppressed rather than rendered twice.
  const blockedReason = commitBlockedReason({
    staged: upload.status === "staged",
    hasReport: !!report,
    profileStale,
    hasRepositories: repositories.length > 0,
    attested,
  });

  return (
    <section aria-labelledby="import-h">
      <h2 id="import-h" className="text-sm font-semibold uppercase tracking-wider text-stone-500">
        {t("report.commitHeading")}
      </h2>

      {commitError && (
        <div role="alert" className="mt-3 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm text-madder-deep">
          <CommitErrorText t={t} error={commitError} uploadId={upload.id} />
        </div>
      )}

      {alreadyCommitted ? (
        <p className="mt-2 text-sm text-stone-500">
          {t("report.alreadyCommitted")}{" "}
          {upload.runId && (
            <Link to={`/admin/imports/runs/${upload.runId}`} className="font-semibold text-indigo hover:underline">
              {t("report.viewRun")}
            </Link>
          )}
        </p>
      ) : profileStale ? (
        <p className="mt-2 text-sm text-madder-deep">
          <CommitErrorText t={t} error="profileStale" uploadId={upload.id} />
        </p>
      ) : repositories.length === 0 ? (
        // Flag-problems-propose-solutions: the notice teaches what a
        // repository IS, then links to the create surface with a returnTo
        // back to this step.
        <div className="mt-2">
          <p className="max-w-prose text-sm text-stone-500">{t("report.noRepositories")}</p>
          <p className="mt-3">
            <Link
              to={withReturnTo(
                "/admin/repositories/new",
                `/admin/imports/uploads/${upload.id}?step=import`,
              )}
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("report.addRepository")}
            </Link>
          </p>
        </div>
      ) : !report ? (
        <p className="mt-2 text-sm text-stone-500">{t("report.commitErrors.noReport")}</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-stone-500">{t("report.commitHelp")}</p>
          <Form method="post" className="mt-4 space-y-4">
            <input type="hidden" name="intent" value="commit" />
            <div>
              <label htmlFor="repositoryId" className="mb-1 block text-xs font-medium text-indigo">
                {t("report.repositoryLabel")}
              </label>
              <select
                id="repositoryId"
                name="repositoryId"
                required
                defaultValue={repositories.length === 1 ? repositories[0].id : ""}
                className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none"
              >
                <option value="">{t("report.chooseRepository")}</option>
                {repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-stone-400">
                {t("report.repositoryHelp")}{" "}
                <Link
                  to="/admin/repositories"
                  className="font-semibold text-indigo hover:underline"
                >
                  {t("report.manageRepositories")}
                </Link>
              </p>
            </div>

            <div>
              <label htmlFor="message" className="mb-1 block text-xs font-medium text-indigo">
                {t("report.messageLabel")}
              </label>
              <input
                type="text"
                id="message"
                name="message"
                required
                maxLength={500}
                placeholder={t("report.messagePlaceholder")}
                className="block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none"
              />
              <p className="mt-1 text-xs text-stone-400">{t("report.messageHelp")}</p>
            </div>

            <div>
              <label htmlFor="justification" className="mb-1 block text-xs font-medium text-indigo">
                {t("report.justificationLabel")}
              </label>
              <textarea
                id="justification"
                name="justification"
                rows={2}
                className="block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none"
              />
            </div>

            <label className="flex items-start gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
              />
              {t("report.attest", {
                writes: report.counts.creates + report.counts.updates,
                rejects: report.counts.rejects,
              })}
            </label>

            <button
              type="submit"
              disabled={!canCommit || !attested || committing}
              aria-disabled={!canCommit || !attested || committing}
              aria-busy={committing || undefined}
              className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment ${
                committing
                  ? "cursor-progress opacity-70"
                  : canCommit && attested
                    ? "hover:bg-indigo-deep"
                    : "cursor-not-allowed opacity-40"
              }`}
            >
              {committing && <BusySpinner />}
              {committing ? t("busy.commit") : t("report.commit")}
            </button>
            {blockedReason !== null && blockedReason !== "noRepositories" && (
              <p role="status" className="text-xs text-stone-500">
                {blockedReason === "profileStale" ? (
                  <CommitErrorText t={t} error="profileStale" uploadId={upload.id} />
                ) : blockedReason === "noReport" ? (
                  <Trans
                    i18nKey="report.commitBlocked.noReport"
                    ns="imports"
                    components={{
                      dryRun: (
                        <Link
                          to={`/admin/imports/uploads/${upload.id}?step=dryRun`}
                          className="font-semibold underline"
                        />
                      ),
                    }}
                  />
                ) : (
                  t(`report.commitBlocked.${blockedReason}`)
                )}
              </p>
            )}
            <p className="text-xs text-stone-400">{t("report.commitNote")}</p>
          </Form>
        </>
      )}
    </section>
  );
}
