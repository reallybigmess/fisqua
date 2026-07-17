/**
 * Import Commit Workflow
 *
 * This workflow deals with committing a dry-run-reviewed import as a
 * durable Cloudflare Workflow (imports spec §5; stewardship record
 * spec §§2-3): bounded idempotent batches upserting descriptions by
 * (tenantId, referenceCode), every effect journaled atomically in the
 * same `db.batch` as the write it describes, and the owning
 * `stewardship_runs` row driven through the export_runs-shaped
 * lifecycle (status, step tracking, heartbeats, terminal counts).
 *
 * The class is bound in wrangler.jsonc as IMPORT_COMMIT
 * (class_name: ImportCommitWorkflow) and re-exported from
 * workers/app.ts so the Workflows runtime can resolve it.
 *
 * @version v0.6.0
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { getStagingStore } from "../lib/import/staging.server";
import {
  IMPORT_BATCH_SIZE,
  finalizeRun,
  failRun,
  loadCommitConfig,
  processCreateBatch,
  processUpdateBatch,
  recomputeStructuralCaches,
  recordRunStepEnd,
  recordRunStepStart,
  ImportCommitConfigError,
  type RunCounts,
} from "../lib/import/commit.server";

export interface ImportCommitParams {
  /** The stewardship_runs row this workflow drives. */
  runId: string;
  /** The committed upload whose staged CSV this run writes. */
  uploadId: string;
  /** The target repository for CREATED descriptions (existing rows keep theirs). */
  repositoryId: string;
  /**
   * The update-existing MODE the operator reviewed in the dry-run report.
   * Carried as a durable Workflow param (the run row has no column for it),
   * so re-derivation matches the reviewed report exactly. Not a write input
   * or a count — the verdicts are still re-derived from the CSV + profile.
   */
  updateExisting: boolean;
}

/** Split a list into fixed-size batches (documented at IMPORT_BATCH_SIZE). */
function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IMPORT_BATCH_SIZE) {
    out.push(items.slice(i, i + IMPORT_BATCH_SIZE));
  }
  return out;
}

export class ImportCommitWorkflow extends WorkflowEntrypoint<
  Env,
  ImportCommitParams
> {
  async run(event: WorkflowEvent<ImportCommitParams>, step: WorkflowStep) {
    const { runId, uploadId, repositoryId, updateExisting } = event.payload;
    const db = drizzle(this.env.DB);
    const store = getStagingStore(this.env);

    try {
      // Step 1 — re-derive verdicts + plan from the staged CSV and pinned
      // profile, snapshot existing codes, mark the run running. Step returns
      // are persisted by the Workflows runtime, so the plan survives retries.
      const config = await step.do("load-config", () =>
        loadCommitConfig(
          db,
          store,
          { runId, uploadId, repositoryId, updateExisting, workflowInstanceId: event.instanceId },
        ),
      );

      // Executed counts, accumulated from step RETURNS — the runtime
      // persists step returns across retries, so summing them is both
      // write-honest and retry-stable (stewardship spec §6). skipped and
      // rejected are verdict counts: no write happens for them, so the
      // verdict predicate is the write predicate.
      const executed: RunCounts = {
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: config.counts.skipped,
        rejected: config.counts.rejected,
        pathCacheCapped: 0,
      };

      // Create batches, in topological order (parents before children).
      const createBatches = batches(config.createCodes);
      for (let i = 0; i < createBatches.length; i++) {
        const label = `create-batch:${i + 1}/${createBatches.length}`;
        const r = await step.do(label, async () => {
          await recordRunStepStart(db, runId, label);
          const res = await processCreateBatch(db, store, config, createBatches[i]);
          // Running totals: prior steps have already accumulated into
          // `executed` (steps run sequentially), so this snapshot is the
          // progress-so-far the run surfaces render.
          await recordRunStepEnd(db, runId, label, {
            ...executed,
            created: executed.created + res.created,
            pathCacheCapped: (executed.pathCacheCapped ?? 0) + res.pathCacheCapped,
          });
          return res;
        });
        executed.created += r.created;
        executed.pathCacheCapped = (executed.pathCacheCapped ?? 0) + r.pathCacheCapped;
      }

      // Update batches (independent; any order).
      const updateBatches = batches(config.updateCodes);
      for (let i = 0; i < updateBatches.length; i++) {
        const label = `update-batch:${i + 1}/${updateBatches.length}`;
        const r = await step.do(label, async () => {
          await recordRunStepStart(db, runId, label);
          const res = await processUpdateBatch(db, store, config, updateBatches[i]);
          await recordRunStepEnd(db, runId, label, {
            ...executed,
            updated: executed.updated + res.updated,
            unchanged: executed.unchanged + res.unchanged,
          });
          return res;
        });
        executed.updated += r.updated;
        executed.unchanged += r.unchanged;
      }

      // Structural-cache reconciliation after the hierarchy writes. Its
      // childCount journal rows are cache maintenance, deliberately NOT
      // counted into `updated`.
      await step.do("recompute", async () => {
        await recordRunStepStart(db, runId, "recompute");
        await recomputeStructuralCaches(db, config);
        await recordRunStepEnd(db, runId, "recompute", executed);
      });

      // Terminal: write the accumulated write-derived counts, mark complete.
      await step.do("finalize", () => finalizeRun(db, runId, executed));
    } catch (err) {
      const message =
        err instanceof ImportCommitConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown import-commit error";
      await failRun(db, runId, message);
      // Re-throw so the Workflows dashboard shows the run as errored too.
      throw err;
    }
  }
}
