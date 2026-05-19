/**
 * Operator — Tenants List
 *
 * This page handles GET `/operator/tenants` on the platform host.
 * Cross-tenant read by design — the operator surface is the only
 * legitimate cross-tenant
 * reader in v0.4. The cross-tenant keystone grep test
 * (`tests/db/cross-tenant-coverage.test.ts`) deliberately scopes out
 * `_operator.*.{ts,tsx}` so the absence of a `tenantId` predicate
 * here does NOT fail CI.
 *
 * No `action` export — pure read. The page does NOT call
 * `withAuditLog`: cross-tenant reads are not individually audited.
 * The temporal capture for cross-tenant access is the impersonation
 * envelope's 30-min window plus the `login_as` audit row that opens
 * it; per-page-view audit traffic would be high-volume + low-signal
 * and is explicitly out of scope.
 *
 * The list shows: slug, name, kind, descriptive_standard, the four
 * capability booleans (rendered as a 4-letter mask CVPM where each
 * letter is present iff the corresponding capability is enabled),
 * the disabled flag, and a per-row "View" link that points to
 * `/operator/tenants/:slug`.
 *
 * The platform tenant row gets a [platform] / [plataforma] badge and
 * its actions cell is suppressed (no view link, no soft-disable, no
 * impersonation — the same UI suppressions apply on the detail
 * page). The disabled tenant row carries a "Disabled" badge derived
 * from the non-null `disabledAt` timestamp.
 *
 * The [New tenant] button in the header points at
 * `/operator/tenants/new`.
 *
 * @version v0.4.0
 */

import { Link, useLoaderData } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { asc } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { tenants } from "../db/schema";
import { PLATFORM_TENANT_ID } from "../lib/tenant";
import type { Route } from "./+types/_operator.tenants._index";

export async function loader({ context }: Route.LoaderArgs) {
  const env = (context as any).cloudflare.env;
  const db = drizzle(env.DB);
  // Cross-tenant read by design — no `where(eq(tenants.tenantId, ...))`.
  // Sorted by (kind ASC, slug ASC) so the platform tenant always
  // lands first ('platform' < 'tenant' in alpha order) and the rest
  // are alphabetically reachable.
  const allTenants = await db
    .select()
    .from(tenants)
    .orderBy(asc(tenants.kind), asc(tenants.slug))
    .all();
  return { tenants: allTenants };
}

export default function TenantsList() {
  const { tenants: rows } = useLoaderData<typeof loader>();
  const { t } = useTranslation("operator");

  return (
    <section>
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-stone-900">
          {t("tenants_list.page_title")}
        </h1>
        <Link
          to="/operator/tenants/new"
          className="rounded bg-verdigris px-3 py-2 font-sans text-sm font-medium text-white hover:bg-verdigris/90"
        >
          {t("tenants_list.new_tenant_button")}
        </Link>
      </header>
      {rows.length === 0 ? (
        <p className="font-sans text-sm text-stone-500">
          {t("tenants_list.empty_state")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-stone-200">
          <table className="w-full font-sans text-sm">
            <thead className="bg-stone-50">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.slug")}
                </th>
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.name")}
                </th>
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.kind")}
                </th>
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.descriptive_standard")}
                </th>
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.capabilities")}
                </th>
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.disabled")}
                </th>
                <th className="px-3 py-2 font-medium text-stone-700">
                  {t("tenants_list.columns.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tenant) => {
                const caps = [
                  tenant.crowdsourcingEnabled ? "C" : "",
                  tenant.vocabularyHubEnabled ? "V" : "",
                  tenant.publishPipelineEnabled ? "P" : "",
                  tenant.multiRepositoryEnabled ? "M" : "",
                ]
                  .filter(Boolean)
                  .join("");
                const isPlatform = tenant.id === PLATFORM_TENANT_ID;
                const isDisabled = tenant.disabledAt !== null;
                return (
                  <tr
                    key={tenant.id}
                    className="border-t border-stone-200"
                  >
                    <td className="px-3 py-2">
                      <span className="font-mono text-stone-900">
                        {tenant.slug}
                      </span>
                      {isPlatform ? (
                        <span className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-600">
                          {t("tenants_list.badges.platform")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-stone-900">{tenant.name}</td>
                    <td className="px-3 py-2 text-stone-700">{tenant.kind}</td>
                    <td className="px-3 py-2 text-stone-700">
                      {tenant.descriptiveStandard ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-stone-700">
                      {caps || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {isDisabled ? (
                        <span className="rounded bg-rust/10 px-1.5 py-0.5 font-sans text-xs text-rust">
                          {t("tenants_list.badges.disabled")}
                        </span>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {!isPlatform ? (
                        <Link
                          to={`/operator/tenants/${tenant.slug}`}
                          className="font-sans text-sm font-medium text-indigo hover:underline"
                        >
                          {t("tenants_list.view_link")}
                        </Link>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// @version v0.4.0
