/**
 * Publish Trigger API
 *
 * This API endpoint is the superadmin-only POST that starts a new
 * publish run. The payload is validated against a dynamic schema that
 * only accepts
 * fonds the database actually knows about, then a fresh row is
 * inserted into `export_runs` and the `PublishExportWorkflow` is
 * instantiated with that row id. The response carries the new run id
 * so the dashboard can navigate into the progress panel.
 *
 * The dynamic fonds list is tenant-scoped via
 * `getFondsList(db, tenant)` so a Tenant A superadmin cannot smuggle
 * a Tenant B fonds reference through the validator. The workflow
 * itself resolves the tenant from
 * `exportRuns.triggeredBy → users.tenantId` inside `load-config`;
 * this route's tenant context comes from the auth middleware that
 * resolved the request host.
 *
 * @version v0.4.0
 */

import { z } from "zod";
import { tenantContext, userContext } from "../context";
import { requireSuperAdmin } from "../lib/superadmin.server";
import { getFondsList } from "../lib/export/fonds-list.server";
import type { Route } from "./+types/api.publish";

const VALID_TYPES = ["descriptions", "repositories", "entities", "places"] as const;

/**
 * POST /api/publish — Trigger a new export run.
 * Superadmin only. Inserts an exportRuns row and triggers the
 * PublishExportWorkflow which runs each pipeline step in its own
 * Worker invocation with a fresh runtime budget.
 */
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireSuperAdmin(user);

  const { drizzle } = await import("drizzle-orm/d1");
  const { exportRuns } = await import("../db/schema");

  const db = drizzle(context.cloudflare.env.DB);

  // Build dynamic validation schema from DB-derived fonds list,
  // scoped to the calling tenant so a Tenant A superadmin cannot
  // smuggle a Tenant B fonds reference past the validator.
  //
  // `tenant.descriptiveStandard` being null is a schema-invariant
  // violation (the CHECK in drizzle/0034_tenants_table.sql forbids
  // it when `kind = 'tenant'`). The workflow's load-config correctly
  // throws on this case; the route fails just as loudly rather than
  // silently masking a corrupted tenant row by defaulting to ISAD(G)
  // shape (which would route DACS or RAD tenants to the wrong EAD
  // profile if a future refactor reads this from the same `tenant`
  // object).
  if (!tenant.descriptiveStandard) {
    throw new Error(
      `Tenant ${tenant.slug} has no descriptive_standard (kind=platform tenants cannot publish)`
    );
  }
  const fondsList = await getFondsList(db, {
    id: tenant.id,
    slug: tenant.slug,
    descriptiveStandard: tenant.descriptiveStandard,
  });
  const PublishRequestSchema = z.object({
    selectedFonds: z
      .array(
        z.string().refine((val) => fondsList.includes(val), {
          message: "Invalid fonds code",
        })
      )
      .nonempty("selectedFonds must contain at least one fonds code"),
    selectedTypes: z
      .array(z.enum(VALID_TYPES))
      .nonempty("selectedTypes must contain at least one type"),
  });

  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PublishRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { selectedFonds, selectedTypes } = parsed.data;

  // Compute total steps — counts only heartbeat-emitting steps that advance
  // stepsCompleted via recordStepEnd in PublishExportWorkflow. When
  // 'descriptions' is in selectedTypes the per-fonds run emits five steps
  // per fonds (descriptions, children, mets, ead, dc) plus one
  // descriptions:index step. Plus one each for repositories, entities,
  // places when in selectedTypes. The workflow's load-config and finalize
  // steps intentionally do not emit heartbeats, so they are excluded.
  //
  // An earlier formula was `selectedFonds.length * 2 + 1`, which
  // counted only descriptions + children + index per fonds and
  // silently undercounted by N — every mets:{fonds} step emitted a
  // heartbeat the formula never accounted for, so the progress UI
  // consistently overshot 100% on every publish run that included
  // digitised items. The current formula matches what the workflow
  // actually emits.
  const hasDescriptions = selectedTypes.includes("descriptions");
  const nonDescTypes = selectedTypes.filter((t) => t !== "descriptions");
  const PER_FONDS_STEP_COUNT = 5; // descriptions + children + mets + ead + dc
  const INDEX_STEPS = 1; // descriptions:index
  const totalSteps =
    (hasDescriptions
      ? selectedFonds.length * PER_FONDS_STEP_COUNT + INDEX_STEPS
      : 0) + nonDescTypes.length;

  const exportId = crypto.randomUUID();
  const now = Date.now();

  await db.insert(exportRuns).values({
    id: exportId,
    triggeredBy: user.id,
    status: "pending",
    selectedFonds: JSON.stringify(selectedFonds),
    selectedTypes: JSON.stringify(selectedTypes),
    stepsCompleted: 0,
    totalSteps,
    createdAt: now,
  });

  // Trigger the publish-export workflow. Each step runs in its own Worker
  // invocation, so the 212k-record dataset no longer needs to fit inside one
  // waitUntil budget. The workflow id is the export id, so the existing
  // GET /api/publish?exportId=... polling continues to work without changes.
  //
  // Defer the .create() call via ctx.waitUntil so this handler returns the
  // 202 immediately. In wrangler dev local, awaiting .create() can block the
  // response until the whole workflow finishes — which makes the dashboard
  // look frozen on "Processing…" until the run is already done.
  context.cloudflare.ctx.waitUntil(
    context.cloudflare.env.PUBLISH_EXPORT.create({
      id: exportId,
      params: { exportId },
    })
      .then(() => undefined)
      .catch(async (err) => {
        const { exportRuns: runs } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");
        const message =
          err instanceof Error ? err.message : "failed to create workflow";
        await db
          .update(runs)
          .set({
            status: "error",
            errorMessage: `workflow create failed: ${message}`,
            completedAt: Date.now(),
          })
          .where(eq(runs.id, exportId));
      })
  );

  return Response.json({ exportId }, { status: 202 });
}

/**
 * GET /api/publish — Poll export progress or list recent runs.
 * Superadmin only.
 * - With ?exportId=X: returns single run progress
 * - Without exportId: returns 20 most recent runs (this tenant only)
 *
 * Both branches must be tenant-scoped: an unscoped query against the
 * global `exportRuns` table would let a Tenant A superadmin read any
 * Tenant B run by id, and the list branch would return the 20 most
 * recent runs platform-wide. `exportRuns` carries no `tenantId`
 * column (the schema add was deliberately deferred to v0.5+), so
 * tenant scoping is enforced by joining `exportRuns.triggeredBy →
 * users.tenantId` and filtering by the route's `tenantContext`. This
 * mirrors the workflow's `load-config` pattern.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireSuperAdmin(user);

  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, desc } = await import("drizzle-orm");
  const { exportRuns, users } = await import("../db/schema");

  const db = drizzle(context.cloudflare.env.DB);
  const url = new URL(request.url);
  const exportId = url.searchParams.get("exportId");

  if (exportId) {
    const run = await db
      .select({
        id: exportRuns.id,
        status: exportRuns.status,
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
      })
      .from(exportRuns)
      .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
      .where(and(eq(exportRuns.id, exportId), eq(users.tenantId, tenant.id)))
      .get();

    if (!run) {
      return Response.json({ error: "Export run not found" }, { status: 404 });
    }

    return Response.json(run);
  }

  // Return 20 most recent export runs scoped to this tenant. The
  // explicit column projection avoids `users.*` leaking into the
  // response body.
  const runs = await db
    .select({
      id: exportRuns.id,
      triggeredBy: exportRuns.triggeredBy,
      status: exportRuns.status,
      selectedFonds: exportRuns.selectedFonds,
      selectedTypes: exportRuns.selectedTypes,
      currentStep: exportRuns.currentStep,
      stepsCompleted: exportRuns.stepsCompleted,
      totalSteps: exportRuns.totalSteps,
      recordCounts: exportRuns.recordCounts,
      workflowInstanceId: exportRuns.workflowInstanceId,
      currentStepStartedAt: exportRuns.currentStepStartedAt,
      currentStepCompletedAt: exportRuns.currentStepCompletedAt,
      lastHeartbeatAt: exportRuns.lastHeartbeatAt,
      errorMessage: exportRuns.errorMessage,
      startedAt: exportRuns.startedAt,
      completedAt: exportRuns.completedAt,
      createdAt: exportRuns.createdAt,
    })
    .from(exportRuns)
    .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
    .where(eq(users.tenantId, tenant.id))
    .orderBy(desc(exportRuns.createdAt))
    .limit(20)
    .all();

  return Response.json(runs);
}
