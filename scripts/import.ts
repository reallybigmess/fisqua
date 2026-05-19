#!/usr/bin/env npx tsx
/**
 * Bulk Import CLI — orchestrator entry
 *
 * This script is the entry point for loading the archival data layer into
 * D1 from the JSON dumps produced by the Django-to-Fisqua migration. Takes a
 * command name (`repositories`, `entities`, `places`, `descriptions`,
 * `description-entities`, `description-places`, `clear`, `fts-rebuild`,
 * or `all`) and an input directory, reads the matching JSON file, runs
 * any required parent tables first to resolve foreign keys, and emits
 * SQL files under `.import/`. The companion `scripts/lib/` modules
 * handle id-mapping, SQL generation, and field transformation that
 * each command shares.
 *
 * This runs outside the Worker — plain Node via `tsx` — because a
 * bulk import of several hundred thousand rows is too heavy for a
 * Worker request even with Cloudflare Workflows behind it.
 *
 * Contracts the bulk import upholds:
 *
 *   - **Tenant-scoped clear.** Step 1 of `all` calls
 *     `generateTenantScopedClearSql({ tenantId: NEOGRANADINA_TENANT_ID })`
 *     so the clear path filters by tenant_id on every DELETE.
 *
 *   - **Import-time validation boundary.** Per-row validation uses
 *     `importDescriptionSchema` (the v0.4 base union schema) plus
 *     `LegacyIdsSchema`. The descriptive-standard validator family in
 *     `app/lib/validation/standard-aware-description.ts` is
 *     intentionally NOT applied at the import boundary — that
 *     validator targets cataloguer-authored data created against an
 *     explicit standard, while this bulk import absorbs pre-standard
 *     Django corpus. Operators move rows up to standard compliance
 *     through the cataloguing UI after import.
 *
 *   - **Per-row failure aggregation.** Per-row failures soft-skip and
 *     are aggregated into `scripts/.import/import-failures.json` keyed
 *     by table. Junction failures inherit `rootCauseTable` +
 *     `cascadedFrom` when their parent description / entity / place
 *     was upstream-skipped — the junction commands set these fields
 *     directly; the aggregator preserves them.
 *
 *   - **SQL-only seam.** This script generates SQL only; the
 *     `wrangler d1 execute` step lives in
 *     `scripts/import-neogranadina.ts`. Run `import.ts` standalone
 *     for dry-run SQL generation; run `import-neogranadina.ts` for
 *     end-to-end pull → restore → export → import → apply → rebuild.
 *     The `--target` flag is accepted on `import.ts` for forward-compat
 *     — the orchestrator passes it through so a single argv shape
 *     covers both call sites — but `import.ts` itself does not invoke
 *     wrangler.
 *
 *   - **skippedPks threading.** Each row builder returns a
 *     `skippedPks: Set<number>` of upstream Django pks that
 *     soft-skipped. The junction commands receive both upstream Sets
 *     so cascade-skip semantics work end-to-end without each command
 *     re-deriving the skip set from the IdMap absences.
 *
 * Usage:
 *   npx tsx scripts/import.ts <command> [--input-dir <path>] [--target <local|staging|production>]
 *
 * @version v0.4.0
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ImportResult, ImportError, FailureReport } from "./lib/types";
import { importRepositories } from "./commands/repositories";
import { importEntities } from "./commands/entities";
import { importPlaces } from "./commands/places";
import { importEntityFunctions } from "./commands/entity-functions";
import { importDescriptions } from "./commands/descriptions";
import {
  importDescriptionEntities,
  importDescriptionPlaces,
} from "./commands/junctions";
import {
  generateTenantScopedClearSql,
  generateFtsRebuild,
} from "./commands/clear";

const DEFAULT_INPUT_DIR = "./export_catalogacion/";
const OUTPUT_DIR = ".import";

type ImportTarget = "local" | "staging" | "production";

function printUsage() {
  console.log(`Usage: tsx scripts/import.ts <command> [--input-dir <path>] [--target <env>]

Commands:
  repositories          Import repositories from JSON
  entities              Import entities from JSON
  places                Import places from JSON
  entity-functions      Import entity functions from JSON (runs entities first for FK resolution)
  descriptions          Import descriptions from JSON (runs repositories first for FK resolution)
  description-entities  Import description-entity junctions from JSON
  description-places    Import description-place junctions from JSON
  clear                 Generate tenant-scoped clear SQL (Neogranadina)
  fts-rebuild           Generate SQL to rebuild FTS5 indexes (3 tables)
  all                   Generate all SQL files in dependency order; write run-manifest + failure-report

Options:
  --input-dir <path>      Directory containing JSON export files (default: ${DEFAULT_INPUT_DIR})
  --target <env>          Forward-compat target hint (local|staging|production); recorded in run-manifest. Apply step lives in scripts/import-neogranadina.ts.
`);
}

function printResult(result: ImportResult) {
  console.log(`\n[${result.table}] Import complete:`);
  console.log(`  Total: ${result.total}`);
  console.log(`  Imported: ${result.imported}`);
  console.log(`  Skipped: ${result.skipped}`);
  console.log(`  Errors: ${result.errors.length}`);
  console.log(`  SQL files: ${result.sqlFiles.join(", ")}`);

  if (result.errors.length > 0) {
    const showCount = Math.min(result.errors.length, 10);
    console.log(`\n  First ${showCount} errors:`);
    for (let i = 0; i < showCount; i++) {
      const err = result.errors[i];
      console.log(
        `    Row ${err.row} (oldId=${err.oldId}): ${err.errors.join("; ")}`
      );
    }
    if (result.errors.length > 10) {
      console.log(`    ... and ${result.errors.length - 10} more errors`);
    }
  }
}

function parseArgs(argv: string[]): {
  command: string;
  inputDir: string;
  target?: ImportTarget;
} {
  const args = argv.slice(2);
  let command = "";
  let inputDir = DEFAULT_INPUT_DIR;
  let target: ImportTarget | undefined;

  function assignTarget(value: string) {
    if (value === "local" || value === "staging" || value === "production") {
      target = value;
    } else {
      throw new Error(
        `--target must be local|staging|production; got ${value}`,
      );
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input-dir" && i + 1 < args.length) {
      inputDir = args[i + 1];
      i++;
    } else if (arg.startsWith("--input-dir=")) {
      inputDir = arg.slice("--input-dir=".length);
    } else if (arg === "--target" && i + 1 < args.length) {
      assignTarget(args[i + 1]);
      i++;
    } else if (arg.startsWith("--target=")) {
      assignTarget(arg.slice("--target=".length));
    } else if (arg === "--help" || arg === "-h") {
      command = "help";
    } else if (!arg.startsWith("-")) {
      command = arg;
    }
  }

  return { command, inputDir, target };
}

/**
 * Aggregate one command's `errors` array into the shared FailureReport
 * keyed by table. Junction commands attach `rootCauseTable` +
 * `cascadedFrom` directly to their ImportError entries; this
 * aggregator preserves those fields verbatim so the operator sees
 * one root failure plus N cascaded skips, not N+1 unrelated entries.
 *
 * `fieldsAttempted` is left as `{}` here — the per-command builder is
 * the right place to populate it once a row-context type lands. For
 * now `validationMessages` carries enough forensic detail.
 */
function appendErrors(
  report: FailureReport,
  table: string,
  errors: ImportError[],
): void {
  if (!report[table]) report[table] = [];
  for (const e of errors) {
    const entry: FailureReport[string][number] = {
      rowIndex: e.row,
      djangoPk: e.oldId,
      fieldsAttempted: {},
      validationMessages: e.errors,
    };
    if (e.rootCauseTable !== undefined) entry.rootCauseTable = e.rootCauseTable;
    if (e.cascadedFrom !== undefined) entry.cascadedFrom = e.cascadedFrom;
    report[table].push(entry);
  }
}

/**
 * Write the per-table FailureReport to `.import/import-failures.json`.
 * Always called once at the end of `all` so the file exists even when
 * every table imported cleanly (an empty-but-present report is a
 * positive signal: the run completed and produced no failures).
 */
async function writeFailureReport(report: FailureReport): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUTPUT_DIR, "import-failures.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  const totals = Object.entries(report)
    .map(([t, errs]) => `${t}=${errs.length}`)
    .join(", ");
  console.log(
    `Failure report written: ${OUTPUT_DIR}/import-failures.json (${totals || "no failures"})`,
  );
}

/**
 * Write the per-run RunManifest to `.import/run-manifest.json`. The
 * shape mirrors `scripts/lib/types.ts:RunManifest`, but the
 * orchestrator (`scripts/import-neogranadina.ts`) is the one that
 * fills in dump-related fields; running `import.ts all` standalone
 * produces a partial record with `target` and `runId` set and the
 * dump/restore/counts fields left undefined.
 *
 * `Map` instances inside `countsBefore` / `countsAfter` are serialised
 * via the explicit `mapToObject` helper so the JSON round-trips through
 * `Object.fromEntries` cleanly when the manifest is consumed by the
 * orchestrator or by a human reading the file.
 */
async function writeRunManifest(payload: {
  runId: string;
  target?: ImportTarget;
  generatedAt: string;
  sqlFiles: string[];
  failureSummary: { table: string; count: number }[];
}): Promise<void> {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(
    path.join(OUTPUT_DIR, "run-manifest.json"),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  console.log(`Run manifest written: ${OUTPUT_DIR}/run-manifest.json`);
}

async function main() {
  const { command, inputDir, target } = parseArgs(process.argv);
  let hasErrors = false;

  switch (command) {
    case "repositories": {
      const { result } = await importRepositories(
        path.join(inputDir, "repositories.json")
      );
      printResult(result);
      if (result.errors.length > 0) hasErrors = true;
      break;
    }

    case "entities": {
      const { result } = await importEntities(
        path.join(inputDir, "entities.json")
      );
      printResult(result);
      if (result.errors.length > 0) hasErrors = true;
      break;
    }

    case "places": {
      const { result } = await importPlaces(
        path.join(inputDir, "places.json")
      );
      printResult(result);
      if (result.errors.length > 0) hasErrors = true;
      break;
    }

    case "entity-functions": {
      // Entity functions require entity IdMap for FK resolution.
      console.log("Running entities import first for FK resolution...");
      const { result: entityResult, idMap: entityIdMap } = await importEntities(
        path.join(inputDir, "entities.json")
      );
      printResult(entityResult);
      if (entityResult.errors.length > 0) hasErrors = true;

      const efResult = await importEntityFunctions(
        path.join(inputDir, "entity_functions.json"),
        entityIdMap
      );
      printResult(efResult);
      if (efResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "descriptions": {
      // Descriptions require repository IdMap for FK resolution.
      console.log("Running repositories import first for FK resolution...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      if (repoResult.errors.length > 0) hasErrors = true;

      const { result: descResult } = await importDescriptions(
        path.join(inputDir, "descriptions.json"),
        repoIdMap
      );
      printResult(descResult);
      if (descResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "description-entities": {
      // Needs entity + description IdMaps + their skippedPks Sets so
      // cascade-skip attribution propagates correctly.
      console.log("Running prerequisite imports for FK resolution...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      if (repoResult.errors.length > 0) hasErrors = true;

      const {
        result: entityResult,
        idMap: entityIdMap,
        skippedPks: entitySkippedPks,
      } = await importEntities(path.join(inputDir, "entities.json"));
      printResult(entityResult);
      if (entityResult.errors.length > 0) hasErrors = true;

      const {
        result: descResult,
        idMap: descIdMap,
        skippedPks: descSkippedPks,
      } = await importDescriptions(
        path.join(inputDir, "descriptions.json"),
        repoIdMap,
      );
      printResult(descResult);
      if (descResult.errors.length > 0) hasErrors = true;

      const deResult = await importDescriptionEntities(
        path.join(inputDir, "description_entities.json"),
        descIdMap,
        entityIdMap,
        descSkippedPks,
        entitySkippedPks,
      );
      printResult(deResult);
      if (deResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "description-places": {
      // Needs place + description IdMaps + their skippedPks Sets.
      console.log("Running prerequisite imports for FK resolution...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      if (repoResult.errors.length > 0) hasErrors = true;

      const {
        result: placeResult,
        idMap: placeIdMap,
        skippedPks: placeSkippedPks,
      } = await importPlaces(path.join(inputDir, "places.json"));
      printResult(placeResult);
      if (placeResult.errors.length > 0) hasErrors = true;

      const {
        result: descResult,
        idMap: descIdMap,
        skippedPks: descSkippedPks,
      } = await importDescriptions(
        path.join(inputDir, "descriptions.json"),
        repoIdMap,
      );
      printResult(descResult);
      if (descResult.errors.length > 0) hasErrors = true;

      const dpResult = await importDescriptionPlaces(
        path.join(inputDir, "description_places.json"),
        descIdMap,
        placeIdMap,
        descSkippedPks,
        placeSkippedPks,
      );
      printResult(dpResult);
      if (dpResult.errors.length > 0) hasErrors = true;
      break;
    }

    case "clear": {
      // Tenant-scoped Neogranadina clear.
      const sqlFiles = await generateTenantScopedClearSql();
      console.log(`\n[clear] Generated: ${sqlFiles.join(", ")}`);
      break;
    }

    case "fts-rebuild": {
      const sqlFiles = await generateFtsRebuild();
      console.log(`\n[fts-rebuild] Generated: ${sqlFiles.join(", ")}`);
      break;
    }

    case "all": {
      console.log("=== Import All: Full pipeline in FK dependency order ===\n");

      const allSqlFiles: string[] = [];
      const failureReport: FailureReport = {};
      const runId = crypto.randomUUID();
      const generatedAt = new Date().toISOString();

      // Step 1: Tenant-scoped clear SQL. Defaults to
      // NEOGRANADINA_TENANT_ID; explicit pass would override.
      console.log("Step 1/9: Generating tenant-scoped clear SQL (Neogranadina)...");
      const clearFiles = await generateTenantScopedClearSql();
      allSqlFiles.push(...clearFiles);
      console.log(`  Generated: ${clearFiles.join(", ")}`);

      // Step 2: Repositories.
      console.log("\nStep 2/9: Importing repositories...");
      const { result: repoResult, idMap: repoIdMap } =
        await importRepositories(path.join(inputDir, "repositories.json"));
      printResult(repoResult);
      allSqlFiles.push(...repoResult.sqlFiles);
      appendErrors(failureReport, "repositories", repoResult.errors);
      if (repoResult.errors.length > 0) hasErrors = true;

      // Step 3: Entities (skippedPks captured for junctions).
      console.log("\nStep 3/9: Importing entities...");
      const {
        result: entityResult,
        idMap: entityIdMap,
        skippedPks: entitySkippedPks,
      } = await importEntities(path.join(inputDir, "entities.json"));
      printResult(entityResult);
      allSqlFiles.push(...entityResult.sqlFiles);
      appendErrors(failureReport, "entities", entityResult.errors);
      if (entityResult.errors.length > 0) hasErrors = true;

      // Step 4: Places (skippedPks captured for junctions).
      console.log("\nStep 4/9: Importing places...");
      const {
        result: placeResult,
        idMap: placeIdMap,
        skippedPks: placeSkippedPks,
      } = await importPlaces(path.join(inputDir, "places.json"));
      printResult(placeResult);
      allSqlFiles.push(...placeResult.sqlFiles);
      appendErrors(failureReport, "places", placeResult.errors);
      if (placeResult.errors.length > 0) hasErrors = true;

      // Step 5: Entity functions (needs entity IdMap).
      console.log("\nStep 5/9: Importing entity functions...");
      const efResult = await importEntityFunctions(
        path.join(inputDir, "entity_functions.json"),
        entityIdMap
      );
      printResult(efResult);
      allSqlFiles.push(...efResult.sqlFiles);
      appendErrors(failureReport, "entity_functions", efResult.errors);
      if (efResult.errors.length > 0) hasErrors = true;

      // Step 6: Descriptions (needs repository IdMap; skippedPks for junctions).
      console.log("\nStep 6/9: Importing descriptions...");
      const {
        result: descResult,
        idMap: descIdMap,
        skippedPks: descSkippedPks,
      } = await importDescriptions(
        path.join(inputDir, "descriptions.json"),
        repoIdMap,
      );
      printResult(descResult);
      allSqlFiles.push(...descResult.sqlFiles);
      appendErrors(failureReport, "descriptions", descResult.errors);
      if (descResult.errors.length > 0) hasErrors = true;

      // Step 7: description_entities — pass upstream skippedPks Sets so
      // cascade-skip attribution carries the rootCauseTable +
      // cascadedFrom fields the junction command sets on its own
      // ImportError entries.
      console.log("\nStep 7/9: Importing description-entities...");
      const deResult = await importDescriptionEntities(
        path.join(inputDir, "description_entities.json"),
        descIdMap,
        entityIdMap,
        descSkippedPks,
        entitySkippedPks,
      );
      printResult(deResult);
      allSqlFiles.push(...deResult.sqlFiles);
      appendErrors(failureReport, "description_entities", deResult.errors);
      if (deResult.errors.length > 0) hasErrors = true;

      // Step 8: description_places.
      console.log("\nStep 8/9: Importing description-places...");
      const dpResult = await importDescriptionPlaces(
        path.join(inputDir, "description_places.json"),
        descIdMap,
        placeIdMap,
        descSkippedPks,
        placeSkippedPks,
      );
      printResult(dpResult);
      allSqlFiles.push(...dpResult.sqlFiles);
      appendErrors(failureReport, "description_places", dpResult.errors);
      if (dpResult.errors.length > 0) hasErrors = true;

      // Step 9: FTS5 rebuild SQL (3 lines — entities_fts, places_fts,
      // descriptions_fts; descriptions_fts had been missed by an
      // earlier clear pass and is now part of the rebuild list).
      console.log("\nStep 9/9: Generating FTS rebuild SQL...");
      const ftsFiles = await generateFtsRebuild();
      allSqlFiles.push(...ftsFiles);
      console.log(`  Generated: ${ftsFiles.join(", ")}`);

      // Aggregate failure summary for the run manifest.
      const failureSummary = Object.entries(failureReport).map(
        ([table, errs]) => ({ table, count: errs.length }),
      );

      // Always write both side files so the operator (or the
      // orchestrator) sees the run completed even when every table
      // imported cleanly. An empty-but-present import-failures.json is
      // a positive signal.
      await writeFailureReport(failureReport);
      await writeRunManifest({
        runId,
        target,
        generatedAt,
        sqlFiles: allSqlFiles,
        failureSummary,
      });

      // SQL generation only. The wrangler apply step lives in
      // scripts/import-neogranadina.ts. This script does not invoke
      // wrangler — that is the orchestrator's job, and it consumes
      // the SQL files via the run-manifest above.
      console.log("\n=== SQL generation complete ===");
      console.log("Apply via the orchestrator:");
      console.log(
        "  npx tsx scripts/import-neogranadina.ts --target=<local|staging|production>",
      );
      console.log(
        "(import.ts itself does not invoke wrangler; the apply seam is the orchestrator's responsibility.)",
      );
      break;
    }

    case "help":
    case "":
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      printUsage();
      process.exit(1);
  }

  if (hasErrors) {
    // Soft-skipped rows are aggregated in import-failures.json;
    // a non-zero exit lets the orchestrator and CI surface the run as
    // having had failures even when the SQL files themselves are
    // well-formed.
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});

// Version: v0.4.0
