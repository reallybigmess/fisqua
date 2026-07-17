/**
 * Import Revert Workflow
 *
 * This workflow deals with reverting a completed run as a durable
 * Cloudflare Workflow (stewardship record spec §4): walk the target run's
 * journal in the derived reverse order (restores, then leaf-first deletes,
 * then root-first re-inserts, then container reconciliation), apply the
 * `updated_at` edited-since test per row (skip-and-report, never force),
 * journal every compensating write under the revert run in the same
 * `db.batch`, and drive the owning `stewardship_runs` row through the
 * export_runs-shaped lifecycle. The target's `reverted_by_run_id` is
 * stamped atomically at mint (the mutex), not here. Whole-run only; no
 * merge; revert-of-revert re-applies the original.
 *
 * The class is bound in wrangler.jsonc as IMPORT_REVERT
 * (class_name: ImportRevertWorkflow) and re-exported from
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
import { failRun, recordRunStepEnd, recordRunStepStart } from "../lib/import/commit.server";
import {
  REVERT_BATCH_SIZE,
  ImportRevertConfigError,
  finalizeRevertRun,
  loadRevertConfig,
  processDeleteBatch,
  processReinsertBatch,
  processRestoreBatch,
  reconcileContainers,
  type RevertCounts,
} from "../lib/import/revert.server";

export interface ImportRevertParams {
  /** The kind='revert' stewardship_runs row this workflow drives. */
  runId: string;
}

/** Split a list into fixed-size batches (documented at REVERT_BATCH_SIZE). */
function batches<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += REVERT_BATCH_SIZE) {
    out.push(items.slice(i, i + REVERT_BATCH_SIZE));
  }
  return out;
}

export class ImportRevertWorkflow extends WorkflowEntrypoint<
  Env,
  ImportRevertParams
> {
  async run(event: WorkflowEvent<ImportRevertParams>, step: WorkflowStep) {
    const { runId } = event.payload;
    const db = drizzle(this.env.DB);
    const store = getStagingStore(this.env);

    try {
      // Step 1 — load the revert + target runs, read the target journal,
      // build the reverse-order plan, mark the run running. Step returns
      // are persisted by the runtime, so the plan survives retries.
      const config = await step.do("load-config", () =>
        loadRevertConfig(db, { runId, workflowInstanceId: event.instanceId }),
      );

      // Write-derived counts, accumulated from step RETURNS (spec §4/§6).
      const executed: RevertCounts = {
        deleted: 0,
        restored: 0,
        reinserted: 0,
        skippedEdited: 0,
        skippedForeignChildren: 0,
        skippedConflict: 0,
      };

      // Restores first (independent field writes on surviving rows).
      const restoreBatches = batches(config.restores);
      for (let i = 0; i < restoreBatches.length; i++) {
        const label = `restore-batch:${i + 1}/${restoreBatches.length}`;
        const r = await step.do(label, async () => {
          await recordRunStepStart(db, runId, label);
          const res = await processRestoreBatch(db, config, restoreBatches[i]);
          await recordRunStepEnd(db, runId, label, revertCountsAsRun({
            ...executed,
            restored: executed.restored + res.restored,
            skippedEdited: executed.skippedEdited + res.skippedEdited,
          }));
          return res;
        });
        executed.restored += r.restored;
        executed.skippedEdited += r.skippedEdited;
      }

      // Deletes next, leaf-first (the plan is pre-sorted depth DESC).
      const deleteBatches = batches(config.deletes);
      for (let i = 0; i < deleteBatches.length; i++) {
        const label = `delete-batch:${i + 1}/${deleteBatches.length}`;
        const r = await step.do(label, async () => {
          await recordRunStepStart(db, runId, label);
          const res = await processDeleteBatch(db, config, deleteBatches[i]);
          await recordRunStepEnd(db, runId, label, revertCountsAsRun({
            ...executed,
            deleted: executed.deleted + res.deleted,
            skippedEdited: executed.skippedEdited + res.skippedEdited,
            skippedForeignChildren:
              executed.skippedForeignChildren + res.skippedForeignChildren,
          }));
          return res;
        });
        executed.deleted += r.deleted;
        executed.skippedEdited += r.skippedEdited;
        executed.skippedForeignChildren += r.skippedForeignChildren;
      }

      // Re-inserts next, root-first (the plan is pre-sorted depth ASC).
      const reinsertBatches = batches(config.reinserts);
      for (let i = 0; i < reinsertBatches.length; i++) {
        const label = `reinsert-batch:${i + 1}/${reinsertBatches.length}`;
        const r = await step.do(label, async () => {
          await recordRunStepStart(db, runId, label);
          const res = await processReinsertBatch(db, config, reinsertBatches[i]);
          await recordRunStepEnd(db, runId, label, revertCountsAsRun({
            ...executed,
            reinserted: executed.reinserted + res.reinserted,
            skippedConflict: executed.skippedConflict + res.skippedConflict,
          }));
          return res;
        });
        executed.reinserted += r.reinserted;
        executed.skippedConflict += r.skippedConflict;
      }

      // Container reconciliation after the structural changes.
      await step.do("reconcile", async () => {
        await recordRunStepStart(db, runId, "reconcile");
        await reconcileContainers(db, config);
        await recordRunStepEnd(db, runId, "reconcile", revertCountsAsRun(executed));
      });

      // Terminal: write the accumulated counts + report, mark complete.
      await step.do("finalize", () => finalizeRevertRun(db, store, config, executed));
    } catch (err) {
      const message =
        err instanceof ImportRevertConfigError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown import-revert error";
      await failRun(db, runId, message);
      // Re-throw so the Workflows dashboard shows the run as errored too.
      throw err;
    }
  }
}

/**
 * Adapt revert counts to the `RunCounts` shape `recordRunStepEnd` accepts
 * for its heartbeat write. The heartbeat only surfaces progress; the
 * terminal `record_counts` are written by `finalizeRevertRun` from the
 * revert-native counts. `created`/`updated` carry the reverted totals so
 * an in-flight revert still shows advancing numbers.
 */
function revertCountsAsRun(counts: RevertCounts): {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  rejected: number;
} {
  return {
    created: counts.deleted + counts.reinserted,
    updated: counts.restored,
    unchanged: 0,
    skipped:
      counts.skippedEdited + counts.skippedForeignChildren + counts.skippedConflict,
    rejected: 0,
  };
}
