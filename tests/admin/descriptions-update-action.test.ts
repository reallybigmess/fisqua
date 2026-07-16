/**
 * Tests — descriptions admin update action (characterization)
 *
 * This suite drives real FormData through the `_auth.admin.
 * descriptions.$id` update action and pins its write contract before
 * and after the field-registration consolidation (audit item 12): the
 * ~40 description columns flow from formData through the
 * standard-aware validator into the DB write, with a handful of
 * deliberate coercions (genre defaults to "[]", ocrText to "",
 * resourceType is enum-gated to null) that must survive any
 * refactor of the three parallel registration blocks.
 *
 * Harness mirrors tests/admin/vocab-merge-split-action.test.ts.
 *
 * @version v0.4.2
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Instantiate the route module graph at file load so the in-test
// `await import()` resolves from a warm module cache. A cold route-graph
// import inside a timed test body can exceed testTimeout when this file
// is scheduled late against a saturated Workers-pool module runner on a
// resource-constrained (2-core CI) runner.
import "../../app/routes/_auth.admin.descriptions.$id";

function buildContext(user: User): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: user.tenantId }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

// A complete update payload for a fonds-level record under ISAD(G):
// every mandatory column filled, plus distinct sentinel values on the
// optional columns so per-column persistence is assertable.
function fullUpdateFields(repoId: string): Record<string, string> {
  return {
    _action: "update",
    title: "Fondo Cabildo de Tunja",
    descriptionLevel: "fonds",
    localIdentifier: "loc-upd-1",
    repositoryId: repoId,
    translatedTitle: "Cabildo of Tunja Fonds",
    uniformTitle: "Cabildo (uniform)",
    resourceType: "text",
    genre: '["actas"]',
    dateExpression: "1580-1810",
    dateStart: "1580",
    dateEnd: "1810",
    dateCertainty: "approximate",
    extent: "42 legajos",
    dimensions: "30 x 21 cm",
    medium: "papel",
    provenance: "Cabildo de Tunja",
    scopeContent: "Actas y acuerdos del cabildo.",
    ocrText: "texto ocr",
    arrangement: "Cronológico",
    accessConditions: "Sin restricciones",
    reproductionConditions: "Cita obligatoria",
    language: "es",
    locationOfOriginals: "AHRB",
    locationOfCopies: "Copias en microfilm",
    findingAids: "Índice mecanografiado",
    notes: "Nota pública",
    internalNotes: "Nota interna",
    imprint: "Imprenta del Cabildo",
    editionStatement: "1a ed.",
    seriesStatement: "Serie municipal",
    volumeNumber: "3",
    issueNumber: "7",
    pages: "245",
    sectionTitle: "Sección colonial",
    publicationTitle: "Gaceta",
    adminBiogHistory: "Historia administrativa del cabildo.",
    acquisitionInfo: "Transferencia 1954",
    preferredCitation: "AHRB, Fondo Cabildo",
    systemOfArrangement: "Por series",
    physicalCharacteristics: "Deterioro leve",
    creatorDisplay: "Cabildo de Tunja",
    iiifManifestUrl: "https://iiif.example.test/manifest.json",
    hasDigital: "on",
  };
}

async function runUpdate(
  user: User,
  descriptionId: string,
  fields: Record<string, string>,
) {
  const { action } = await import(
    "../../app/routes/_auth.admin.descriptions.$id"
  );
  const body = new URLSearchParams(fields);
  return (await action({
    request: new Request(
      `http://neogranadina.fisqua.test/admin/descriptions/${descriptionId}`,
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    ),
    context: buildContext(user),
    params: { id: descriptionId },
  } as any)) as any;
}

async function seedAdminAndDescription() {
  const admin = makeUserContext({ isAdmin: true });
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.users).values({
    id: admin.id,
    tenantId: admin.tenantId,
    email: "admin-dua@example.test",
    isAdmin: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const repoId = crypto.randomUUID();
  await createTestRepository({ id: repoId, code: "TEST" });
  const desc = await createTestDescription({
    descriptionLevel: "fonds",
    title: "Original Title",
    repositoryId: repoId,
  });
  return { admin, db, descId: desc.id as string, repoId };
}

describe("descriptions admin update action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists every field of a full update", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const res = await runUpdate(admin, descId, fullUpdateFields(repoId));
    expect(res).toEqual({ ok: true, message: "updated" });

    const row = await db
      .select()
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row).toBeDefined();
    expect(row!.title).toBe("Fondo Cabildo de Tunja");
    expect(row!.descriptionLevel).toBe("fonds");
    expect(row!.localIdentifier).toBe("loc-upd-1");
    expect(row!.translatedTitle).toBe("Cabildo of Tunja Fonds");
    expect(row!.uniformTitle).toBe("Cabildo (uniform)");
    expect(row!.resourceType).toBe("text");
    expect(row!.genre).toBe('["actas"]');
    expect(row!.dateExpression).toBe("1580-1810");
    expect(row!.dateStart).toBe("1580");
    expect(row!.dateEnd).toBe("1810");
    expect(row!.dateCertainty).toBe("approximate");
    expect(row!.extent).toBe("42 legajos");
    expect(row!.dimensions).toBe("30 x 21 cm");
    expect(row!.medium).toBe("papel");
    expect(row!.provenance).toBe("Cabildo de Tunja");
    expect(row!.scopeContent).toBe("Actas y acuerdos del cabildo.");
    expect(row!.ocrText).toBe("texto ocr");
    expect(row!.arrangement).toBe("Cronológico");
    expect(row!.accessConditions).toBe("Sin restricciones");
    expect(row!.reproductionConditions).toBe("Cita obligatoria");
    expect(row!.language).toBe("es");
    expect(row!.locationOfOriginals).toBe("AHRB");
    expect(row!.locationOfCopies).toBe("Copias en microfilm");
    expect(row!.findingAids).toBe("Índice mecanografiado");
    expect(row!.notes).toBe("Nota pública");
    expect(row!.internalNotes).toBe("Nota interna");
    expect(row!.imprint).toBe("Imprenta del Cabildo");
    expect(row!.editionStatement).toBe("1a ed.");
    expect(row!.seriesStatement).toBe("Serie municipal");
    expect(row!.volumeNumber).toBe("3");
    expect(row!.issueNumber).toBe("7");
    expect(row!.pages).toBe("245");
    expect(row!.sectionTitle).toBe("Sección colonial");
    expect(row!.publicationTitle).toBe("Gaceta");
    expect(row!.adminBiogHistory).toBe("Historia administrativa del cabildo.");
    expect(row!.acquisitionInfo).toBe("Transferencia 1954");
    expect(row!.preferredCitation).toBe("AHRB, Fondo Cabildo");
    expect(row!.systemOfArrangement).toBe("Por series");
    expect(row!.physicalCharacteristics).toBe("Deterioro leve");
    expect(row!.creatorDisplay).toBe("Cabildo de Tunja");
    expect(row!.iiifManifestUrl).toBe(
      "https://iiif.example.test/manifest.json",
    );
    expect(row!.hasDigital).toBe(true);
  });

  it("coerces absent genre to [] and absent ocrText to empty string", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    delete fields.genre;
    delete fields.ocrText;
    delete fields.resourceType;
    const res = await runUpdate(admin, descId, fields);
    expect(res).toEqual({ ok: true, message: "updated" });

    const row = await db
      .select({
        genre: schema.descriptions.genre,
        ocrText: schema.descriptions.ocrText,
        resourceType: schema.descriptions.resourceType,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.genre).toBe("[]");
    expect(row!.ocrText).toBe("");
    expect(row!.resourceType).toBeNull();
  });

  it("rejects an invalid resourceType at the validator (never silently nulled)", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    fields.resourceType = "not-a-real-type";
    const res = await runUpdate(admin, descId, fields);

    expect(res.ok).toBe(false);
    expect(res.errors?.resourceType?.length).toBeGreaterThan(0);

    const row = await db
      .select({ title: schema.descriptions.title })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.title).toBe("Original Title");
  });

  it("returns field-scoped errors when mandatory fields are missing", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    fields.extent = "";
    fields.scopeContent = "";
    const res = await runUpdate(admin, descId, fields);

    expect(res.ok).toBe(false);
    expect(res.errors?.extent?.[0]).toBe("field_required");
    expect(res.errors?.scopeContent?.[0]).toBe("field_required");

    const row = await db
      .select({ title: schema.descriptions.title })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.title).toBe("Original Title");
  });

  it("clearing a populated optional column writes NULL, not a stale value", async () => {
    const { admin, db, descId, repoId } = await seedAdminAndDescription();

    // Populate dimensions and medium first.
    let res = await runUpdate(admin, descId, fullUpdateFields(repoId));
    expect(res).toEqual({ ok: true, message: "updated" });

    // Then submit the same update with both fields cleared. The
    // validator sees them as absent (empty maps to undefined), but the
    // DB write must carry the null — updatedFields derives from the
    // raw record, not the validator payload, precisely so a cleared
    // field clears its column instead of being silently omitted from
    // the UPDATE and keeping its old value.
    const cleared = fullUpdateFields(repoId);
    cleared.dimensions = "";
    cleared.medium = "";
    res = await runUpdate(admin, descId, cleared);
    expect(res).toEqual({ ok: true, message: "updated" });

    const row = await db
      .select({
        dimensions: schema.descriptions.dimensions,
        medium: schema.descriptions.medium,
      })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.id, descId))
      .get();
    expect(row!.dimensions).toBeNull();
    expect(row!.medium).toBeNull();
  });

  it("returns the conflict payload on a stale optimistic lock", async () => {
    const { admin, descId, repoId } = await seedAdminAndDescription();

    const fields = fullUpdateFields(repoId);
    fields._updatedAt = "1";
    const res = await runUpdate(admin, descId, fields);

    expect(res.ok).toBe(false);
    expect(res.error).toBe("conflict");
    expect(res).toHaveProperty("modifiedBy");
    expect(res).toHaveProperty("modifiedAt");
  });
});
