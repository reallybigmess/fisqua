#!/usr/bin/env npx tsx
/**
 * Import Neogranadina orchestrator
 *
 * This script is the single end-to-end entry point for round 1 / round N
 * production imports. Pulls the latest Django MySQL dump from B2, restores it in
 * an ephemeral Docker mysql:8.0 container, runs export-from-mysql.ts
 * -> import.ts all -> wrangler d1 execute --file in dependency order,
 * runs the FTS5 rebuild, asserts pre/post counts, writes the
 * run-manifest + per-round summary, and emits the container teardown
 * command (keep container running by default; operator tears down
 * post-verification).
 *
 * Usage:
 *   npm run import:neogranadina -- --target=local
 *   npm run import:neogranadina -- --target=staging
 *   npm run import:neogranadina -- --target=production [--dry-run] [--rm-container]
 *
 * `--target` is MANDATORY (no default). `--dry-run` stops after SQL
 * generation; no wrangler apply happens. By default the Docker MySQL
 * container is kept running for post-mortem queries;
 * `--rm-container` opts into teardown on success.
 *
 * Between-round protocol: do not catalogue on neogranadina via Fisqua
 * between rounds — enrichment continues in zasqua-entities until
 * final cutover.
 *
 * Import-time validator enforces schema-level + sanity invariants
 * only. The descriptive-standard validator family that returns
 * DACS/RAD/ISAD(G)-specific validators is NOT applied here — that
 * targets cataloguer-authored data; this targets bulk-imported data.
 *
 * D1 targets:
 *   local      -> fisqua-db --local (sqlite file)
 *   staging    -> fisqua-staging-db --env=staging --remote (id c98e7700-0702-4e93-8c10-f1befe722260)
 *   production -> fisqua-db --remote (id 7753ef91-c06c-4827-8e30-1e79eb0e0ff5)
 *
 * Cross-tenant runtime keystone: main() splits the apply pipeline
 * into two halves around assertPostClearInvariants. After
 * applyClearOnly() flushes the tenant-scoped DELETEs,
 * snapshotCounts(target) is taken a second time and compared against
 * the pre-clear snapshot. On any of the three invariant violations
 * (non-neo-tenants-unchanged, neo-domain-zero, ancillary-unchanged)
 * the function throws, the throw propagates to main()'s top-level
 * try/catch, the orchestrator leaves the Docker container running
 * for post-mortem, and exits 1. applyInserts() never runs on a
 * violating round. This is the runtime mirror of
 * tests/import/clear-isolation.test.ts; both must pass for the round
 * to proceed.
 *
 * @version v0.4.0
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NEOGRANADINA_TENANT_ID } from "../app/lib/tenant";
import {
  snapshotCounts,
  assertPostClearInvariants,
  type ClearTarget,
} from "./commands/clear";
import type { CountSnapshot, RunManifest } from "./lib/types";

// ---------------------------------------------------------------------------
// Constants + types
// ---------------------------------------------------------------------------

interface OrchestratorOptions {
  target: ClearTarget;
  dryRun: boolean;
  rmContainer: boolean;
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const CONTAINER_NAME = `zasqua-import-${RUN_ID}`;
const HOST_PORT = 3307;
// .import/round-<run-id>/ holds per-run artefacts (manifest, summary, dump).
// The SQL files themselves stay in .import/ flat (where import.ts writes
// them) so the dependency-ordered glob in collectGeneratedSqlFiles() works
// without per-run subpath plumbing.
const WORK_DIR = path.join(".import", `round-${RUN_ID}`);
const EXPORT_DIR = path.join(WORK_DIR, "export_catalogacion");
const SQL_DIR = ".import";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    `Usage: npm run import:neogranadina -- --target=<local|staging|production> [--dry-run] [--rm-container]\n` +
      `\n` +
      `  --target=<env>     MANDATORY. Locked enum: local | staging | production. No default.\n` +
      `  --dry-run          Stop after SQL generation; print the wrangler commands the orchestrator WOULD run; no apply.\n` +
      `  --rm-container     Tear down the ephemeral Docker MySQL container on success. Default keeps it running for post-mortem queries.\n` +
      `  --help, -h         Print this usage and exit 0.\n`,
  );
}

function parseArgs(argv: string[]): OrchestratorOptions {
  const args = argv.slice(2);
  let target: ClearTarget | undefined;
  let dryRun = false;
  let rmContainer = false;

  const assignTarget = (value: string): void => {
    if (value !== "local" && value !== "staging" && value !== "production") {
      throw new Error(
        `--target must be local|staging|production; got ${value}`,
      );
    }
    target = value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--target" && i + 1 < args.length) {
      assignTarget(args[i + 1]);
      i++;
    } else if (arg.startsWith("--target=")) {
      assignTarget(arg.slice("--target=".length));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--rm-container") {
      rmContainer = true;
    } else {
      throw new Error(`Unrecognised argument: ${arg}`);
    }
  }

  if (!target) {
    throw new Error(
      "--target=<local|staging|production> is mandatory (no default)",
    );
  }
  return { target, dryRun, rmContainer };
}

// ---------------------------------------------------------------------------
// Wrangler invocation
// ---------------------------------------------------------------------------

/**
 * Construct the wrangler argv tail for a given target. database_name is
 * always passed explicitly; --env=staging and --remote are independently
 * derived from the target enum. Staging needs BOTH --env=staging AND
 * --remote (the staging deploy's D1 lives on the staging worker env,
 * not the default env's --remote). Local uses --local against the
 * sqlite file under .wrangler/state/.
 */
function wranglerArgsForTarget(target: ClearTarget, command: string): string {
  const dbName = target === "staging" ? "fisqua-staging-db" : "fisqua-db";
  const envFlag = target === "staging" ? "--env=staging " : "";
  const remoteFlag = target === "local" ? "--local" : "--remote";
  return `d1 execute ${dbName} ${envFlag}${remoteFlag} ${command}`;
}

function wrangler(args: string): string {
  return execSync(`npx wrangler ${args}`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Pre-flight tenants row check
// ---------------------------------------------------------------------------

/**
 * Verify the Neogranadina tenants row exists on the target D1 BEFORE any
 * apply runs. If the tenants table is empty for NEOGRANADINA_TENANT_ID,
 * every domain INSERT will fail with FOREIGN KEY constraint failed --
 * silently leaving the database half-populated. The pre-flight check
 * fails loudly with an explicit message pointing the operator at the
 * migrations to apply.
 */
function preflightTenantsRow(target: ClearTarget): void {
  const out = wrangler(
    wranglerArgsForTarget(
      target,
      `--command "SELECT id FROM tenants WHERE id = '${NEOGRANADINA_TENANT_ID}'" --json`,
    ),
  );
  const parsed = JSON.parse(out) as Array<{ results?: unknown[] }>;
  const rows = parsed[0]?.results ?? [];
  if (rows.length === 0) {
    const migrateCmd =
      target === "staging"
        ? "wrangler d1 migrations apply fisqua-staging-db --env=staging --remote"
        : target === "production"
          ? "wrangler d1 migrations apply fisqua-db --remote"
          : "wrangler d1 migrations apply fisqua-db --local";
    throw new Error(
      `[ABORT] tenants row missing for ${NEOGRANADINA_TENANT_ID} on ${target} D1. ` +
        `Apply migrations 0034/0035 first (${migrateCmd}).`,
    );
  }
  console.log(`OK Pre-flight: tenants row present on ${target}`);
}

// ---------------------------------------------------------------------------
// B2 dump pull + SHA-256
// ---------------------------------------------------------------------------

/**
 * Pull the latest Neogranadina dump from B2 via rclone. The bucket layout
 * is `b2:zasqua-export/backups/zasqua-YYYY-MM-DD.sql.gz`. rclone
 * lsf + sort-reverse picks the lexicographically largest filename, which
 * in ISO-8601-dated form is also the chronologically latest. SHA-256 of
 * the gzipped bytes is recorded in run-manifest.json so an operator can
 * audit which dump powered each round.
 */
async function pullLatestDump(
  workDir: string,
): Promise<{ filename: string; sha256: string }> {
  await fs.mkdir(workDir, { recursive: true });
  const list = execSync(`rclone lsf b2:zasqua-export/backups/`, {
    encoding: "utf-8",
  });
  const dumps = list
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^zasqua-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(l));
  if (dumps.length === 0) {
    throw new Error("No dumps found in b2:zasqua-export/backups/");
  }
  dumps.sort().reverse();
  const latest = dumps[0];
  console.log(`Pulling ${latest} from B2...`);
  execSync(`rclone copy "b2:zasqua-export/backups/${latest}" "${workDir}/"`, {
    stdio: "inherit",
  });
  const buf = await fs.readFile(path.join(workDir, latest));
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  console.log(`OK ${latest} (sha256 ${sha256.slice(0, 16)}...)`);
  return { filename: latest, sha256 };
}

// ---------------------------------------------------------------------------
// Docker MySQL lifecycle
// ---------------------------------------------------------------------------

/**
 * Spin an ephemeral mysql:8.0 container, wait for it to be ready (max
 * 60s), restore the gunzipped dump into the `zasqua` database. The
 * container is named zasqua-import-<run-id> so an operator inspecting
 * `docker ps` mid-run can identify which round it belongs to. The
 * container is kept running by default; operator tears it down
 * post-verification (or passes --rm-container to opt into teardown).
 */
function spinMysql(workDir: string, dumpFilename: string): void {
  console.log(`Spinning Docker MySQL container ${CONTAINER_NAME}...`);
  // Flip the post-mortem-eligibility flag BEFORE the docker run so that an
  // error inside docker run itself (port already taken, daemon down) still
  // surfaces the teardown guidance for any partially-created container.
  markContainerMayExist();
  execSync(
    `docker run -d --name ${CONTAINER_NAME} ` +
      `-e MYSQL_ROOT_PASSWORD=audit -e MYSQL_DATABASE=zasqua ` +
      `-p ${HOST_PORT}:3306 -v "${path.resolve(workDir)}:/dump" mysql:8.0`,
    { stdio: "inherit" },
  );
  console.log("Waiting for MySQL ready (max 90s)...");
  // The mysql:8.0 entrypoint runs a two-phase init: a temp server (internal
  // socket only) sets the root password, then shuts down, then the final
  // server starts on port 3306. `mysqladmin ping` returns OK during the temp
  // phase, but a real query landed in the temp-shutdown / final-start window
  // can hit `Access denied` because the grant tables aren't reloaded yet.
  // Probe with an actual SQL round-trip and require two consecutive successes
  // to guarantee we're past the handover before the restore step.
  let consecutive = 0;
  for (let i = 0; i < 90; i++) {
    try {
      execSync(
        `docker exec ${CONTAINER_NAME} mysql -uroot -paudit -e "SELECT 1" zasqua`,
        { stdio: "ignore" },
      );
      consecutive += 1;
      if (consecutive >= 2) {
        console.log("OK MySQL ready");
        break;
      }
    } catch {
      consecutive = 0;
      if (i === 89) {
        throw new Error("MySQL container failed to become ready in 90s");
      }
    }
    execSync("sleep 1");
  }
  console.log(`Restoring dump...`);
  execSync(
    `docker exec ${CONTAINER_NAME} bash -c ` +
      `"gunzip -c /dump/${dumpFilename} | mysql -uroot -paudit zasqua"`,
    { stdio: "inherit" },
  );
  console.log("OK Dump restored");
}

function tearDownContainer(rmContainer: boolean): void {
  if (rmContainer) {
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
      console.log(`OK Container ${CONTAINER_NAME} removed`);
    } catch {
      /* idempotent: container missing is not an error */
    }
  } else {
    console.log(
      `Container ${CONTAINER_NAME} kept running for post-mortem.`,
    );
    console.log(`Tear down with: docker rm -f ${CONTAINER_NAME}`);
  }
}

// ---------------------------------------------------------------------------
// SQL discovery + apply (clear / inserts split)
// ---------------------------------------------------------------------------

/**
 * Enumerate the SQL files import.ts wrote into .import/, in dependency
 * order. The prefix sequence is:
 *   clear-
 *   repositories-    (parents of descriptions)
 *   places-          (entities reference places via location FK)
 *   entities-
 *   entity_functions- (FK -> entities)
 *   descriptions-    (FK -> repositories)
 *   description_entities- (junction; FK -> descriptions + entities)
 *   description_places-   (junction; FK -> descriptions + places)
 *   fts-rebuild-     (3-FTS rebuild)
 *
 * The junction filenames use underscore-separated names that match
 * the table names.
 */
async function collectGeneratedSqlFiles(): Promise<string[]> {
  const dir = SQL_DIR;
  const all = await fs.readdir(dir).catch(() => [] as string[]);
  const ordered: string[] = [];
  const prefixOrder = [
    "clear-",
    "repositories-",
    "places-",
    "entities-",
    "entity_functions-",
    "descriptions-",
    "description_entities-",
    "description_places-",
    "fts-rebuild-",
  ];
  for (const prefix of prefixOrder) {
    const matches = all
      .filter((f) => f.startsWith(prefix) && f.endsWith(".sql"))
      .sort();
    ordered.push(...matches.map((f) => path.join(dir, f)));
  }
  return ordered;
}

/**
 * Partition the dependency-ordered SQL file list into clear-only files
 * and insert files. The boundary is where the runtime invariant check
 * fires: applyClearOnly drains clearFiles; assertPostClearInvariants
 * then runs against the post-clear count snapshot; only on passing
 * all three invariants does applyInserts drain insertFiles. A single-
 * pass applySqlFiles would have no seam to invoke the runtime
 * invariant check between the clear and the inserts.
 */
function partitionClearAndInserts(sqlFiles: string[]): {
  clearFiles: string[];
  insertFiles: string[];
} {
  const clearFiles: string[] = [];
  const insertFiles: string[] = [];
  for (const f of sqlFiles) {
    const base = path.basename(f);
    if (base.startsWith("clear-")) clearFiles.push(f);
    else insertFiles.push(f);
  }
  return { clearFiles, insertFiles };
}

interface ApplyTiming {
  file: string;
  durationMs: number;
}

async function applyClearOnly(
  target: ClearTarget,
  clearFiles: string[],
): Promise<ApplyTiming[]> {
  const timings: ApplyTiming[] = [];
  for (const file of clearFiles) {
    const start = Date.now();
    const cmd = wranglerArgsForTarget(target, `--file="${file}"`);
    console.log(`  clear: npx wrangler ${cmd}`);
    wrangler(cmd);
    const duration = Date.now() - start;
    console.log(`  OK ${file} (${duration}ms)`);
    timings.push({ file, durationMs: duration });
  }
  return timings;
}

async function applyInserts(
  target: ClearTarget,
  insertFiles: string[],
): Promise<ApplyTiming[]> {
  const timings: ApplyTiming[] = [];
  for (const file of insertFiles) {
    const start = Date.now();
    const cmd = wranglerArgsForTarget(target, `--file="${file}"`);
    console.log(`  insert: npx wrangler ${cmd}`);
    wrangler(cmd);
    const duration = Date.now() - start;
    console.log(`  OK ${file} (${duration}ms)`);
    timings.push({ file, durationMs: duration });
  }
  return timings;
}

// ---------------------------------------------------------------------------
// Per-round summary writer
// ---------------------------------------------------------------------------

interface SummaryInputs {
  workDir: string;
  target: ClearTarget;
  dumpFilename: string;
  dumpSha256: string;
  countsBefore: CountSnapshot;
  countsAfter: CountSnapshot;
  timings: ApplyTiming[];
  failureSummary: { table: string; count: number }[];
}

async function writeSummary(opts: SummaryInputs): Promise<void> {
  const before =
    opts.countsBefore.domainByTenant.get(NEOGRANADINA_TENANT_ID) ?? {
      repositories: 0,
      descriptions: 0,
      entities: 0,
      places: 0,
    };
  const after =
    opts.countsAfter.domainByTenant.get(NEOGRANADINA_TENANT_ID) ?? {
      repositories: 0,
      descriptions: 0,
      entities: 0,
      places: 0,
    };
  const tables = [
    "repositories",
    "descriptions",
    "entities",
    "places",
  ] as const;
  const countsRows = tables
    .map((t) => `| ${t} | ${before[t]} | ${after[t]} |`)
    .join("\n");
  const failuresBlock =
    opts.failureSummary.length === 0
      ? "_None._"
      : opts.failureSummary.map((f) => `- ${f.table}: ${f.count}`).join("\n");
  const timingsRows = opts.timings
    .map((t) => `| ${t.file} | ${t.durationMs} |`)
    .join("\n");

  const md = `# Neogranadina import — Round Summary (${RUN_ID})

**Target:** ${opts.target}
**Dump:** ${opts.dumpFilename}
**Dump SHA-256:** \`${opts.dumpSha256}\`

## Counts (NEOGRANADINA tenant)

| Table | Before | After |
|-------|--------|-------|
${countsRows}

## Failures

${failuresBlock}

## Apply timings

| File | ms |
|------|-----|
${timingsRows}

*Between rounds, do not catalogue on neogranadina via Fisqua — enrichment continues in zasqua-entities until final cutover.*
`;
  await fs.mkdir(opts.workDir, { recursive: true });
  await fs.writeFile(path.join(opts.workDir, "summary.md"), md, "utf8");
  console.log(`OK Summary written: ${path.join(opts.workDir, "summary.md")}`);
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  console.log(`================================================`);
  console.log(`import-neogranadina (run ${RUN_ID})`);
  console.log(
    `target=${opts.target} dryRun=${opts.dryRun} rmContainer=${opts.rmContainer}`,
  );
  console.log(`================================================`);

  // Step 1: pre-flight tenants row check.
  if (!opts.dryRun) {
    preflightTenantsRow(opts.target);
  }

  // Step 2: pull latest dump.
  const { filename: dumpFilename, sha256: dumpSha256 } =
    await pullLatestDump(WORK_DIR);

  // Step 3: spin Docker mysql + restore.
  spinMysql(WORK_DIR, dumpFilename);

  // Step 4: export from MySQL -> JSON.
  console.log("Exporting MySQL -> JSON...");
  execSync(`npx tsx scripts/export-from-mysql.ts --out-dir "${EXPORT_DIR}"`, {
    stdio: "inherit",
  });

  // Step 5: pre-clear count snapshot.
  let countsBefore: CountSnapshot;
  if (!opts.dryRun) {
    console.log("Snapshotting pre-clear counts...");
    countsBefore = await snapshotCounts(opts.target);
  } else {
    countsBefore = {
      domainByTenant: new Map(),
      ancillary: { audit_log: 0, drafts: 0, changelog: 0, comments: 0 },
    };
  }

  // Step 6: run import.ts all (generates SQL files in .import/; no apply).
  console.log("Running import.ts all (SQL generation only)...");
  execSync(
    `npx tsx scripts/import.ts all --input-dir "${EXPORT_DIR}" --target=${opts.target}`,
    { stdio: "inherit" },
  );

  // Step 7: collect generated SQL files in dependency order.
  const sqlFiles = await collectGeneratedSqlFiles();

  if (opts.dryRun) {
    console.log("Dry run: would apply these SQL files:");
    for (const f of sqlFiles) console.log(`  - ${f}`);
    console.log(`Run command would be:`);
    for (const f of sqlFiles) {
      console.log(
        `  npx wrangler ${wranglerArgsForTarget(opts.target, `--file="${f}"`)}`,
      );
    }
    tearDownContainer(opts.rmContainer);
    return;
  }

  // Step 8a: split sqlFiles into clear-only + inserts; apply clears first.
  const { clearFiles, insertFiles } = partitionClearAndInserts(sqlFiles);
  console.log("Applying clear SQL via wrangler...");
  const clearTimings = await applyClearOnly(opts.target, clearFiles);

  // Step 8b: post-clear count snapshot + invariant assertion. Any
  // failure aborts the run with a clear error and rolls back the
  // clear. assertPostClearInvariants throws on violation; the throw
  // propagates to main()'s top-level try/catch which prints the error
  // and leaves the container running for post-mortem
  // (tearDownContainer(false) on error). This is the runtime mirror
  // of tests/import/clear-isolation.test.ts — both must pass for the
  // round to continue.
  console.log("Snapshotting post-clear counts (invariant check)...");
  const postClearCounts = await snapshotCounts(opts.target);
  assertPostClearInvariants(countsBefore, postClearCounts);
  console.log(
    "OK invariants hold: cross-tenant counts unchanged; neogranadina domain counts == 0; ancillary tables unchanged.",
  );

  // Step 8c: apply inserts (repos -> places -> entities -> ef -> desc -> DE -> DP -> fts).
  console.log("Applying insert SQL via wrangler...");
  const insertTimings = await applyInserts(opts.target, insertFiles);
  const timings = [...clearTimings, ...insertTimings];

  // Step 9: post-import counts (for run-manifest + summary; not gated).
  console.log("Snapshotting post-import counts...");
  const countsAfter = await snapshotCounts(opts.target);

  // Step 10: read failure-report produced by import.ts.
  let failureSummary: { table: string; count: number }[] = [];
  try {
    const fr = JSON.parse(
      await fs.readFile(path.join(SQL_DIR, "import-failures.json"), "utf8"),
    ) as Record<string, unknown[]>;
    failureSummary = Object.entries(fr).map(([table, errs]) => ({
      table,
      count: Array.isArray(errs) ? errs.length : 0,
    }));
  } catch {
    /* no failures file is a positive signal; carry empty array */
  }

  // Step 11: write the per-round run-manifest + summary.
  const manifest: RunManifest = {
    runId: RUN_ID,
    target: opts.target,
    dumpFilename,
    dumpSha256,
    restoreTimestamp: Math.floor(Date.now() / 1000),
    containerName: CONTAINER_NAME,
    countsBefore,
    countsAfter,
    failureSummary,
  };
  // Maps don't survive JSON.stringify by default; convert to plain arrays
  // for the manifest so the round-output JSON is human-readable and the
  // RunManifest contract (CountSnapshot.domainByTenant: Map) survives the
  // in-memory return shape.
  const manifestJson = JSON.stringify(
    {
      ...manifest,
      countsBefore: serializeCountSnapshot(manifest.countsBefore),
      countsAfter: serializeCountSnapshot(manifest.countsAfter),
    },
    null,
    2,
  );
  await fs.writeFile(
    path.join(WORK_DIR, "run-manifest.json"),
    manifestJson,
    "utf8",
  );

  await writeSummary({
    workDir: WORK_DIR,
    target: opts.target,
    dumpFilename,
    dumpSha256,
    countsBefore,
    countsAfter,
    timings,
    failureSummary,
  });

  // Step 12: container teardown command (or actual teardown if --rm-container).
  tearDownContainer(opts.rmContainer);

  console.log(`================================================`);
  console.log(`Round ${RUN_ID} complete`);
  console.log(`Summary: ${path.join(WORK_DIR, "summary.md")}`);
  console.log(`Manifest: ${path.join(WORK_DIR, "run-manifest.json")}`);
  console.log(
    `Verification: see ${path.join(WORK_DIR, "summary.md")} + run admin-surface smoke checklist.`,
  );
  console.log(`================================================`);
}

/**
 * Convert a CountSnapshot to a JSON-serialisable shape (Maps -> entry
 * arrays). The orchestrator keeps the Map shape in memory because the
 * RunManifest type insists on it; the on-disk manifest uses entries
 * because Map serialisation otherwise drops to `{}`.
 */
function serializeCountSnapshot(snap: CountSnapshot): {
  domainByTenant: Array<
    [string, { repositories: number; descriptions: number; entities: number; places: number }]
  >;
  ancillary: CountSnapshot["ancillary"];
} {
  return {
    domainByTenant: Array.from(snap.domainByTenant.entries()),
    ancillary: snap.ancillary,
  };
}

/**
 * Tracks whether the orchestrator has progressed far enough that a Docker
 * container could exist. parseArgs / preflight failures must not print the
 * "Container kept running for post-mortem" guidance because no container
 * was ever spun up; spinMysql sets this flag immediately before invoking
 * `docker run`, so an error in any later step still gets the post-mortem
 * teardown guidance.
 */
let containerMayExist = false;
function markContainerMayExist(): void {
  containerMayExist = true;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    // On error, keep the container running by default for post-mortem
    // queries — the operator can inspect the MySQL state that powered
    // the failed round. Skip the guidance entirely if no container
    // was ever spun up (e.g. parseArgs / preflight failures).
    if (containerMayExist) {
      tearDownContainer(false);
    }
    process.exit(1);
  });
}

// Version: v0.4.0
