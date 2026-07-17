/**
 * Tests — stewardship journal + run-envelope helpers
 *
 * Covers `app/lib/stewardship.server.ts`:
 *
 *   - the per-kind diff shapers (pure): createSnapshotDiff,
 *     deleteSnapshotDiff, linkDiff, unlinkDiff — asserting the spec §3
 *     payload contract;
 *   - batch atomicity: a mutation and its journal row, composed into
 *     one `db.batch([...])`, land together or not at all (the ledger
 *     discipline, spec §3);
 *   - DB-level immutability: the migration-0063 RAISE(ABORT) triggers
 *     reject UPDATE and DELETE on a journal row (the harness installs
 *     the production triggers);
 *   - run minting: composeRunInsert validates a non-empty message at
 *     the helper level (not only the DB CHECK) and mints a `pending`
 *     run row.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  applyMigrations,
  cleanDatabase,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
} from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import {
  composeJournalEntry,
  composeRunInsert,
  createSnapshotDiff,
  deleteSnapshotDiff,
  linkDiff,
  unlinkDiff,
  computeDiff,
  StewardshipRunValidationError,
} from "../../app/lib/stewardship.server";

const db = () => drizzle(env.DB, { schema });

// ---------------------------------------------------------------------------
// Diff shapers (pure — no DB)
// ---------------------------------------------------------------------------

describe("stewardship diff shapers", () => {
  it("createSnapshotDiff wraps every field as { old: null, new }", () => {
    const diff = createSnapshotDiff({ title: "Fondo A", position: 3, notes: null });
    expect(diff).toEqual({
      title: { old: null, new: "Fondo A" },
      position: { old: null, new: 3 },
      notes: { old: null, new: null },
    });
  });

  it("deleteSnapshotDiff wraps every field as { old, new: null }", () => {
    const diff = deleteSnapshotDiff({ title: "Fondo A", position: 3, notes: null });
    expect(diff).toEqual({
      title: { old: "Fondo A", new: null },
      position: { old: 3, new: null },
      notes: { old: null, new: null },
    });
  });

  it("createSnapshotDiff of an empty row is an empty diff", () => {
    expect(createSnapshotDiff({})).toEqual({});
  });

  it("linkDiff returns the junction row's content verbatim (copy, not reference)", () => {
    const junction = {
      id: "de-1",
      descriptionId: "desc-1",
      entityId: "ent-1",
      role: "author",
      roleNote: null,
      sequence: 0,
    };
    const diff = linkDiff(junction);
    expect(diff).toEqual(junction);
    // A copy: mutating the source must not change the shaped diff.
    junction.role = "subject";
    expect((diff as { role: string }).role).toBe("author");
  });

  it("unlinkDiff returns the removed junction row's full content", () => {
    const junction = {
      id: "dp-9",
      descriptionId: "desc-1",
      placeId: "place-2",
      role: "creation",
      roleNote: "verbatim",
    };
    expect(unlinkDiff(junction)).toEqual(junction);
  });

  it("computeDiff (re-exported) drives the 'update' payload - changed fields only", () => {
    const diff = computeDiff(
      { title: "old", scopeContent: "same" },
      { title: "new", scopeContent: "same" },
    );
    expect(diff).toEqual({ title: { old: "old", new: "new" } });
  });
});

// ---------------------------------------------------------------------------
// Run minting — validation (pure)
// ---------------------------------------------------------------------------

describe("composeRunInsert - message validation", () => {
  it("rejects an empty message before touching the DB", () => {
    expect(() =>
      composeRunInsert(db(), {
        tenantId: DEFAULT_TEST_TENANT_ID,
        kind: "import",
        message: "",
        userId: OPERATOR_TEST_USER_ID,
      }),
    ).toThrow(StewardshipRunValidationError);
  });

  it("rejects a whitespace-only message", () => {
    expect(() =>
      composeRunInsert(db(), {
        tenantId: DEFAULT_TEST_TENANT_ID,
        kind: "revert",
        message: "   \t\n  ",
        userId: OPERATOR_TEST_USER_ID,
      }),
    ).toThrow(StewardshipRunValidationError);
  });

  it("accepts a non-empty message and returns a fresh id", () => {
    const a = composeRunInsert(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      kind: "import",
      message: "SBMAL master catalogue, batch 1",
      userId: OPERATOR_TEST_USER_ID,
    });
    const b = composeRunInsert(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      kind: "import",
      message: "SBMAL master catalogue, batch 1",
      userId: OPERATOR_TEST_USER_ID,
    });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
  });
});

// ---------------------------------------------------------------------------
// Journal composition — batch atomicity (DB)
// ---------------------------------------------------------------------------

describe("composeJournalEntry - batch atomicity", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedOperatorUser();
  });

  async function seedDescription() {
    const repo = await createTestRepository();
    const desc = await createTestDescription({
      repositoryId: repo.id,
      title: "Original title",
    });
    return desc;
  }

  it("mutation + journal row commit together in one db.batch", async () => {
    const desc = await seedDescription();
    const now = Date.now();

    await db().batch([
      db()
        .update(schema.descriptions)
        .set({ title: "Edited title", updatedAt: now })
        .where(eq(schema.descriptions.id, desc.id)),
      composeJournalEntry(db(), {
        recordId: desc.id,
        recordType: "description",
        userId: OPERATOR_TEST_USER_ID,
        kind: "update",
        diff: computeDiff({ title: "Original title" }, { title: "Edited title" })!,
        note: "fixing a typo",
        now,
      }),
    ]);

    const row = await db()
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, desc.id))
      .get();
    expect(row!.title).toBe("Edited title");

    const journal = await db()
      .select()
      .from(schema.changelog)
      .where(eq(schema.changelog.recordId, desc.id))
      .all();
    expect(journal).toHaveLength(1);
    expect(journal[0].kind).toBe("update");
    expect(journal[0].note).toBe("fixing a typo");
    expect(journal[0].runId).toBeNull();
    expect(JSON.parse(journal[0].diff)).toEqual({
      title: { old: "Original title", new: "Edited title" },
    });
  });

  it("a failing statement rolls back BOTH the mutation and the journal row", async () => {
    const desc = await seedDescription();
    const dupId = "collision-journal-id";

    // The batch's last two statements both claim the same PK; the
    // second violates it, so D1 aborts the whole batch. The title
    // update and the (valid) journal row must not survive.
    await expect(
      db().batch([
        db()
          .update(schema.descriptions)
          .set({ title: "SHOULD_NOT_PERSIST" })
          .where(eq(schema.descriptions.id, desc.id)),
        db().insert(schema.changelog).values({
          id: dupId,
          recordId: desc.id,
          recordType: "description",
          userId: OPERATOR_TEST_USER_ID,
          diff: "{}",
          kind: "update",
          createdAt: Date.now(),
        }),
        db().insert(schema.changelog).values({
          id: dupId,
          recordId: desc.id,
          recordType: "description",
          userId: OPERATOR_TEST_USER_ID,
          diff: "{}",
          kind: "update",
          createdAt: Date.now(),
        }),
      ]),
    ).rejects.toThrow();

    const row = await db()
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, desc.id))
      .get();
    expect(row!.title).toBe("Original title");

    const journal = await db().select().from(schema.changelog).all();
    expect(journal).toHaveLength(0);
  });

  it("stamps runId when the write is caused by a run", async () => {
    const desc = await seedDescription();
    const runId = "run-abc";

    await db().batch([
      composeJournalEntry(db(), {
        recordId: desc.id,
        recordType: "description",
        userId: OPERATOR_TEST_USER_ID,
        kind: "create",
        diff: createSnapshotDiff({ title: "Original title" }),
        runId,
      }),
    ]);

    const journal = await db()
      .select()
      .from(schema.changelog)
      .where(eq(schema.changelog.recordId, desc.id))
      .get();
    expect(journal!.runId).toBe(runId);
    expect(journal!.kind).toBe("create");
    expect(JSON.parse(journal!.diff)).toEqual({
      title: { old: null, new: "Original title" },
    });
  });
});

// ---------------------------------------------------------------------------
// Journal immutability — the append-only triggers (DB)
// ---------------------------------------------------------------------------

describe("changelog journal - immutability", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedOperatorUser();
  });

  async function insertJournalRow() {
    await db().batch([
      composeJournalEntry(db(), {
        recordId: "rec-immutable",
        recordType: "description",
        userId: OPERATOR_TEST_USER_ID,
        kind: "update",
        diff: { title: { old: "a", new: "b" } },
        now: 1000,
      }),
    ]);
    const row = await db()
      .select()
      .from(schema.changelog)
      .where(eq(schema.changelog.recordId, "rec-immutable"))
      .get();
    return row!.id;
  }

  it("rejects UPDATE (BEFORE UPDATE trigger fires)", async () => {
    const id = await insertJournalRow();
    await expect(
      db()
        .update(schema.changelog)
        .set({ note: "tampered" })
        .where(eq(schema.changelog.id, id)),
    ).rejects.toThrow();
    const row = await db()
      .select()
      .from(schema.changelog)
      .where(eq(schema.changelog.id, id))
      .get();
    expect(row!.note).toBeNull();
  });

  it("rejects DELETE (BEFORE DELETE trigger fires)", async () => {
    const id = await insertJournalRow();
    await expect(
      db().delete(schema.changelog).where(eq(schema.changelog.id, id)),
    ).rejects.toThrow();
    const rows = await db()
      .select()
      .from(schema.changelog)
      .where(eq(schema.changelog.id, id))
      .all();
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Run minting — persistence (DB)
// ---------------------------------------------------------------------------

describe("composeRunInsert - persistence", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
    await seedOperatorUser();
  });

  it("mints an import run as pending with the required message and attribution", async () => {
    const { id, statement } = composeRunInsert(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      federationId: DEFAULT_TEST_FEDERATION_ID,
      kind: "import",
      message: "SBMAL master catalogue, batch 1",
      justification: "Initial migration from FileMaker",
      userId: OPERATOR_TEST_USER_ID,
      profileId: "profile-x",
      profileVersion: 2,
      sourceArtifact: "b2://staging/sbmal.csv",
    });
    await db().batch([statement]);

    const run = await db()
      .select()
      .from(schema.stewardshipRuns)
      .where(eq(schema.stewardshipRuns.id, id))
      .get();
    expect(run).toBeTruthy();
    expect(run!.kind).toBe("import");
    expect(run!.status).toBe("pending");
    expect(run!.message).toBe("SBMAL master catalogue, batch 1");
    expect(run!.justification).toBe("Initial migration from FileMaker");
    expect(run!.userId).toBe(OPERATOR_TEST_USER_ID);
    expect(run!.tenantId).toBe(DEFAULT_TEST_TENANT_ID);
    expect(run!.profileVersion).toBe(2);
    expect(run!.revertsRunId).toBeNull();
    expect(run!.revertedByRunId).toBeNull();
  });

  it("minting alone writes NOTHING - the row exists only after the statement lands in a batch", async () => {
    // Contract pin for the two-part { id, statement } return: the id is
    // for the Workflow launch and revert linkage, but an un-batched
    // Drizzle insert builder is a no-op. A caller that uses the id and
    // drops the statement has minted a run that does not exist.
    const { id, statement } = composeRunInsert(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      kind: "import",
      message: "Minted but not yet batched",
      userId: OPERATOR_TEST_USER_ID,
    });

    const before = await db()
      .select()
      .from(schema.stewardshipRuns)
      .where(eq(schema.stewardshipRuns.id, id))
      .get();
    expect(before).toBeUndefined();

    await db().batch([statement]);

    const after = await db()
      .select()
      .from(schema.stewardshipRuns)
      .where(eq(schema.stewardshipRuns.id, id))
      .get();
    expect(after).toBeTruthy();
    expect(after!.message).toBe("Minted but not yet batched");
  });

  it("mints a revert run linked to its target", async () => {
    const { id, statement } = composeRunInsert(db(), {
      tenantId: DEFAULT_TEST_TENANT_ID,
      kind: "revert",
      message: "Reverting batch 1 — wrong date parsing",
      userId: OPERATOR_TEST_USER_ID,
      revertsRunId: "target-run-id",
    });
    await db().batch([statement]);

    const run = await db()
      .select()
      .from(schema.stewardshipRuns)
      .where(eq(schema.stewardshipRuns.id, id))
      .get();
    expect(run!.kind).toBe("revert");
    expect(run!.revertsRunId).toBe("target-run-id");
  });
});
