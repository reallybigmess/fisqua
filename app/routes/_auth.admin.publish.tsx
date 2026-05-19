/**
 * Publish Admin Dashboard
 *
 * This page is the superadmin-only surface for triggering a new
 * publish run and watching it progress. The loader derives the
 * pre-flight changelog —
 * what would be added, modified, or unpublished for every fonds and
 * every other data type — and an in-flight runs is passed to the
 * progress panel so the page can poll until completion. Recent runs
 * appear in the history table below, each linking into the per-run
 * detail page.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. The pre-flight count queries against
 * `repositories`, `entities`, and `places` are scoped to
 * `tenant.id`, and the per-fonds CTE on `descriptions` is filtered
 * to the calling tenant.
 *
 * Capability gate runs before everything else. The loader calls
 * `requireCapability(tenant, "publish_pipeline")` as the first
 * data-access action, throwing a bare `Response(null, {status: 404})`
 * when the tenant has the `publish_pipeline` flag off. The gate
 * precedes the superadmin-only check so a tenant on a publish-off
 * configuration 404s for everyone, never falling through to the
 * "superadmin required" page.
 *
 * @version v0.4.0
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { ChangelogSection } from "../components/publish/changelog-section";
import { ExportControls } from "../components/publish/export-controls";
import { ExportProgress } from "../components/publish/export-progress";
import { ExportHistory } from "../components/publish/export-history";
import type { ChangelogData } from "../components/publish/changelog-section";
import type { Route } from "./+types/_auth.admin.publish";

export interface ExportRunRow {
  id: string;
  status: string;
  triggeredBy: string;
  selectedFonds: string;
  selectedTypes: string;
  currentStep: string | null;
  stepsCompleted: number;
  totalSteps: number;
  recordCounts: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
}

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { sql, desc, eq, and, isNull, gt } = await import("drizzle-orm");
  const { descriptions, repositories, entities, places, exportRuns, users } =
    await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "publish_pipeline");

  if (!user.isSuperAdmin) {
    return {
      authorized: false as const,
      fondsList: [] as string[],
      changelog: null,
      activeExport: null,
      history: [],
    };
  }

  const { getFondsList } = await import("../lib/export/fonds-list.server");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // `getFondsList` is tenant-scoped so cataloguers on Tenant A never
  // see Tenant B's fonds in the dropdown. The route is already gated
  // to `kind = 'tenant'` via `requireCapability` above, so
  // `descriptiveStandard` is non-null in practice.
  //
  // A nullable `descriptiveStandard` is a schema-invariant violation
  // (the CHECK in drizzle/0034_tenants_table.sql forbids it when
  // `kind = 'tenant'`); the workflow's load-config correctly throws
  // in that case, and we do the same here rather than silently
  // coercing a corrupted tenant row to ISAD(G) shape.
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

  // Find the last completed export timestamp scoped to this tenant.
  // Reading `lastExport` from the global `exportRuns` pool would let
  // a Tenant B run completing five minutes ago set the "since last
  // export" reference for Tenant A's changelog deltas —
  // under-counting legitimate Tenant A "modified since" rows.
  // `exportRuns` has no `tenantId` column (the schema add was
  // deferred to a future release), so tenant scoping joins
  // `exportRuns.triggeredBy → users.tenantId`.
  const lastExport = await db
    .select({ completedAt: exportRuns.completedAt })
    .from(exportRuns)
    .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
    .where(
      and(
        eq(exportRuns.status, "complete"),
        eq(users.tenantId, tenant.id)
      )
    )
    .orderBy(desc(exportRuns.completedAt))
    .limit(1)
    .get();

  const lastExportedAt = lastExport?.completedAt ?? null;

  // Description changelog: per-fonds counts using rootDescriptionId join
  // Since lastExportedAt column doesn't exist on descriptions, we use the
  // last export run's completedAt as the reference point.
  const fondsChanges = await db.all(sql`
    SELECT
      root.reference_code AS fonds,
      root.title AS fonds_label,
      SUM(CASE
        WHEN d.is_published = 1 AND ${lastExportedAt ? sql`d.updated_at > ${lastExportedAt}` : sql`1 = 1`}
        THEN 1 ELSE 0
      END) AS modified,
      SUM(CASE
        WHEN d.is_published = 1 AND ${lastExportedAt ? sql`d.created_at > ${lastExportedAt}` : sql`1 = 1`}
        THEN 1 ELSE 0
      END) AS added,
      SUM(CASE
        WHEN d.is_published = 0 AND ${lastExportedAt ? sql`d.updated_at > ${lastExportedAt}` : sql`0 = 0`}
        THEN 1 ELSE 0
      END) AS unpublished
    FROM ${descriptions} d
    JOIN ${descriptions} root ON d.root_description_id = root.id
    WHERE root.parent_id IS NULL
      AND d.tenant_id = ${tenant.id}
      AND root.tenant_id = ${tenant.id}
    GROUP BY root.reference_code, root.title
    ORDER BY root.reference_code
  `);

  const descriptionChangelog = (fondsChanges as Array<{
    fonds: string;
    fonds_label: string;
    added: number;
    modified: number;
    unpublished: number;
  }>).map((row) => ({
    fonds: row.fonds,
    fondsLabel: row.fonds_label,
    added: Number(row.added),
    modified: Number(row.modified),
    unpublished: Number(row.unpublished),
  }));

  // Repository/entity/place changelog: count modified since last export
  const repoCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .where(
          and(
            eq(repositories.tenantId, tenant.id),
            gt(repositories.updatedAt, lastExportedAt)
          )
        )
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(repositories)
        .where(eq(repositories.tenantId, tenant.id))
        .get();

  const entityCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(
          and(
            eq(entities.tenantId, tenant.id),
            gt(entities.updatedAt, lastExportedAt)
          )
        )
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(eq(entities.tenantId, tenant.id))
        .get();

  const placeCount = lastExportedAt
    ? await db
        .select({ count: sql<number>`count(*)` })
        .from(places)
        .where(
          and(
            eq(places.tenantId, tenant.id),
            gt(places.updatedAt, lastExportedAt)
          )
        )
        .get()
    : await db
        .select({ count: sql<number>`count(*)` })
        .from(places)
        .where(eq(places.tenantId, tenant.id))
        .get();

  const changelog: ChangelogData = {
    descriptions: descriptionChangelog,
    repositories: { modified: Number(repoCount?.count ?? 0) },
    entities: { modified: Number(entityCount?.count ?? 0) },
    places: { modified: Number(placeCount?.count ?? 0) },
  };

  // Active export (running or pending) — scoped to this tenant.
  // A global query would let a Tenant A superadmin landing on
  // /admin/publish while a Tenant B run was in flight see the Tenant
  // B run's id and let the polling ExportProgress panel chain into
  // the (also-leaked) GET /api/publish body. Same join pattern as
  // `lastExport` above.
  const activeExport = await db
    .select({
      id: exportRuns.id,
      status: exportRuns.status,
    })
    .from(exportRuns)
    .innerJoin(users, eq(exportRuns.triggeredBy, users.id))
    .where(
      and(
        sql`${exportRuns.status} IN ('running', 'pending')`,
        eq(users.tenantId, tenant.id)
      )
    )
    .orderBy(desc(exportRuns.createdAt))
    .limit(1)
    .get();

  // Export history: 20 most recent — scoped to this tenant.
  // A leftJoin on `users` would return platform-wide rows including
  // each run's triggering user email and selected fonds (cross-tenant
  // operator visibility); the join must be an innerJoin so it both
  // filters and exposes `users.tenantId` as the scoping column.
  const historyRows = await db
    .select({
      id: exportRuns.id,
      status: exportRuns.status,
      triggeredBy: users.email,
      selectedFonds: exportRuns.selectedFonds,
      selectedTypes: exportRuns.selectedTypes,
      currentStep: exportRuns.currentStep,
      stepsCompleted: exportRuns.stepsCompleted,
      totalSteps: exportRuns.totalSteps,
      recordCounts: exportRuns.recordCounts,
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

  return {
    authorized: true as const,
    fondsList,
    changelog,
    activeExport: activeExport
      ? { id: activeExport.id, status: activeExport.status }
      : null,
    history: historyRows,
  };
}

export default function PublishPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("publish");
  const { authorized, fondsList, changelog, activeExport, history } = loaderData;

  const [activeExportId, setActiveExportId] = useState<string | null>(
    activeExport?.id ?? null
  );
  const [isExporting, setIsExporting] = useState(false);

  // Rough total: sum of all per-fonds description added/modified, plus the
  // repo/entity/place modified counts. Used to estimate the publish duration
  // in the warning modal.
  const totalRecordCount =
    (changelog?.descriptions.reduce(
      (sum, f) => sum + f.added + f.modified,
      0
    ) ?? 0) +
    (changelog?.repositories.modified ?? 0) +
    (changelog?.entities.modified ?? 0) +
    (changelog?.places.modified ?? 0);

  if (!authorized) {
    return (
      <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3">
        <p className="font-sans text-sm text-saffron-deep">
          {t("superadminRequired")}
        </p>
      </div>
    );
  }

  async function handleExport(
    selectedFonds: string[],
    selectedTypes: string[]
  ) {
    setIsExporting(true);
    try {
      const response = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedFonds, selectedTypes }),
      });
      if (response.ok) {
        const data = (await response.json()) as { exportId: string };
        setActiveExportId(data.exportId);
      }
    } finally {
      setIsExporting(false);
    }
  }

  // Lazy-load sub-components to avoid circular imports
  // They will be created in Task 2
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-4xl font-semibold text-stone-700">
          {t("title")}
        </h1>
        <p className="mt-2 font-sans text-sm text-stone-500">
          {t("subtitle")}
        </p>
      </div>

      {changelog && <ChangelogSection changelog={changelog} />}

      <ExportControls
        fondsList={fondsList}
        disabled={isExporting || !!activeExportId}
        totalRecordCount={totalRecordCount}
        onExport={handleExport}
      />

      {activeExportId && <ExportProgress exportId={activeExportId} />}

      <ExportHistory history={history} />
    </div>
  );
}
