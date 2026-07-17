/**
 * Imports Admin — canonical template download (spec §8)
 *
 * A resource route (no component) that streams the headers-only canonical
 * Fisqua template CSV for the tenant's descriptive standard. The header set
 * is the generated union-schema projection (`canonicalTemplateCsv`), so the
 * downloaded file's columns match the maintained "Fisqua template" starter
 * profile one-for-one: fill it, upload, dry-run, commit.
 *
 * Gated on admin + the `imports` capability, matching every other imports
 * surface. A UTF-8 BOM is prepended so Excel opens the accented column
 * names correctly (the same `utf-8-sig` reality the upload path accepts).
 *
 * @version v0.6.0
 */

import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.imports.template";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { canonicalTemplateCsv } = await import(
    "~/lib/import/canonical-template"
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

  const csv = canonicalTemplateCsv(tenant.descriptiveStandard);
  const body = "﻿" + csv;
  const filename = `fisqua-template-${tenant.descriptiveStandard}.csv`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
