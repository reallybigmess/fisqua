/**
 * Imports Admin — dry-run artefact download loader
 *
 * This loader streams a dry-run artefact — the rejects CSV or the report
 * JSON — from the staging store (spec §4). It is capability-gated
 * (`requireAdmin` + the `imports` capability) and tenant-scoped: the
 * upload is resolved through `getUpload`, which filters by tenant id, and
 * the staging key is derived from the tenant id, so one tenant can never
 * fetch another tenant's artefact even by guessing an upload id.
 *
 * `:kind` is `rejects` (the `_needs_review.csv`, original columns verbatim
 * plus row number and reason), `report` (the JSON artefact), or `source`
 * (the staged upload CSV verbatim — the run detail links it as the run's
 * source artefact). Any other value 404s. A missing artefact 404s rather
 * than streaming an empty body.
 *
 * @version v0.6.0
 */

import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.imports.uploads.$uploadId.download.$kind";

export async function loader({ context, params }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { getUpload } = await import("~/lib/import/uploads.server");
  const { getStagingStore, stagingKey } = await import(
    "~/lib/import/staging.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const kind = params.kind;
  if (kind !== "rejects" && kind !== "report" && kind !== "source") {
    throw new Response(null, { status: 404 });
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const upload = await getUpload(db, tenant.id, params.uploadId);
  if (!upload) throw new Response(null, { status: 404 });

  const key =
    kind === "rejects"
      ? stagingKey.reject(tenant.id, upload.id)
      : kind === "report"
        ? stagingKey.report(tenant.id, upload.id)
        : stagingKey.upload(tenant.id, upload.id);

  const bytes = await getStagingStore(env).getBytes(key);
  if (!bytes) throw new Response(null, { status: 404 });

  const base = upload.filename.replace(/\.csv$/i, "");
  const filename =
    kind === "rejects"
      ? `${base}_needs_review.csv`
      : kind === "report"
        ? `${base}_report.json`
        : upload.filename;
  const contentType =
    kind === "report"
      ? "application/json; charset=utf-8"
      : "text/csv; charset=utf-8";

  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
