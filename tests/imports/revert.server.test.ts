/**
 * Tests — import revert step bodies (stewardship record spec §4)
 *
 * Drives the ImportRevertWorkflow's step functions directly against the
 * real D1 harness with an in-memory staging store (the commit.server.test
 * pattern), so the compensating write path is exercised without the
 * Workflows runtime. Each scenario first COMMITS an import (populating the
 * journal the revert inverts), then reverts it and asserts the outcome.
 *
 * Pins: the full create round-trip (untouched creates deleted leaf-first,
 * a hand-edited row KEPT, delete journal rows carry full pre-image
 * snapshots, the target stamped reverted_by_run_id); the update round-trip
 * (before-images restored, reverse diff journalled); revert-of-revert
 * (the original import's effects return via re-insert); a row edited
 * between run start and its batch (the edited-since test reads live
 * updated_at); a created container with foreign children skipped;
 * double-revert refused by the mint mutex; and the write-derived
 * reverted/kept counts.
 *
 * Fixtures are REAL SBMAL rows over the verbatim DACS headers; hierarchy
 * fixtures add placeholder container codes only — never invented archival
 * metadata.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, DEFAULT_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { changelog, descriptions, stewardshipRuns } from "../../app/db/schema";
import { createProfile } from "../../app/lib/import/profiles.server";
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
} from "../../app/lib/import/commit.server";
import {
  finalizeRevertRun,
  loadRevertConfig,
  mintRevertRun,
  processDeleteBatch,
  processReinsertBatch,
  processRestoreBatch,
  reconcileContainers,
  REVERT_BATCH_SIZE,
  type RevertConfig,
  type RevertCounts,
} from "../../app/lib/import/revert.server";
import { makeSbmalCsv, SBMAL_REAL_ROWS, SBMAL_DACS_BINDINGS, withBom } from "./fixtures";

function db() {
  return drizzle(env.DB);
}

function memStore(): StagingStore {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (b: unknown): Uint8Array =>
    typeof b === "string" ? enc.encode(b) : (b as Uint8Array);
  return {
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
}

/** Stage a CSV, make a profile, run the dry-run, mint the import run. */
async function setupImport(opts: {
  csv: string;
  bindings: unknown;
  updateExisting: boolean;
  store: StagingStore;
}) {
  const tenantId = DEFAULT_TEST_TENANT_ID;
  const user = await createTestUser({ isAdmin: true, tenantId });
  const repo = await createTestRepository({ tenantId });
  const uploadId = crypto.randomUUID();
  const bytes = withBom(opts.csv);
  const artifactKey = stagingKey.upload(tenantId, uploadId);
  await opts.store.put(artifactKey, bytes);
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
    store: opts.store,
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
    message: "Test import run",
    profileId: created.id,
    profileVersion: created.version,
    sourceArtifact: stamped.artifactKey,
    reportArtifact: stamped.reportArtifact!,
    uploadId,
  });
  if (!minted) throw new Error("mint refused");
  return { tenantId, userId: user.id, repositoryId: repo.id, uploadId, importRunId: minted.runId };
}

/** Drive the commit step bodies in sequence, as the Workflow would. */
async function driveCommit(
  ctx: { importRunId: string; uploadId: string; repositoryId: string; store: StagingStore },
  updateExisting: boolean,
) {
  const config = await loadCommitConfig(db(), ctx.store, {
    runId: ctx.importRunId,
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
  }
  for (let i = 0; i < config.updateCodes.length; i += BS) {
    const r = await processUpdateBatch(db(), ctx.store, config, config.updateCodes.slice(i, i + BS));
    executed.updated += r.updated;
    executed.unchanged += r.unchanged;
  }
  await recomputeStructuralCaches(db(), config);
  await finalizeRun(db(), ctx.importRunId, executed);
}

/** Mint + drive a revert run against a target, as the Workflow would. */
async function driveRevert(opts: {
  tenantId: string;
  userId: string;
  targetRunId: string;
  store: StagingStore;
  message?: string;
}): Promise<{ revertRunId: string; counts: RevertCounts } | null> {
  const minted = await mintRevertRun(db(), {
    tenantId: opts.tenantId,
    userId: opts.userId,
    message: opts.message ?? "Test revert run",
    targetRunId: opts.targetRunId,
  });
  if (!minted) return null;
  const config = await loadRevertConfig(db(), { runId: minted.runId });
  const executed: RevertCounts = {
    deleted: 0,
    restored: 0,
    reinserted: 0,
    skippedEdited: 0,
    skippedForeignChildren: 0,
    skippedConflict: 0,
  };
  const BS = REVERT_BATCH_SIZE;
  for (let i = 0; i < config.restores.length; i += BS) {
    const r = await processRestoreBatch(db(), config, config.restores.slice(i, i + BS));
    executed.restored += r.restored;
    executed.skippedEdited += r.skippedEdited;
  }
  for (let i = 0; i < config.deletes.length; i += BS) {
    const r = await processDeleteBatch(db(), config, config.deletes.slice(i, i + BS));
    executed.deleted += r.deleted;
    executed.skippedEdited += r.skippedEdited;
    executed.skippedForeignChildren += r.skippedForeignChildren;
  }
  for (let i = 0; i < config.reinserts.length; i += BS) {
    const r = await processReinsertBatch(db(), config, config.reinserts.slice(i, i + BS));
    executed.reinserted += r.reinserted;
    executed.skippedConflict += r.skippedConflict;
  }
  await reconcileContainers(db(), config);
  await finalizeRevertRun(db(), opts.store, config, executed);
  return { revertRunId: minted.runId, counts: executed };
}

describe("import revert — create round-trip", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("deletes untouched creates, keeps a hand-edited row, journals delete snapshots, stamps the target", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    // A cataloguer edits CMD 1 by hand AFTER the import (bump updated_at).
    const cmd1Before = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as Record<string, unknown>;
    await db()
      .update(descriptions)
      .set({ title: "Hand-edited title", updatedAt: (cmd1Before.updatedAt as number) + 100000 })
      .where(eq(descriptions.id, cmd1Before.id as string));

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.deleted).toBe(7);
    expect(result.counts.skippedEdited).toBe(1);
    expect(result.counts.restored).toBe(0);

    // Only the hand-edited CMD 1 survives, with its edit intact.
    const remaining = (await db()
      .select()
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all()) as Record<string, unknown>[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].referenceCode).toBe("CMD 1");
    expect(remaining[0].title).toBe("Hand-edited title");

    // The revert journalled 7 delete rows with full pre-image snapshots.
    const revertJournal = (await db()
      .select()
      .from(changelog)
      .where(eq(changelog.runId, result.revertRunId))
      .all()) as { kind: string; diff: string }[];
    expect(revertJournal).toHaveLength(7);
    for (const j of revertJournal) {
      expect(j.kind).toBe("delete");
      const diff = JSON.parse(j.diff) as Record<string, { old: unknown; new: unknown }>;
      expect(diff.title.new).toBeNull();
      expect(diff.referenceCode.old).toBeTruthy();
    }

    // Target stamped reverted_by_run_id; revert run complete with counts.
    const target = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, s.importRunId))
      .get();
    expect(target!.revertedByRunId).toBe(result.revertRunId);
    const revertRun = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, result.revertRunId))
      .get();
    expect(revertRun!.status).toBe("complete");
    expect(revertRun!.revertsRunId).toBe(s.importRunId);
    expect(JSON.parse(revertRun!.recordCounts!)).toMatchObject({ deleted: 7, skippedEdited: 1 });
    // The report artefact pointer is stamped.
    expect(revertRun!.reportArtifact).toBeTruthy();
    const report = JSON.parse(
      new TextDecoder().decode((await store.getBytes(revertRun!.reportArtifact!))!),
    );
    expect(report).toMatchObject({ reverted: 7, kept: 1 });
  });
});

describe("import revert — update round-trip (restore before-images)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("restores an updated row to its pre-run values and journals the reverse diff", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    const seeded = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      title: "Old title",
      descriptionLevel: "item",
    });

    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: true,
      store,
    });
    // Reuse the seeded repo's tenant; the import updates CMD 1, creates 7.
    await driveCommit({ ...s, store }, true);

    const afterImport = (await db()
      .select({ title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as { title: string };
    expect(afterImport.title).toBe("Mexico. 1521-1605.");

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(result.counts.restored).toBe(1);
    expect(result.counts.deleted).toBe(7);

    // CMD 1 restored to its pre-run title; the row still exists (not deleted).
    const restored = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "CMD 1")))
      .get()) as Record<string, unknown>;
    expect(restored.id).toBe(seeded.id);
    expect(restored.title).toBe("Old title");

    // The revert journalled an update row whose reverse diff restores the old.
    const updateRow = (await db()
      .select()
      .from(changelog)
      .where(and(eq(changelog.runId, result.revertRunId), eq(changelog.recordId, seeded.id)))
      .get()) as { kind: string; diff: string };
    expect(updateRow.kind).toBe("update");
    expect(JSON.parse(updateRow.diff)).toMatchObject({
      title: { old: "Mexico. 1521-1605.", new: "Old title" },
    });
  });
});

describe("import revert — revert-of-revert re-applies the original", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reverting a revert re-creates the rows the import created", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    // Revert 1 deletes all 8.
    const rev1 = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(rev1.counts.deleted).toBe(8);
    expect(
      (await db().select().from(descriptions).where(eq(descriptions.tenantId, s.tenantId)).all()),
    ).toHaveLength(0);

    // Revert 2 targets rev1 (a revert) and re-inserts all 8.
    const rev2 = (await driveRevert({
      ...s,
      store,
      targetRunId: rev1.revertRunId,
      message: "Undo the revert",
    }))!;
    expect(rev2.counts.reinserted).toBe(8);

    const back = (await db()
      .select()
      .from(descriptions)
      .where(eq(descriptions.tenantId, s.tenantId))
      .all()) as Record<string, unknown>[];
    expect(back).toHaveLength(8);
    const cmd1 = back.find((r) => r.referenceCode === "CMD 1")!;
    expect(cmd1.title).toBe("Mexico. 1521-1605.");
    expect(cmd1.createdBy).toBe(s.userId); // original attribution preserved

    // rev1 is now stamped reverted-by rev2.
    const rev1Row = await db()
      .select()
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, rev1.revertRunId))
      .get();
    expect(rev1Row!.revertedByRunId).toBe(rev2.revertRunId);
  });
});

describe("import revert — concurrency + refusals", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("skips a row edited between run start and its delete batch (edited-since reads live updated_at)", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    // Mint + plan the revert (run start), THEN edit a row before its batch.
    const minted = (await mintRevertRun(db(), {
      tenantId: s.tenantId,
      userId: s.userId,
      message: "Revert with a mid-flight edit",
      targetRunId: s.importRunId,
    }))!;
    const config = await loadRevertConfig(db(), { runId: minted.runId });

    const cmd2 = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")))
      .get()) as Record<string, unknown>;
    await db()
      .update(descriptions)
      .set({ title: "Edited mid-revert", updatedAt: (cmd2.updatedAt as number) + 100000 })
      .where(eq(descriptions.id, cmd2.id as string));

    let deleted = 0;
    let skippedEdited = 0;
    for (let i = 0; i < config.deletes.length; i += REVERT_BATCH_SIZE) {
      const r = await processDeleteBatch(db(), config, config.deletes.slice(i, i + REVERT_BATCH_SIZE));
      deleted += r.deleted;
      skippedEdited += r.skippedEdited;
    }
    expect(deleted).toBe(7);
    expect(skippedEdited).toBe(1);

    const survivor = await db()
      .select({ title: descriptions.title })
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, s.tenantId), eq(descriptions.referenceCode, "CMD 2")))
      .get();
    expect(survivor!.title).toBe("Edited mid-revert");
  });

  it("skips a created container that acquired a foreign child", async () => {
    const store = memStore();
    const tenantId = DEFAULT_TEST_TENANT_ID;
    // Import creates a parent container P and a child C beneath it (both
    // via the run). Placeholder container codes — not archival records.
    // PARENT 1 is a file-level container (light isadg requirements — the
    // identity 4 + a date, like items — and able to hold children).
    const rows = [
      { Reference_Code: "PARENT 1", Title: "Container", Date_Expressed: "1700", Format: "file" },
      { Reference_Code: "CHILD 1", Title: "Child item", Date_Expressed: "1701", Parent_Ref: "PARENT 1" },
    ] as unknown as Parameters<typeof makeSbmalCsv>[0];
    const bindings = [
      ...SBMAL_DACS_BINDINGS.filter((b) => b.target !== "descriptionLevel"),
      { source: "Format", target: "descriptionLevel" as const, transform: { kind: "defaultWhenBlank" as const, default: "item" } },
      { source: "Parent_Ref", target: "parent" as const },
    ];
    const s = await setupImport({
      csv: makeSbmalCsv(rows, ["Parent_Ref"]),
      bindings,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);

    const parent = (await db()
      .select()
      .from(descriptions)
      .where(and(eq(descriptions.tenantId, tenantId), eq(descriptions.referenceCode, "PARENT 1")))
      .get()) as Record<string, unknown>;

    // A foreign child F is added under P OUTSIDE the run.
    await createTestDescription({
      tenantId,
      repositoryId: s.repositoryId,
      parentId: parent.id as string,
      referenceCode: "FOREIGN 1",
      title: "Foreign child",
      descriptionLevel: "item",
      depth: 1,
    });

    const result = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    // CHILD 1 deleted (leaf); PARENT 1 kept — it has a foreign child.
    expect(result.counts.deleted).toBe(1);
    expect(result.counts.skippedForeignChildren).toBe(1);

    const survivors = (await db()
      .select({ referenceCode: descriptions.referenceCode })
      .from(descriptions)
      .where(eq(descriptions.tenantId, tenantId))
      .all()) as { referenceCode: string }[];
    const codes = survivors.map((r) => r.referenceCode).sort();
    expect(codes).toEqual(["FOREIGN 1", "PARENT 1"]);
  });

  it("refuses a second revert of the same target (the mint mutex)", async () => {
    const store = memStore();
    const s = await setupImport({
      csv: makeSbmalCsv(SBMAL_REAL_ROWS),
      bindings: SBMAL_DACS_BINDINGS,
      updateExisting: false,
      store,
    });
    await driveCommit({ ...s, store }, false);
    const first = (await driveRevert({ ...s, store, targetRunId: s.importRunId }))!;
    expect(first).toBeTruthy();

    // A second revert of the same (now-reverted) target mints nothing.
    const second = await mintRevertRun(db(), {
      tenantId: s.tenantId,
      userId: s.userId,
      message: "Second revert of the same target",
      targetRunId: s.importRunId,
    });
    expect(second).toBeNull();

    const revertRuns = await db()
      .select({ id: stewardshipRuns.id })
      .from(stewardshipRuns)
      .where(and(eq(stewardshipRuns.tenantId, s.tenantId), eq(stewardshipRuns.kind, "revert")))
      .all();
    expect(revertRuns).toHaveLength(1);
  });
});

describe("reconcileContainers — many containers stay within D1 bounds", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("reconciles 120 containers' childCounts without a param-cap throw", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const user = await createTestUser({ isAdmin: true, tenantId });
    const repo = await createTestRepository({ tenantId });

    // 120 containers (> the 99-param chunk bound), each holding ONE child
    // but storing a deliberately wrong childCount. Placeholder codes are
    // test infrastructure, not archival metadata.
    const parentIds: string[] = [];
    for (let i = 1; i <= 120; i++) {
      const parent = await createTestDescription({
        tenantId,
        repositoryId: repo.id,
        referenceCode: `RC ${String(i).padStart(3, "0")}`,
        descriptionLevel: "fonds",
        childCount: 5,
      });
      await createTestDescription({
        tenantId,
        repositoryId: repo.id,
        referenceCode: `RC ${String(i).padStart(3, "0")} CHILD`,
        descriptionLevel: "item",
        parentId: parent.id,
      });
      parentIds.push(parent.id);
    }

    const runId = crypto.randomUUID();
    const config = {
      runId,
      targetRunId: crypto.randomUUID(),
      tenantId,
      userId: user.id,
      restores: [],
      deletes: [],
      reinserts: [],
      affectedParentIds: parentIds,
      totalSteps: 1,
    } as RevertConfig;

    const { reconciled } = await reconcileContainers(db(), config);
    expect(reconciled).toBe(120);

    const parents = (await db()
      .select({ childCount: descriptions.childCount })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenantId),
          eq(descriptions.descriptionLevel, "fonds"),
          sql`${descriptions.referenceCode} LIKE 'RC %'`,
        ),
      )
      .all()) as { childCount: number }[];
    expect(parents).toHaveLength(120);
    for (const p of parents) expect(p.childCount).toBe(1);

    // Every reconciliation journalled under the run.
    const journal = await db()
      .select({ id: changelog.id })
      .from(changelog)
      .where(eq(changelog.runId, runId))
      .all();
    expect(journal).toHaveLength(120);
  });
});
