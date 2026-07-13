/**
 * Tests — autosave
 *
 * This suite covers the server-side contract of `saveDescription` from
 * `app/lib/description.server.ts`. The contract: `saveDescription`
 * is ADDITIVE — it writes only the columns whose keys are present
 * in the incoming `fields` object, and never nulls a column just
 * because its key was absent. Explicit `null` values in the input
 * are still honoured, so a caller can clear a field on purpose.
 * The tests below pin that contract from three angles: a single-
 * field save preserves all other populated fields, an empty-fields
 * save is a no-op on the data (timestamps may move), and
 * `{ key: null }` does null the column.
 *
 * The two `title`-column tests pin a smoke-finding: editing the
 * description editor's "Title *" input cycled the save-status pill
 * but never landed on disk because `title` was missing from the
 * server's `DESCRIPTION_FIELD_KEYS` allowlist. The tests assert
 * that (a) a single-key `{ title }` save writes `entries.title` and
 * (b) the additive contract holds for the newly-allowed key:
 * editing `title` alone does not null any of the other ten
 * description columns.
 *
 * @version v0.4.1
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
} from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import { DEFAULT_TEST_TENANT_ID, applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { saveDescription } from "../../app/lib/description.server";

describe("Description autosave (DESC-06)", () => {
  let db: ReturnType<typeof drizzle>;
  let entryId: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });

    const user = await createTestUser({ isAdmin: false });
    const now = Date.now();

    const projectId = crypto.randomUUID();
    const volumeId = crypto.randomUUID();
    entryId = crypto.randomUUID();

    await db.insert(schema.projects).values({
      id: projectId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      name: "Test Project",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.projectMembers).values({
      id: crypto.randomUUID(),
      projectId,
      userId: user.id,
      role: "cataloguer",
      createdAt: now,
    });

    await db.insert(schema.volumes).values({
      id: volumeId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      projectId,
      name: "Test Volume",
      referenceCode: "co-test-vol001",
      manifestUrl: "https://example.com/manifest.json",
      pageCount: 10,
      status: "approved",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(schema.entries).values({
      id: entryId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      volumeId,
      position: 0,
      startPage: 1,
      startY: 0,
      type: "item",
      descriptionStatus: "in_progress",
      assignedDescriber: user.id,
      createdAt: now,
      updatedAt: now,
    });
  });

  test("saveDescription persists a single field change", async () => {
    await saveDescription(db, entryId, { scopeContent: "New content" });

    const [entry] = await db
      .select({ scopeContent: schema.entries.scopeContent })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.scopeContent).toBe("New content");
  });

  test("saveDescription applies the keys present in the fields object and leaves untouched columns alone", async () => {
    // Seed the entry with several description fields populated.
    await saveDescription(db, entryId, {
      translatedTitle: "Original title",
      scopeContent: "Original content",
      language: "es",
      extent: "12 folios",
      dateExpression: "1540",
    });

    // Save with a single field — only that field should change.
    await saveDescription(db, entryId, { scopeContent: "Updated content" });

    const [after] = await db
      .select({
        translatedTitle: schema.entries.translatedTitle,
        scopeContent: schema.entries.scopeContent,
        language: schema.entries.language,
        extent: schema.entries.extent,
        dateExpression: schema.entries.dateExpression,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    // The edited field changed.
    expect(after.scopeContent).toBe("Updated content");
    // Every other previously populated field is untouched.
    expect(after.translatedTitle).toBe("Original title");
    expect(after.language).toBe("es");
    expect(after.extent).toBe("12 folios");
    expect(after.dateExpression).toBe("1540");
  });

  test("preserves omitted fields across a partial save (B1 regression)", async () => {
    // Additive-contract regression guard. An earlier version of
    // saveDescription wrote `fields.X ?? null` for every column, so
    // editing a single field on the description editor nulled every
    // other field on the entry. This test pins the additive
    // contract: seed all ten description columns, then write one
    // field, and assert every other column survives unchanged.
    await saveDescription(db, entryId, {
      translatedTitle: "Title",
      resourceType: "texto",
      dateExpression: "1540",
      dateStart: "1540-01-01",
      dateEnd: "1540-12-31",
      extent: "12 folios",
      scopeContent: "Scope and content",
      language: "es",
      descriptionNotes: "Description notes",
      internalNotes: "Internal notes",
    });

    // Edit only `scopeContent`.
    await saveDescription(db, entryId, { scopeContent: "Edited scope" });

    const [after] = await db
      .select({
        translatedTitle: schema.entries.translatedTitle,
        resourceType: schema.entries.resourceType,
        dateExpression: schema.entries.dateExpression,
        dateStart: schema.entries.dateStart,
        dateEnd: schema.entries.dateEnd,
        extent: schema.entries.extent,
        scopeContent: schema.entries.scopeContent,
        language: schema.entries.language,
        descriptionNotes: schema.entries.descriptionNotes,
        internalNotes: schema.entries.internalNotes,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    // The edited field landed.
    expect(after.scopeContent).toBe("Edited scope");
    // All nine other fields are intact — no column nulled because its
    // key was absent from the partial payload.
    expect(after.translatedTitle).toBe("Title");
    expect(after.resourceType).toBe("texto");
    expect(after.dateExpression).toBe("1540");
    expect(after.dateStart).toBe("1540-01-01");
    expect(after.dateEnd).toBe("1540-12-31");
    expect(after.extent).toBe("12 folios");
    expect(after.language).toBe("es");
    expect(after.descriptionNotes).toBe("Description notes");
    expect(after.internalNotes).toBe("Internal notes");
  });

  test("explicit null in the fields object DOES null the column (absent vs explicit-null distinction)", async () => {
    // Pin the second half of the additive contract: only ABSENT keys
    // are preserved. A caller that explicitly writes `{ key: null }`
    // is asking to clear the column, and saveDescription must honour
    // that — otherwise there is no way to clear a field on purpose.
    await saveDescription(db, entryId, {
      translatedTitle: "Will be cleared",
      scopeContent: "Will be preserved",
    });

    await saveDescription(db, entryId, { translatedTitle: null });

    const [after] = await db
      .select({
        translatedTitle: schema.entries.translatedTitle,
        scopeContent: schema.entries.scopeContent,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after.translatedTitle).toBeNull();
    // `scopeContent` was absent from the second call — must be preserved.
    expect(after.scopeContent).toBe("Will be preserved");
  });

  test("empty fields object is a data no-op (no column written, timestamp may move)", async () => {
    await saveDescription(db, entryId, {
      scopeContent: "Untouched",
      language: "es",
    });

    await saveDescription(db, entryId, {});

    const [after] = await db
      .select({
        scopeContent: schema.entries.scopeContent,
        language: schema.entries.language,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after.scopeContent).toBe("Untouched");
    expect(after.language).toBe("es");
  });

  test("saveDescription updates the updatedAt timestamp", async () => {
    const [before] = await db
      .select({ updatedAt: schema.entries.updatedAt })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    const originalUpdatedAt = before.updatedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    await saveDescription(db, entryId, { language: "en" });

    const [after] = await db
      .select({ updatedAt: schema.entries.updatedAt })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after.updatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  test("sequential saves apply latest values (last-write-wins)", async () => {
    await saveDescription(db, entryId, {
      scopeContent: "Version A",
      language: "es",
    });

    await saveDescription(db, entryId, {
      scopeContent: "Version B",
      language: "es",
    });

    const [entry] = await db
      .select({ scopeContent: schema.entries.scopeContent })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(entry.scopeContent).toBe("Version B");
  });

  test("title persists across a partial save (smoke-finding)", async () => {
    // Smoke-finding regression guard (live browser smoke,
    // 2026-05-17): typing into the description editor's "Title *"
    // input cycled the save-status pill but the value never landed
    // in entries.title on disk. Root cause: `title` was missing
    // from the server's DESCRIPTION_FIELD_KEYS allowlist (and from
    // the client's buildFieldsPayload, fixed separately). This
    // test pins the
    // server-side half of the contract: a single-key { title } save
    // writes entries.title and preserves every other description
    // field that was seeded.
    await saveDescription(db, entryId, {
      title: "seed title",
      translatedTitle: "seed translated",
      scopeContent: "seed scope",
    });

    await saveDescription(db, entryId, { title: "new title from editor" });

    const [after] = await db
      .select({
        title: schema.entries.title,
        translatedTitle: schema.entries.translatedTitle,
        scopeContent: schema.entries.scopeContent,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after.title).toBe("new title from editor");
    expect(after.translatedTitle).toBe("seed translated");
    expect(after.scopeContent).toBe("seed scope");
  });

  test("title save preserves every other description field (smoke-finding)", async () => {
    // Re-pin the B1 additive contract for the newly-allowed `title`
    // key: editing only `title` does not null any of the other ten
    // description columns. Mirrors "preserves omitted fields across a
    // partial save (B1 regression)" above, but with `title` as the
    // edited key — proving that widening the allowlist did not
    // introduce a back-door that re-nulls the rest of the form.
    await saveDescription(db, entryId, {
      title: "Original title",
      translatedTitle: "Original translated",
      resourceType: "texto",
      dateExpression: "1540",
      dateStart: "1540-01-01",
      dateEnd: "1540-12-31",
      extent: "12 folios",
      scopeContent: "Scope and content",
      language: "es",
      descriptionNotes: "Description notes",
      internalNotes: "Internal notes",
    });

    await saveDescription(db, entryId, { title: "Edited title" });

    const [after] = await db
      .select({
        title: schema.entries.title,
        translatedTitle: schema.entries.translatedTitle,
        resourceType: schema.entries.resourceType,
        dateExpression: schema.entries.dateExpression,
        dateStart: schema.entries.dateStart,
        dateEnd: schema.entries.dateEnd,
        extent: schema.entries.extent,
        scopeContent: schema.entries.scopeContent,
        language: schema.entries.language,
        descriptionNotes: schema.entries.descriptionNotes,
        internalNotes: schema.entries.internalNotes,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, entryId))
      .all();

    expect(after.title).toBe("Edited title");
    expect(after.translatedTitle).toBe("Original translated");
    expect(after.resourceType).toBe("texto");
    expect(after.dateExpression).toBe("1540");
    expect(after.dateStart).toBe("1540-01-01");
    expect(after.dateEnd).toBe("1540-12-31");
    expect(after.extent).toBe("12 folios");
    expect(after.scopeContent).toBe("Scope and content");
    expect(after.language).toBe("es");
    expect(after.descriptionNotes).toBe("Description notes");
    expect(after.internalNotes).toBe("Internal notes");
  });
});
