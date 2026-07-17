/**
 * Tests — import commit step bodies (spec §5; stewardship spec §§2–3)
 *
 * Drives the ImportCommitWorkflow's step functions directly against the
 * real D1 harness with an in-memory staging store (the pipeline.test.ts
 * pattern), so the write path is exercised without the Workflows runtime.
 * Pins: the create round-trip (rows minted with `created_by` = the run
 * author, requeryable by natural key, each paired with a full-snapshot
 * journal row carrying null before-images), the update before-image diff
 * with an `updated_at` bump, idempotent re-run (no double insert, no double
 * journal), structural-cache recompute (an existing container's childCount
 * reconciled, journalled, and attributed), profile-version drift refusal,
 * the WRITE-DERIVED count contract (record_counts = summed step returns,
 * with an `unchanged` bucket), blank-means-keep on update, legacyIds
 * merge-append (unbound profiles leave archived identifiers untouched;
 * bound ones union without dropping), the double-submit mint mutex, and
 * the pathCache cap-and-warn.
 *
 * Fixtures are REAL SBMAL rows over the verbatim DACS headers; the
 * hierarchy fixtures add a parent-reference-code column but invent no
 * archival metadata (placeholder container codes only).
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { changelog, descriptions, importProfiles, stewardshipRuns, tenants } from "../../app/db/schema";
import { createProfile } from "../../app/lib/import/profiles.server";
import { getProfileById } from "../../app/lib/import/runs.server";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";
import { createUpload } from "../../app/lib/import/uploads.server";
import { runDryRun } from "../../app/lib/import/dry-run.server";
import { stagingKey, type StagingStore } from "../../app/lib/import/staging.server";
import { parseCsv } from "../../app/lib/import/csv";
import {
  finalizeRun,
  loadCommitConfig,
  mintImportRun,
  processCreateBatch,
  processUpdateBatch,
  recomputeStructuralCaches,
  ImportCommitConfigError,
} from "../../app/lib/import/commit.server";
import { StewardshipRunValidationError } from "../../app/lib/stewardship.server";
import { makeSbmalCsv, SBMAL_REAL_ROWS, SBMAL_DACS_BINDINGS, withBom } from "./fixtures";

function db() {
  return drizzle(env.DB);
}

function memStore(): { store: StagingStore; map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (b: unknown): Uint8Array =>
    typeof b === "string" ? enc.encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer);
  const store: StagingStore = {
    async put(key, body) {
      map.set(key, toBytes(body));
    },
    async getBytes(key) {
      return map.get(key) ?? null;
    },
    async head(key) {
      const b = map.get(key);
      return b ? { size: b.byteLength } : null;
    },
    async exists(key) {
      return map.has(key);
    },
    async delete(key) {
      map.delete(key);
    },
  };
  return { store, map };
}

/** Stage a CSV, create a profile, run the dry-run, and mint the run. */
async function setup(opts: {
  csv: string;
  bindings: unknown;
  updateExisting: boolean;
  standard?: "isadg" | "dacs" | "rad";
}) {
  const tenantId = DEFAULT_TEST_TENANT_ID;
  const standard = opts.standard ?? "isadg";
  const user = await createTestUser({ isAdmin: true, tenantId });
  const repo = await createTestRepository({ tenantId });

  const { store } = memStore();
  const uploadId = crypto.randomUUID();
  const bytes = withBom(opts.csv);
  const artifactKey = stagingKey.upload(tenantId, uploadId);
  await store.put(artifactKey, bytes);
  const parsed = parseCsv(opts.csv);
  await createUpload(db(), {
    id: uploadId,
    tenantId,
    userId: user.id,
    filename: "sbmal.csv",
    artifactKey,
    byteSize: bytes.byteLength,
    rowCount: parsed.rowCount,
    headers: parsed.headers,
  });

  const created = await createProfile(db(), {
    tenantId,
    standard,
    name: `profile-${uploadId.slice(0, 8)}`,
    bindings: opts.bindings,
    sharedWithFederation: false,
    userId: user.id,
  });
  if (!created.ok) throw new Error(`profile create failed: ${created.error}`);
  const profileId = created.id;
  const profileVersion = created.version;

  const { getUpload } = await import("../../app/lib/import/uploads.server");
  const upload = (await getUpload(db(), tenantId, uploadId))!;
  const { parseProfileBindings } = await import("../../app/lib/import/profile-schema");
  const pb = parseProfileBindings(opts.bindings);
  if (!pb.success) throw new Error("bindings invalid");

  await runDryRun({
    db: db(),
    store,
    tenantId,
    upload,
    profile: { id: profileId, version: profileVersion, bindings: pb.data },
    standard,
    updateExisting: opts.updateExisting,
  });
  const stamped = (await getUpload(db(), tenantId, uploadId))!;

  const minted = await mintImportRun(db(), {
    tenantId,
    userId: user.id,
    message: "Test import run",
    justification: "commit.server.test",
    profileId,
    profileVersion,
    sourceArtifact: stamped.artifactKey,
    reportArtifact: stamped.reportArtifact!,
    uploadId,
  });
  if (!minted) throw new Error("mint refused (upload not staged)");
  const runId = minted.runId;

  return { tenantId, userId: user.id, repositoryId: repo.id, uploadId, runId, store, profileId, profileVersion };
}

/**
 * Drive the workflow step bodies in sequence (as the Workflow would),
 * accumulating the EXECUTED counts from the step returns — the same
 * write-derived contract the Workflow implements — and finalising the run
 * with them.
 */
async function driveCommit(
  ctx: { runId: string; uploadId: string; repositoryId: string; store: StagingStore },
  updateExisting: boolean,
) {
  const config = await loadCommitConfig(db(), ctx.store, {
    runId: ctx.runId,
    uploadId: ctx.uploadId,
    repositoryId: ctx.repositoryId,
    updateExisting,
  });
  const executed = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: config.counts.skipped,
    rejected: config.counts.rejected,
    pathCacheCapped: 0,
  };
  const BS = 50;
  for (let i = 0; i < config.createCodes.length; i += BS) {
    const r = await processCreateBatch(db(), ctx.store, config, config.createCodes.slice(i, i + BS));
    executed.created += r.created;
    executed.pathCacheCapped += r.pathCacheCapped;
  }
  for (let i = 0; i < config.updateCodes.length; i += BS) {
    const r = await processUpdateBatch(db(), ctx.store, config, config.updateCodes.slice(i, i + BS));
    executed.updated += r.updated;
    executed.unchanged += r.unchanged;
  }
  await recomputeStructuralCaches(db(), config);
  await finalizeRun(db(), ctx.runId, executed);
  return { config, executed };
}

describe("import commit — create round-trip", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("mints rows with created_by, requeryable by natural key, each journalled as a create snapshot", async () => {
    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
    });

    const { executed } = await driveCommit(s, false);
    expect(executed.created).toBe(8);
    expect(executed.updated).toBe(0);
    expect(executed.unchanged).toBe(0);

    const rows = (await db()
      .select()
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all()) as Record<string, unknown>[];
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.createdBy).toBe(s.userId);
      expect(r.repositoryId).toBe(s.repositoryId);
      expect(typeof r.id).toBe("string");
    }
    const cmd1 = rows.find((r) => r.referenceCode === "CMD 1")!;
    expect(cmd1.title).toBe("Mexico. 1521-1605.");

    // Every create journalled with kind=create, runId, and null before-images.
    const journal = (await db()
      .select()
      .from(changelog)
      .where(eq(changelog.runId, s.runId))
      .all()) as { kind: string; recordId: string; diff: string; userId: string }[];
    expect(journal).toHaveLength(8);
    for (const j of journal) {
      expect(j.kind).toBe("create");
      expect(j.userId).toBe(s.userId);
      const diff = JSON.parse(j.diff) as Record<string, { old: unknown; new: unknown }>;
      expect(diff.title.old).toBeNull();
      expect(diff.referenceCode.new).toBeTruthy();
    }

    // Count contract: record_counts is the plan's predicate counts.
    const run = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, s.runId))
      .get();
    expect(run!.status).toBe("complete");
    expect(JSON.parse(run!.recordCounts!)).toMatchObject({
      created: 8,
      updated: 0,
      unchanged: 0,
      rejected: 0,
    });
  });

  it("is idempotent — re-running a create batch inserts nothing and journals nothing new", async () => {
    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
    });
    const config = await loadCommitConfig(db(), s.store, {
      runId: s.runId,
      uploadId: s.uploadId,
      repositoryId: s.repositoryId,
      updateExisting: false,
    });

    const first = await processCreateBatch(db(), s.store, config, config.createCodes);
    expect(first.created).toBe(8);
    const second = await processCreateBatch(db(), s.store, config, config.createCodes);
    expect(second.created).toBe(0);

    const rows = await db()
      .select({ id: descriptions.id })
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all();
    expect(rows).toHaveLength(8);
    const journal = await db()
      .select({ id: changelog.id })
      .from(changelog)
      .where(eq(changelog.runId, s.runId))
      .all();
    expect(journal).toHaveLength(8);
  });
});

describe("import commit — update before-images", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("updates only bound fields, bumps updated_at, journals the before-image diff", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const seeded = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      title: "Old title",
      descriptionLevel: "item",
    });

    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: true,
    });

    const { executed } = await driveCommit(s, true);
    expect(executed.updated).toBe(1);
    expect(executed.created).toBe(7);
    expect(executed.unchanged).toBe(0);

    const cmd1 = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as Record<string, unknown>;
    expect(cmd1.id).toBe(seeded.id); // same row, upsert never re-mints
    expect(cmd1.title).toBe("Mexico. 1521-1605.");
    expect(cmd1.updatedAt as number).toBeGreaterThanOrEqual(seeded.updatedAt as number);

    const updateRow = (await db()
      .select()
      .from(changelog)
      .where(and(eq(changelog.runId, s.runId), eq(changelog.recordId, seeded.id)))
      .get()) as { kind: string; diff: string };
    expect(updateRow.kind).toBe("update");
    const diff = JSON.parse(updateRow.diff) as Record<string, { old: unknown; new: unknown }>;
    expect(diff.title).toEqual({ old: "Old title", new: "Mexico. 1521-1605." });
  });
});

describe("import commit — structural-cache recompute", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reconciles an existing container's childCount and journals the change", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const parent = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "PARENT 1",
      title: "Existing container",
      descriptionLevel: "fonds",
      childCount: 0,
    });

    // Two child items into the existing container (parent by reference code).
    // Parent_Ref is an extra column makeSbmalCsv reads straight off each row.
    // isadg items require a date expression; the placeholder container
    // codes and dates below are test infrastructure, not archival records.
    const rows = [
      { Reference_Code: "CHILD 1", Title: "First child", Date_Expressed: "1700", Parent_Ref: "PARENT 1" },
      { Reference_Code: "CHILD 2", Title: "Second child", Date_Expressed: "1701", Parent_Ref: "PARENT 1" },
    ] as unknown as Parameters<typeof makeSbmalCsv>[0];
    const bindings = [
      ...SBMAL_DACS_BINDINGS,
      { source: "Parent_Ref", target: "parent" as const },
    ];
    const csv = makeSbmalCsv(rows, ["Parent_Ref"]);

    const s = await setupWithCsv({ csv, bindings, updateExisting: false });

    const { executed } = await driveCommit(s, false);
    expect(executed.created).toBe(2);

    const children = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.parentId, parent.id)))
      .all()) as Record<string, unknown>[];
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(c.depth).toBe(1);
      expect(c.rootDescriptionId).toBe(parent.id);
    }

    const parentAfter = (await db()
      .select({ childCount: descriptions.childCount, updatedBy: descriptions.updatedBy })
      .from(descriptions)
      .where(eq(descriptions.id, parent.id))
      .get()) as { childCount: number; updatedBy: string | null };
    expect(parentAfter.childCount).toBe(2);
    // The reconciled row's attribution agrees with its journal row.
    expect(parentAfter.updatedBy).toBe(s.userId);

    // The recompute journalled the parent's childCount change as an update.
    const parentJournal = (await db()
      .select()
      .from(changelog)
      .where(and(eq(changelog.runId, s.runId), eq(changelog.recordId, parent.id)))
      .get()) as { kind: string; diff: string };
    expect(parentJournal.kind).toBe("update");
    expect(JSON.parse(parentJournal.diff)).toMatchObject({
      childCount: { old: 0, new: 2 },
    });
  });
});

describe("import commit — refusals", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("mintImportRun refuses an empty run message (spec §2)", async () => {
    await expect(
      mintImportRun(db(), {
        tenantId: DEFAULT_TEST_TENANT_ID,
        userId: (await createTestUser({ isAdmin: true })).id,
        message: "   ",
        profileId: "p1",
        profileVersion: 1,
        sourceArtifact: "k",
        reportArtifact: "r",
        uploadId: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(StewardshipRunValidationError);
  });

  it("loadCommitConfig refuses a profile that drifted since the run was pinned", async () => {
    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
    });

    // Bump the profile version out from under the pinned run.
    await db()
      .update(importProfiles)
      .set({ version: s.profileVersion + 1 })
      .where(eq(importProfiles.id, s.profileId));

    await expect(
      loadCommitConfig(db(), s.store, {
        runId: s.runId,
        uploadId: s.uploadId,
        repositoryId: s.repositoryId,
        updateExisting: false,
      }),
    ).rejects.toBeInstanceOf(ImportCommitConfigError);
  });

  it("mintImportRun mints exactly once — a second mint on the same upload returns null", async () => {
    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
    });
    // `setup` already minted once (flipping the upload to committed). A
    // second mint — the double-submit race's loser — must insert NOTHING.
    const second = await mintImportRun(db(), {
      tenantId: s.tenantId,
      userId: s.userId,
      message: "Second submit of the same upload",
      profileId: s.profileId,
      profileVersion: s.profileVersion,
      sourceArtifact: "k",
      reportArtifact: "r",
      uploadId: s.uploadId,
    });
    expect(second).toBeNull();

    const runs = await db()
      .select({ id: stewardshipRuns.id })
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.tenantId, s.tenantId))
      .all();
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(s.runId);
  });
});

describe("import commit — legacyIds merge-append (never erase archived identifiers)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  // The SBMAL bindings minus BOTH legacyIds bindings — a profile that does
  // not bind legacy identifiers at all.
  const UNBOUND_BINDINGS = SBMAL_DACS_BINDINGS.filter((b) => b.target !== "legacyIds");

  it("a profile with NO legacyIds binding leaves the existing row's legacy_ids untouched", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    // Pre-existing archived identifier (test-infrastructure provenance
    // value, not archival metadata).
    const preExisting = JSON.stringify([{ provider: "django", id: "999" }]);
    const seeded = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      title: "Old title",
      descriptionLevel: "item",
    });
    await db()
      .update(descriptions)
      .set({ legacyIds: preExisting })
      .where(eq(descriptions.id, seeded.id));

    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: UNBOUND_BINDINGS,
      updateExisting: true,
    });
    await driveCommit(s, true);

    const row = (await db()
      .select({ legacyIds: descriptions.legacyIds, title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as { legacyIds: string; title: string };
    // The update landed (title changed) but the archived identifiers survive.
    expect(row.title).toBe("Mexico. 1521-1605.");
    expect(row.legacyIds).toBe(preExisting);
  });

  it("a bound profile MERGES imported entries without dropping the pre-existing entry", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const preExisting = JSON.stringify([{ provider: "django", id: "999" }]);
    const seeded = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      title: "Old title",
      descriptionLevel: "item",
    });
    await db()
      .update(descriptions)
      .set({ legacyIds: preExisting })
      .where(eq(descriptions.id, seeded.id));

    const s = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: true,
    });
    await driveCommit(s, true);

    const row = (await db()
      .select({ legacyIds: descriptions.legacyIds })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as { legacyIds: string };
    const merged = JSON.parse(row.legacyIds) as { provider: string; id: string }[];
    // Existing entry first, imported entry appended (CMD 1 carries Geiger 1).
    expect(merged).toEqual([
      { provider: "django", id: "999" },
      { provider: "former-reference-geiger", id: "Geiger 1" },
    ]);

    // The journal diff shows the honest old list -> merged list.
    const journalRow = (await db()
      .select()
      .from(changelog)
      .where(and(eq(changelog.runId, s.runId), eq(changelog.recordId, seeded.id)))
      .get()) as { diff: string };
    const diff = JSON.parse(journalRow.diff) as Record<string, { old: unknown; new: unknown }>;
    expect(diff.legacyIds.old).toBe(preExisting);
    expect(diff.legacyIds.new).toBe(row.legacyIds);
  });
});

describe("import commit — blank keeps, re-import is unchanged, counts are write-derived", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("a blank bound cell never wipes a populated field; a re-import counts unchanged and journals nothing", async () => {
    // First commit creates all 8 rows from the real file (its Extent cells
    // are blank, so extent lands NULL — blank means absent on create).
    const s1 = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
    });
    await driveCommit(s1, false);

    // A cataloguer then populates extent by hand on CMD 1.
    await db()
      .update(descriptions)
      .set({ extent: "5 boxes" })
      .where(
        and(
          eq(descriptions.tenantId, s1.tenantId),
          eq(descriptions.referenceCode, "CMD 1"),
        ),
      );

    // Re-import the SAME file with update-existing on. The blank Extent
    // cell must NOT wipe "5 boxes"; every row's assembled values match, so
    // all 8 are unchanged, nothing is written, nothing is journalled.
    const s2 = await setup({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: true,
    });
    const { executed } = await driveCommit(s2, true);
    expect(executed).toMatchObject({ created: 0, updated: 0, unchanged: 8 });

    const cmd1 = (await db()
      .select({ extent: descriptions.extent })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, s2.tenantId), eq(descriptions.referenceCode, "CMD 1")),
      )
      .get()) as { extent: string | null };
    expect(cmd1.extent).toBe("5 boxes");

    // No journal rows for the second run: the no-op wrote nothing. This
    // also pins legacyIds dedupe — the merge added no duplicate entries,
    // or the diff would have been non-empty.
    const journal = await db()
      .select({ id: changelog.id })
      .from(changelog)
      .where(eq(changelog.runId, s2.runId))
      .all();
    expect(journal).toHaveLength(0);

    // The terminal counts state the write-derived truth.
    const run = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, s2.runId))
      .get();
    expect(JSON.parse(run!.recordCounts!)).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 8,
    });
  });
});

describe("import commit — pathCache cap-and-warn", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("an over-long computed path stores '' and is counted, never failed", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    // A parent whose pathCache sits just under the cap, so appending one
    // more "/<uuid>" segment exceeds it. Synthetic path (test
    // infrastructure, not archival metadata).
    const { MAX_PATH_CACHE_LENGTH } = await import("../../app/lib/import/commit.server");
    const longPath = "x".repeat(MAX_PATH_CACHE_LENGTH - 10);
    await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "PARENT 1",
      title: "Deep container",
      descriptionLevel: "fonds",
      pathCache: longPath,
    });

    const rows = [
      { Reference_Code: "CHILD 1", Title: "Capped child", Date_Expressed: "1700", Parent_Ref: "PARENT 1" },
    ] as unknown as Parameters<typeof makeSbmalCsv>[0];
    const bindings = [
      ...SBMAL_DACS_BINDINGS,
      { source: "Parent_Ref", target: "parent" as const },
    ];
    const s = await setupWithCsv({
      csv: makeSbmalCsv(rows, ["Parent_Ref"]),
      bindings,
      updateExisting: false,
    });
    const { executed } = await driveCommit(s, false);

    expect(executed.created).toBe(1);
    expect(executed.pathCacheCapped).toBe(1);
    const child = (await db()
      .select({ pathCache: descriptions.pathCache })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CHILD 1")))
      .get()) as { pathCache: string | null };
    expect(child.pathCache).toBe("");
  });
});

describe("import commit — many-container imports stay within D1 bounds", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("commits 120 children into 120 existing containers: baselines batched, every childCount reconciled, no param-cap throw", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });

    // 120 existing containers (> the 99-param chunk bound) with stored
    // childCount 0; CONTAINER 001 additionally holds one existing child,
    // so the batched position baseline must count it. Placeholder
    // container codes are test infrastructure, not archival metadata.
    const parentIdByCode = new Map<string, string>();
    for (let i = 1; i <= 120; i++) {
      const code = `CONTAINER ${String(i).padStart(3, "0")}`;
      const row = await createTestDescription({
        tenantId,
        repositoryId: repo.id,
        referenceCode: code,
        descriptionLevel: "fonds",
        childCount: 0,
      });
      parentIdByCode.set(code, row.id);
    }
    await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "EXISTING CHILD",
      descriptionLevel: "item",
      parentId: parentIdByCode.get("CONTAINER 001")!,
      position: 0,
    });

    const rows = Array.from({ length: 120 }, (_, i) => ({
      Reference_Code: `CHILD ${String(i + 1).padStart(3, "0")}`,
      Title: `Imported child ${i + 1}`,
      Date_Expressed: "1700",
      Parent_Ref: `CONTAINER ${String(i + 1).padStart(3, "0")}`,
    })) as unknown as Parameters<typeof makeSbmalCsv>[0];
    const bindings = [
      ...SBMAL_DACS_BINDINGS,
      { source: "Parent_Ref", target: "parent" as const },
    ];
    const s = await setupWithCsv({
      csv: makeSbmalCsv(rows, ["Parent_Ref"]),
      bindings,
      updateExisting: false,
    });

    const { executed } = await driveCommit(s, false);
    expect(executed.created).toBe(120);

    // Every container reconciled to its ACTUAL child count.
    const containers = (await db()
      .select({
        referenceCode: descriptions.referenceCode,
        childCount: descriptions.childCount,
      })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenantId),
          sql`${descriptions.referenceCode} LIKE 'CONTAINER %'`,
        ),
      )
      .all()) as { referenceCode: string; childCount: number }[];
    expect(containers).toHaveLength(120);
    for (const c of containers) {
      expect(c.childCount).toBe(c.referenceCode === "CONTAINER 001" ? 2 : 1);
    }

    // The batched baseline counted CONTAINER 001's existing child: its
    // imported child lands at position 1, not 0.
    const child001 = (await db()
      .select({ position: descriptions.position })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CHILD 001")),
      )
      .get()) as { position: number };
    expect(child001.position).toBe(1);
  });
});

describe("getProfileById — tenant-scoped visibility (own or federation-shared)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function makeProfile(shared: boolean): Promise<string> {
    const user = await createTestUser({ isAdmin: true, tenantId: DEFAULT_TEST_TENANT_ID });
    const created = await createProfile(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      name: `scope-${shared ? "shared" : "private"}`,
      bindings: SBMAL_DACS_BINDINGS,
      sharedWithFederation: shared,
      userId: user.id,
    });
    if (!created.ok) throw new Error("profile create failed");
    return created.id;
  }

  it("resolves the tenant's own profile", async () => {
    const id = await makeProfile(false);
    const found = await getProfileById(db(), DEFAULT_TEST_TENANT_ID, id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(id);
  });

  it("returns null for another tenant's private profile", async () => {
    const id = await makeProfile(false);
    expect(await getProfileById(db(), SECOND_TEST_TENANT_ID, id)).toBeNull();
  });

  it("resolves a lead-owned shared profile for a federation member", async () => {
    const id = await makeProfile(true);
    // A member tenant of the Neogranadina federation (lead = the default
    // test tenant). Real tenants row: getProfileById resolves the member's
    // federation from the database, not from a context object.
    const memberId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const now = Date.now();
    await db().insert(tenants).values({
      id: memberId,
      slug: "member-scope-test",
      name: "Member Scope Test",
      descriptiveStandard: "isadg",
      federationId: NEOGRANADINA_FEDERATION_ID,
      createdAt: now,
      updatedAt: now,
    });
    const found = await getProfileById(db(), memberId, id);
    expect(found).not.toBeNull();

    // The same profile UNSHARED is invisible to the member.
    const privateId = await makeProfile(false);
    expect(await getProfileById(db(), memberId, privateId)).toBeNull();
  });
});

/**
 * A `setup` variant that takes an already-assembled CSV string (the base
 * `setup` builds one from SBMAL rows) — used by the hierarchy test which
 * injects a parent-reference-code column.
 */
async function setupWithCsv(opts: { csv: string; bindings: unknown; updateExisting: boolean }) {
  const tenantId = DEFAULT_TEST_TENANT_ID;
  const user = await createTestUser({ isAdmin: true, tenantId });
  const repo = await createTestRepository({ tenantId });
  const { store } = memStore();
  const uploadId = crypto.randomUUID();
  const bytes = withBom(opts.csv);
  const artifactKey = stagingKey.upload(tenantId, uploadId);
  await store.put(artifactKey, bytes);
  const parsed = parseCsv(opts.csv);
  await createUpload(db(), {
    id: uploadId,
    tenantId,
    userId: user.id,
    filename: "hierarchy.csv",
    artifactKey,
    byteSize: bytes.byteLength,
    rowCount: parsed.rowCount,
    headers: parsed.headers,
  });
  const created = await createProfile(db(), {
    tenantId,
    standard: "isadg",
    name: `profile-${uploadId.slice(0, 8)}`,
    bindings: opts.bindings,
    sharedWithFederation: false,
    userId: user.id,
  });
  if (!created.ok) throw new Error(`profile create failed: ${created.error}`);
  const { getUpload } = await import("../../app/lib/import/uploads.server");
  const upload = (await getUpload(db(), tenantId, uploadId))!;
  const { parseProfileBindings } = await import("../../app/lib/import/profile-schema");
  const pb = parseProfileBindings(opts.bindings);
  if (!pb.success) throw new Error("bindings invalid");
  await runDryRun({
    db: db(),
    store,
    tenantId,
    upload,
    profile: { id: created.id, version: created.version, bindings: pb.data },
    standard: "isadg",
    updateExisting: opts.updateExisting,
  });
  const stamped = (await getUpload(db(), tenantId, uploadId))!;
  const minted = await mintImportRun(db(), {
    tenantId,
    userId: user.id,
    message: "Hierarchy import",
    profileId: created.id,
    profileVersion: created.version,
    sourceArtifact: stamped.artifactKey,
    reportArtifact: stamped.reportArtifact!,
    uploadId,
  });
  if (!minted) throw new Error("mint refused (upload not staged)");
  return { tenantId, userId: user.id, repositoryId: repo.id, uploadId, runId: minted.runId, store, profileId: created.id, profileVersion: created.version };
}
