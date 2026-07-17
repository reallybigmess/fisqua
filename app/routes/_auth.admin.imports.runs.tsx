/**
 * Imports Admin — stewardship run list
 *
 * This page lists the tenant's import runs (imports spec §5; stewardship
 * record spec §5 stage 1): message, kind, status, author, counts, and
 * created date, newest first. Rows whose status is still `pending` or
 * `running` refresh on an interval — the same live-progress affordance the
 * publish-run surface uses — so an operator watching a commit sees it
 * advance without a manual reload.
 *
 * The loader gates on the admin role and the `imports` capability and reads
 * runs tenant-scoped: `stewardship_runs` carries a first-class `tenant_id`,
 * so one tenant can never see another's runs.
 *
 * @version v0.6.0
 */

import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { formatIsoDateTime } from "../lib/format-date";
import type { Route } from "./+types/_auth.admin.imports.runs";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { listRuns } = await import("~/lib/import/runs.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "imports");

  const db = drizzle(context.cloudflare.env.DB);
  const runs = await listRuns(db, tenant.id);
  return { runs };
}

/**
 * A run's counts JSON, loosely typed: import runs carry created/updated/…,
 * revert runs carry deleted/restored/…, so every field is optional and the
 * kind-aware renderer reads only the ones that apply.
 */
function parseCounts(json: string | null): Record<string, number> | null {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export default function ImportRunsPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("imports");
  const { runs } = loaderData;
  const revalidator = useRevalidator();

  // Live refresh while any run is still in flight (the publish-run pattern).
  const anyInFlight = runs.some((r) => r.status === "pending" || r.status === "running");
  useEffect(() => {
    if (!anyInFlight) return;
    const id = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(id);
  }, [anyInFlight, revalidator]);

  return (
    <div className="mx-auto max-w-5xl px-8 py-12">
      <nav aria-label={t("nav.breadcrumb")} className="mb-4 text-sm">
        <Link to="/admin/imports" className="text-stone-500 hover:text-stone-700">
          {t("nav.back")}
        </Link>
      </nav>

      <h1 className="font-serif text-2xl font-semibold text-stone-700">{t("runs.heading")}</h1>
      <p className="mt-2 max-w-2xl text-sm text-stone-500">{t("runs.intro")}</p>

      {runs.length === 0 ? (
        <p className="mt-6 text-sm text-stone-500">{t("runs.empty")}</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-xs uppercase tracking-wider text-stone-500">
                <th scope="col" className="px-4 py-2">{t("runs.colMessage")}</th>
                <th scope="col" className="px-4 py-2">{t("runs.colKind")}</th>
                <th scope="col" className="px-4 py-2">{t("runs.colStatus")}</th>
                <th scope="col" className="px-4 py-2">{t("runs.colCounts")}</th>
                <th scope="col" className="px-4 py-2">{t("runs.colCreated")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const counts = parseCounts(run.recordCounts);
                return (
                  <tr key={run.id} className="border-b border-stone-100">
                    <td className="px-4 py-2">
                      <Link
                        to={`/admin/imports/runs/${run.id}`}
                        className="font-semibold text-indigo hover:underline"
                      >
                        {run.message}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-stone-600">{t(`runs.kind.${run.kind}`)}</td>
                    <td className="px-4 py-2">
                      <span className="font-mono text-xs text-stone-600">
                        {t(`runs.status.${run.status}`)}
                        {(run.status === "running" || run.status === "pending") &&
                          run.totalSteps > 0 &&
                          ` · ${run.stepsCompleted}/${run.totalSteps}`}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-600">
                      {!counts
                        ? "—"
                        : run.kind === "revert"
                          ? t("runs.revertCountsSummary", {
                              reverted:
                                (counts.deleted ?? 0) +
                                (counts.restored ?? 0) +
                                (counts.reinserted ?? 0),
                              kept:
                                (counts.skippedEdited ?? 0) +
                                (counts.skippedForeignChildren ?? 0) +
                                (counts.skippedConflict ?? 0),
                            })
                          : t("runs.countsSummary", {
                              created: counts.created ?? 0,
                              updated: counts.updated ?? 0,
                              unchanged: counts.unchanged ?? 0,
                              skipped: counts.skipped ?? 0,
                              rejected: counts.rejected ?? 0,
                            })}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-600">
                      {formatIsoDateTime(run.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
