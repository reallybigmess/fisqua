/**
 * Imports Admin — run-scoped report artefact download
 *
 * This loader streams a run's report artefact (stewardship record spec §4)
 * straight from the staging store. It exists for REVERT runs, which have no
 * upload to hang a download off (the upload-scoped download route serves
 * import runs): the revert report is keyed by run id and its pointer lives
 * on the run's `report_artifact` column.
 *
 * It is capability-gated (`requireAdmin` + the `imports` capability) and
 * tenant-scoped: `getRun` resolves the run only within the acting tenant,
 * so one tenant can never fetch another tenant's report even by guessing a
 * run id. A run with no report, or a missing artefact, 404s rather than
 * streaming an empty body.
 *
 * @version v0.6.0
 */

import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.imports.runs.$runId.report";

export async function loader({ context, params }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { getRun } = await import("~/lib/import/runs.server");
  const { getStagingStore } = await import("~/lib/import/staging.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const run = await getRun(db, tenant.id, params.runId);
  if (!run || !run.reportArtifact) throw new Response(null, { status: 404 });

  const bytes = await getStagingStore(env).getBytes(run.reportArtifact);
  if (!bytes) throw new Response(null, { status: 404 });

  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="revert-${run.id}_report.json"`,
    },
  });
}
