/**
 * Tests — readiness-check server: compute/cache, decisions, drift, commit
 *
 * Over the real D1 harness with an in-memory staging store (the dry-run.test
 * pattern). Pins: findings computed and cached on the upload row pinned to
 * (profileId, profileVersion) and reused on a cache hit; accept/undo decision
 * mutations and the gate they drive; the profile-version drift reset of all
 * decisions; and the commit path reading acceptances from the upload row —
 * `mintImportRun` copies `check_decisions` verbatim into the run's
 * `accepted_findings`, and `loadCommitConfig` re-derives verdicts under those
 * acceptances so a row that rejects without acceptance instead creates.
 *
 * Fixtures are REAL SBMAL rows over the verbatim DACS headers (every item is
 * missing extent under DACS — one decision class).
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { applyMigrations, cleanDatabase, DACS_TEST_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { importUploads, stewardshipRuns } from "../../app/db/schema";
import { parseProfileBindings } from "../../app/lib/import/profile-schema";
import { parseCsv } from "../../app/lib/import/csv";
import { createProfile } from "../../app/lib/import/profiles.server";
import {
  createUpload,
  getUpload,
  setUploadProfile,
} from "../../app/lib/import/uploads.server";
import { stagingKey, type StagingStore } from "../../app/lib/import/staging.server";
import {
  computeAndCacheFindings,
  acceptDecision,
  undoDecision,
  deriveAcceptedClasses,
  parseDecisions,
  gateState,
} from "../../app/lib/import/check.server";
import type { DecisionFinding } from "../../app/lib/import/check";
import { loadCommitConfig, mintImportRun } from "../../app/lib/import/commit.server";
import { makeSbmalCsv, SBMAL_REAL_ROWS, SBMAL_DACS_BINDINGS, withBom } from "./fixtures";

function db() {
  return drizzle(env.DB);
}

function memStore(): { store: StagingStore; map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const toBytes = (b: any): Uint8Array =>
    typeof b === "string" ? enc.encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
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

function bindings() {
  const parsed = parseProfileBindings(SBMAL_DACS_BINDINGS);
  if (!parsed.success) throw new Error("fixture bindings invalid");
  return parsed.data;
}

async function stage(tenantId: string, csv: string) {
  const { store, map } = memStore();
  const user = await createTestUser({ isAdmin: true, tenantId });
  const uploadId = crypto.randomUUID();
  const bytes = withBom(csv);
  const artifactKey = stagingKey.upload(tenantId, uploadId);
  await store.put(artifactKey, bytes);
  const parsed = parseCsv(csv);
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
  return { store, map, uploadId, userId: user.id, artifactKey };
}

const fresh = async (tenantId: string, uploadId: string) =>
  (await getUpload(db(), tenantId, uploadId))!;

const TENANT = DACS_TEST_TENANT_ID;
const EXTENT_CLASS = "missing_required_field:item:extent";

describe("computeAndCacheFindings — compute, cache, reuse", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("computes the item-extent decision class and caches it pinned to the profile", async () => {
    const { store, uploadId } = await stage(TENANT, makeSbmalCsv(SBMAL_REAL_ROWS));
    const state = await computeAndCacheFindings({
      db: db(),
      store,
      tenantId: TENANT,
      upload: await fresh(TENANT, uploadId),
      standard: "dacs",
      profile: { id: "p1", version: 1, bindings: bindings() },
    });
    expect(state.decisionsTotal).toBe(1);
    expect(state.unlocked).toBe(false);
    const decision = state.findings.find(
      (f): f is DecisionFinding => f.kind === "decision",
    )!;
    expect(decision.classKeys).toEqual([EXTENT_CLASS]);
    expect(decision.count).toBe(8);

    const row = await fresh(TENANT, uploadId);
    const cache = JSON.parse(row.checkFindings!);
    expect(cache.profileId).toBe("p1");
    expect(cache.profileVersion).toBe(1);
  });

  it("reuses the cache while the pin matches (same computedAt)", async () => {
    const { store, uploadId } = await stage(TENANT, makeSbmalCsv(SBMAL_REAL_ROWS));
    const first = await computeAndCacheFindings({
      db: db(),
      store,
      tenantId: TENANT,
      upload: await fresh(TENANT, uploadId),
      standard: "dacs",
      profile: { id: "p1", version: 1, bindings: bindings() },
    });
    const second = await computeAndCacheFindings({
      db: db(),
      store,
      tenantId: TENANT,
      upload: await fresh(TENANT, uploadId),
      standard: "dacs",
      profile: { id: "p1", version: 1, bindings: bindings() },
    });
    expect(second.computedAt).toBe(first.computedAt);
  });
});

describe("decisions — accept, undo, gate", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function computed(uploadId: string, store: StagingStore, version = 1) {
    return computeAndCacheFindings({
      db: db(),
      store,
      tenantId: TENANT,
      upload: await fresh(TENANT, uploadId),
      standard: "dacs",
      profile: { id: "p1", version, bindings: bindings() },
    });
  }

  it("accepting the class unlocks the gate; undoing re-locks it", async () => {
    const { store, uploadId, userId } = await stage(TENANT, makeSbmalCsv(SBMAL_REAL_ROWS));
    const state = await computed(uploadId, store);
    const decision = state.findings.find(
      (f): f is DecisionFinding => f.kind === "decision",
    )!;

    await acceptDecision(
      db(),
      TENANT,
      await fresh(TENANT, uploadId),
      {
        key: decision.key,
        classKeys: decision.classKeys,
        level: decision.level,
        fields: decision.fields,
        count: decision.count,
        cascadeCount: decision.cascadeCount,
      },
      userId,
    );

    const afterAccept = parseDecisions((await fresh(TENANT, uploadId)).checkDecisions);
    expect(afterAccept).toHaveLength(1);
    expect(afterAccept[0].acceptedBy).toBe(userId);
    expect([...deriveAcceptedClasses(afterAccept)]).toContain(EXTENT_CLASS);
    expect(gateState(state.findings, afterAccept, 0).unlocked).toBe(true);

    await undoDecision(db(), TENANT, await fresh(TENANT, uploadId), decision.key);
    const afterUndo = parseDecisions((await fresh(TENANT, uploadId)).checkDecisions);
    expect(afterUndo).toHaveLength(0);
    expect(gateState(state.findings, afterUndo, 0).unlocked).toBe(false);
  });

  it("resets all decisions on profile-version drift", async () => {
    const { store, uploadId, userId } = await stage(TENANT, makeSbmalCsv(SBMAL_REAL_ROWS));
    const v1 = await computed(uploadId, store, 1);
    const decision = v1.findings.find(
      (f): f is DecisionFinding => f.kind === "decision",
    )!;
    await acceptDecision(
      db(),
      TENANT,
      await fresh(TENANT, uploadId),
      {
        key: decision.key,
        classKeys: decision.classKeys,
        level: decision.level,
        fields: decision.fields,
        count: decision.count,
        cascadeCount: decision.cascadeCount,
      },
      userId,
    );
    expect(parseDecisions((await fresh(TENANT, uploadId)).checkDecisions)).toHaveLength(1);

    // Recompute under a new profile version — the pin drifts, decisions reset.
    const v2 = await computed(uploadId, store, 2);
    expect(v2.decisionsMade).toBe(0);
    expect(parseDecisions((await fresh(TENANT, uploadId)).checkDecisions)).toHaveLength(0);
  });
});

describe("commit — acceptances travel from the upload row", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("snapshots check_decisions into the run and creates the accepted-sparse rows", async () => {
    const { store, uploadId, userId, artifactKey } = await stage(
      TENANT,
      makeSbmalCsv(SBMAL_REAL_ROWS),
    );
    const repo = await createTestRepository({ tenantId: TENANT });

    const profile = await createProfile(db(), {
      tenantId: TENANT,
      standard: "dacs",
      name: "SBMAL DACS",
      bindings: SBMAL_DACS_BINDINGS,
      sharedWithFederation: false,
      userId,
    });
    if (!profile.ok) throw new Error("profile create failed");
    await setUploadProfile(db(), TENANT, uploadId, {
      profileId: profile.id,
      profileVersion: profile.version,
    });

    // Compute findings against the real profile, then accept the extent class.
    const state = await computeAndCacheFindings({
      db: db(),
      store,
      tenantId: TENANT,
      upload: await fresh(TENANT, uploadId),
      standard: "dacs",
      profile: { id: profile.id, version: profile.version, bindings: bindings() },
    });
    const decision = state.findings.find(
      (f): f is DecisionFinding => f.kind === "decision",
    )!;
    await acceptDecision(
      db(),
      TENANT,
      await fresh(TENANT, uploadId),
      {
        key: decision.key,
        classKeys: decision.classKeys,
        level: decision.level,
        fields: decision.fields,
        count: decision.count,
        cascadeCount: decision.cascadeCount,
      },
      userId,
    );

    const decisionsJson = (await fresh(TENANT, uploadId)).checkDecisions;

    const minted = await mintImportRun(db(), {
      tenantId: TENANT,
      userId,
      message: "SBMAL import",
      profileId: profile.id,
      profileVersion: profile.version,
      sourceArtifact: artifactKey,
      reportArtifact: stagingKey.report(TENANT, uploadId),
      uploadId,
    });
    expect(minted).not.toBeNull();

    // The run carries the acceptances verbatim (the atomic mint copy).
    const run = await db()
      .select({ accepted: stewardshipRuns.acceptedFindings })
      .from(stewardshipRuns)
      .where(eq(stewardshipRuns.id, minted!.runId))
      .get();
    expect(JSON.parse(run!.accepted!)).toEqual(JSON.parse(decisionsJson!));

    // loadCommitConfig re-derives verdicts under those acceptances — every
    // item that would reject on extent now creates (design §4).
    const config = await loadCommitConfig(db(), store, {
      runId: minted!.runId,
      uploadId,
      repositoryId: repo.id,
      updateExisting: false,
    });
    expect(config.acceptedClasses).toContain(EXTENT_CLASS);
    expect(config.createCodes).toContain("CMD 1");
    expect(config.counts.created).toBe(8);
    expect(config.counts.rejected).toBe(0);

    // The upload flipped to committed at mint.
    const row = await db()
      .select({ status: importUploads.status })
      .from(importUploads)
      .where(and(eq(importUploads.id, uploadId), eq(importUploads.tenantId, TENANT)))
      .get();
    expect(row!.status).toBe("committed");
  });
});
