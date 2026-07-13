/**
 * Publish Export Workflow
 *
 * This workflow deals with driving the full publish run end-to-end as
 * a durable Cloudflare Workflow: load the requested fonds, write a
 * heartbeat row into
 * `export_runs`, invoke every pipeline step in its own Worker
 * invocation so each one gets a fresh runtime budget, and close the
 * row out with a success or failure tombstone. The workflow instance
 * id is propagated into the row so an operator can match the admin
 * history against the Workflows dashboard.
 *
 * Step bodies in `app/lib/export/pipeline.server.ts` are idempotent
 * by construction — they re-upload the same R2 keys on retry — so
 * the recovery story for a transient failure is "retry the whole
 * workflow run", not "resume mid-step".
 *
 * The workflow resolves the EXPORT SCOPE once at start in
 * `load-config` (federation spec §9 step 8). The triggering tenant is
 * resolved via a join from `exportRuns.triggeredBy → users.tenantId →
 * tenants`; `resolveExportScope` then decides whether this is a
 * federation publish (the lead aggregating every member tenant's rows)
 * or a single-tenant own-publish. Either way EVERY artefact is written
 * under ONE R2 prefix — the publish (lead) slug — so a federation run
 * reproduces the pre-partition single-tenant layout byte-for-byte
 * (publish-neutrality). Per-fonds steps receive a per-fonds tenant whose
 * `id`/`descriptiveStandard` are the fonds' OWNING member tenant (so the
 * right rows are read and the right EAD3 profile is picked) but whose
 * `slug` is the publish slug; per-type steps receive the publish tenant
 * plus the full member-tenant id list to aggregate their reads across.
 *
 * @version v0.4.2
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { exportRuns, users, tenants } from "../db/schema";
import { ExportStorage } from "../lib/export/r2-client.server";
import {
  exportFondsDescriptions,
  exportFondsChildren,
  exportFondsEad,
  exportFondsDc,
  exportRepositories,
  exportEntities,
  exportPlaces,
  recordStepStart,
  recordStepEnd,
} from "../lib/export/pipeline.server";
import {
  writeDescriptionsIndex,
  FondsBodyTooLargeError,
} from "../lib/export/combined.server";
import { exportFondsMets } from "../lib/export/mets-export.server";
import { resolveExportScope } from "../lib/export/federation-scope.server";
import { getFondsOwners } from "../lib/export/fonds-list.server";
import type { ExportTenant } from "../lib/export/types";

/**
 * Cloudflare Workflow that runs the publish-export pipeline.
 *
 * Each `step.do(...)` runs in its own Worker invocation with a fresh
 * 1000-subrequest / 30s-CPU / 128 MB budget — the natural fit for an
 * export that has well-defined per-fonds boundaries. The workflow
 * instance id is propagated into export_runs.workflow_instance_id so
 * the operator can correlate the row with the workflow dashboard.
 *
 * Trade-off: we wrap the whole `run()` body in a coarse try/catch
 * rather than relying on Workflows' native step retries to surface
 * errors. This is simpler and gives us a single place to write a
 * human-readable error message into the row. The cost is that a
 * truly transient step failure is treated as fatal here. Step bodies
 * are idempotent (they re-upload the same R2 keys), so retrying the
 * whole workflow run is safe — that is the recovery story.
 */

export interface PublishExportParams {
  exportId: string;
}

export class PublishExportWorkflow extends WorkflowEntrypoint<
  Env,
  PublishExportParams
> {
  async run(event: WorkflowEvent<PublishExportParams>, step: WorkflowStep) {
    const { exportId } = event.payload;
    const db = drizzle(this.env.DB);
    const storage = new ExportStorage(this.env.EXPORT_BUCKET);

    try {
      // Step 1: load run config and mark running.
      const config = await step.do("load-config", async () => {
        const run = await db
          .select()
          .from(exportRuns)
          .where(eq(exportRuns.id, exportId))
          .get();
        if (!run) throw new Error(`exportRun ${exportId} not found`);

        // Resolve the triggering tenant, then the export SCOPE. The
        // route already gates publish on superadmin +
        // requireCapability(tenant, 'publish_pipeline'), so the
        // triggering user's tenant is the same tenant the route's
        // authMiddleware resolved against the request host.
        //
        // exportRuns has no tenantId column; resolve the trigger tenant
        // via the triggering user's tenant.
        const tenantRow = await db
          .select({
            id: tenants.id,
            federationId: tenants.federationId,
            slug: tenants.slug,
            descriptiveStandard: tenants.descriptiveStandard,
          })
          .from(users)
          .innerJoin(tenants, eq(users.tenantId, tenants.id))
          .where(eq(users.id, run.triggeredBy))
          .get();
        if (!tenantRow) {
          throw new Error(
            `Tenant not resolvable for exportRun ${exportId} via triggeredBy ${run.triggeredBy}`
          );
        }
        if (!tenantRow.descriptiveStandard) {
          throw new Error(
            `Tenant ${tenantRow.slug} has no descriptive_standard (kind=platform tenants cannot publish)`
          );
        }

        const triggerTenant: ExportTenant = {
          id: tenantRow.id,
          federationId: tenantRow.federationId,
          slug: tenantRow.slug,
          descriptiveStandard: tenantRow.descriptiveStandard,
        };

        // Federation publish vs single-tenant own-publish (spec §9 step
        // 8). resolveExportScope is the ONE decision point shared with
        // the route + api.publish validator.
        const scope = await resolveExportScope(db, triggerTenant);

        // Map each selected fonds to the member tenant that OWNS it, so
        // per-fonds steps read from the right tenant. All writes still
        // land under scope.publishSlug (the lead slug) — see below.
        const ownerByFonds = await getFondsOwners(db, scope.memberTenantIds);
        const memberById = new Map(scope.members.map((m) => [m.id, m]));
        const selectedFonds = JSON.parse(run.selectedFonds) as string[];

        // Plain serialisable Record (Workflows persist step returns as
        // JSON — a Map would not survive the step boundary). Each value
        // has the owning tenant's id + descriptiveStandard but the
        // publish (lead) slug, so reads hit the owner while keys stay
        // under one prefix.
        const fondsTenants: Record<string, ExportTenant> = {};
        for (const fonds of selectedFonds) {
          const ownerId = ownerByFonds.get(fonds) ?? scope.publishTenant.id;
          const owner = memberById.get(ownerId) ?? scope.publishTenant;
          fondsTenants[fonds] = {
            id: owner.id,
            federationId: scope.federationId,
            slug: scope.publishSlug,
            descriptiveStandard: owner.descriptiveStandard,
          };
        }

        await db
          .update(exportRuns)
          .set({
            status: "running",
            startedAt: Date.now(),
            workflowInstanceId: event.instanceId,
            // Record which federation this run published (idempotent —
            // api.publish already set it; a workflow-only trigger path
            // still gets it right).
            federationId: scope.federationId,
          })
          .where(eq(exportRuns.id, exportId));

        return {
          selectedFonds,
          selectedTypes: JSON.parse(run.selectedTypes) as string[],
          publishTenant: scope.publishTenant,
          memberTenantIds: scope.memberTenantIds,
          fondsTenants,
          authoritiesEnabled: scope.authoritiesEnabled,
        };
      });

      const counts: Record<string, number> = {};

      if (config.selectedTypes.includes("descriptions")) {
        // One step per fonds — each gets its own runtime budget.
        for (const fonds of config.selectedFonds) {
          const result = await step.do(`descriptions:${fonds}`, async () => {
            await recordStepStart(db, exportId, `descriptions:${fonds}`);
            const r = await exportFondsDescriptions(db, storage, fonds, config.fondsTenants[fonds]);
            counts[`descriptions:${fonds}`] = r.recordCount;
            await recordStepEnd(db, exportId, `descriptions:${fonds}`, counts);
            return r;
          });
          counts[`descriptions:${fonds}`] = result.recordCount;
        }

        // One step to write descriptions-index.json. The single combined
        // descriptions.json file was deliberately NOT produced by the worker
        // after Task 4 verification showed that R2 streaming put in
        // wrangler dev local deadlocks on large bodies AND production-scale
        // fonds exceed single-Worker memory even with a byte-level scanner.
        // zasqua reads the per-fonds files + this index at build
        // time to produce the concatenated descriptions.json for its static
        // site.
        await step.do("descriptions:index", async () => {
          await recordStepStart(db, exportId, "descriptions:index");
          const perFondsCounts: Record<string, number> = {};
          for (const fonds of config.selectedFonds) {
            perFondsCounts[fonds] = counts[`descriptions:${fonds}`] ?? 0;
          }
          const r = await writeDescriptionsIndex(
            storage,
            config.selectedFonds,
            perFondsCounts,
            config.publishTenant
          );
          counts["descriptions:index"] = r.totalRecordCount;
          await recordStepEnd(db, exportId, "descriptions:index", counts);
        });

        // One step PER FONDS for children — never tens of thousands of PUTs
        // in one Worker invocation.
        for (const fonds of config.selectedFonds) {
          await step.do(`children:${fonds}`, async () => {
            await recordStepStart(db, exportId, `children:${fonds}`);
            const r = await exportFondsChildren(db, storage, fonds, config.fondsTenants[fonds]);
            counts[`children:${fonds}`] = r.putCount;
            await recordStepEnd(db, exportId, `children:${fonds}`, counts);
          });
        }

        // METS XML generation — one step per fonds for dirty digitised items.
        // Runs after children so description data is current.
        for (const fonds of config.selectedFonds) {
          await step.do(`mets:${fonds}`, async () => {
            await recordStepStart(db, exportId, `mets:${fonds}`);
            const r = await exportFondsMets(db, this.env.METS_BUCKET, fonds, config.fondsTenants[fonds]);
            counts[`mets:${fonds}`] = r.generatedCount;
            await recordStepEnd(db, exportId, `mets:${fonds}`, counts);
          });
        }

        // EAD3 finding aid per fonds. Profile picked from
        // tenant.descriptiveStandard inside exportFondsEad. R2 key:
        // ${tenant.slug}/ead/<sanitisedRef>.xml.
        for (const fonds of config.selectedFonds) {
          await step.do(`ead:${fonds}`, async () => {
            await recordStepStart(db, exportId, `ead:${fonds}`);
            const r = await exportFondsEad(db, storage, fonds, config.fondsTenants[fonds]);
            counts[`ead:${fonds}`] = r.recordCount;
            await recordStepEnd(db, exportId, `ead:${fonds}`, counts);
          });
        }

        // Dublin Core bulk file per fonds. OAI-PMH 2.0 ListRecords
        // envelope; one <record> per published description. R2 key:
        // ${tenant.slug}/dc/<sanitisedRef>.xml.
        for (const fonds of config.selectedFonds) {
          await step.do(`dc:${fonds}`, async () => {
            await recordStepStart(db, exportId, `dc:${fonds}`);
            const r = await exportFondsDc(db, storage, fonds, config.fondsTenants[fonds]);
            counts[`dc:${fonds}`] = r.recordCount;
            await recordStepEnd(db, exportId, `dc:${fonds}`, counts);
          });
        }
      }

      if (config.selectedTypes.includes("repositories")) {
        await step.do("repositories", async () => {
          await recordStepStart(db, exportId, "repositories");
          const r = await exportRepositories(db, storage, config.publishTenant, config.memberTenantIds);
          counts.repositories = r.count;
          await recordStepEnd(db, exportId, "repositories", counts);
        });
      }

      // Entities/places export the authority junctions; skip both when
      // the triggering tenant lacks the authorities capability (spec §6).
      // The display-field-only renderers above stay untouched.
      if (config.authoritiesEnabled && config.selectedTypes.includes("entities")) {
        await step.do("entities", async () => {
          await recordStepStart(db, exportId, "entities");
          const r = await exportEntities(db, storage, config.publishTenant, config.memberTenantIds);
          counts.entities = r.count;
          await recordStepEnd(db, exportId, "entities", counts);
        });
      }

      if (config.authoritiesEnabled && config.selectedTypes.includes("places")) {
        await step.do("places", async () => {
          await recordStepStart(db, exportId, "places");
          const r = await exportPlaces(db, storage, config.publishTenant, config.memberTenantIds);
          counts.places = r.count;
          await recordStepEnd(db, exportId, "places", counts);
        });
      }

      await step.do("finalize", async () => {
        await db
          .update(exportRuns)
          .set({
            status: "complete",
            completedAt: Date.now(),
            recordCounts: JSON.stringify(counts),
          })
          .where(eq(exportRuns.id, exportId));
      });
    } catch (err) {
      const isGuard = err instanceof FondsBodyTooLargeError;
      const message = isGuard
        ? `FondsBodyTooLargeError: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Unknown publish-export error";

      await db
        .update(exportRuns)
        .set({
          status: "error",
          errorMessage: message,
          completedAt: Date.now(),
        })
        .where(eq(exportRuns.id, exportId));

      // Re-throw so the Workflows runtime sees the failure and the dashboard
      // shows the run as errored too. Without re-throwing, Workflows would
      // mark the run as complete from its perspective.
      throw err;
    }
  }
}
