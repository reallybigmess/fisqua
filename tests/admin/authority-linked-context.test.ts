/**
 * Tests — linked-description context cards (merge/split workbenches)
 *
 * Two layers:
 *
 *   - `extractScopeSnippet` — the pure, offset-faithful snippet helper.
 *     Real archival data spells "Agustin Sanchez" in scopeContent while
 *     the junction's nameAsRecorded carries the accents ("Agustín
 *     Sánchez"); the accent-/case-insensitive match must still map back
 *     to the ORIGINAL string so the highlight shows the source spelling.
 *     Also pins the no-match / no-scope fallbacks and the window
 *     boundaries (the highlight is never split).
 *
 *   - `loadLinkedDescriptionCards` — the loader helper: one card per
 *     description even with several junction roles (multi-role
 *     grouping), the batched place + repository lookups, the
 *     nameAsRecorded anchor selection, and the honest cap totals.
 *
 * Harness mirrors tests/admin/authority-duplicates.test.ts: a Workers
 * pool with migrations applied and the default tenant/federation seeded
 * by cleanDatabase().
 *
 * @version v0.4.3
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { createTestEntity } from "../helpers/entities";
import { createTestPlace } from "../helpers/places";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import {
  extractScopeSnippet,
  buildCardSnippet,
  loadLinkedDescriptionCards,
  loadLinkedDescriptionCard,
  loadJunctionOcrText,
} from "../../app/lib/authority-linked-context.server";

// ---------------------------------------------------------------------------
// Pure helper — extractScopeSnippet
// ---------------------------------------------------------------------------

describe("extractScopeSnippet", () => {
  it("matches accent- and case-insensitively and highlights the ORIGINAL text", () => {
    const scope =
      "En el pleito seguido, Agustin Sanchez fue nombrado albacea del difunto.";
    const snippet = extractScopeSnippet(scope, "Agustín Sánchez");
    expect(snippet).not.toBeNull();
    // The highlight is the source spelling, not the accented anchor.
    expect(snippet!.match).toBe("Agustin Sanchez");
    // Offsets are faithful: the surrounding text splices back to the source.
    expect(snippet!.before + snippet!.match + snippet!.after).toBe(
      scope.slice(
        scope.indexOf(snippet!.before),
        scope.indexOf(snippet!.before) +
          (snippet!.before + snippet!.match + snippet!.after).length,
      ),
    );
    expect(snippet!.before.endsWith("seguido, ")).toBe(true);
    expect(snippet!.after.startsWith(" fue")).toBe(true);
  });

  it("is case-insensitive on the anchor", () => {
    const scope = "Consta que AGUSTIN sanchez compareció ante el escribano.";
    const snippet = extractScopeSnippet(scope, "agustín sánchez");
    expect(snippet!.match).toBe("AGUSTIN sanchez");
  });

  it("falls back to the head of scope with no highlight when the anchor is absent", () => {
    const scope =
      "Documento sobre la fundación del convento, sin mención de la persona buscada en el texto.";
    const snippet = extractScopeSnippet(scope, "Nombre Ausente");
    expect(snippet).not.toBeNull();
    expect(snippet!.match).toBe("");
    expect(snippet!.truncatedStart).toBe(false);
    expect(scope.startsWith(snippet!.before)).toBe(true);
  });

  it("returns null when there is no scopeContent", () => {
    expect(extractScopeSnippet(null, "Agustín Sánchez")).toBeNull();
    expect(extractScopeSnippet("   ", "Agustín Sánchez")).toBeNull();
  });

  it("matches decomposed (NFD) accents in the scope, consistent with normaliseName", () => {
    // Archival text is not always NFC: the accent may be stored as its own
    // combining code point. normaliseName strips such marks IN PLACE, so
    // the snippet normaliser must too — treating the mark as a word
    // separator would split "Agustin" into "Agusti n" and lose the match.
    const acute = "́";
    const nfdName = `Agusti${acute}n Sa${acute}nchez`;
    const scope = `En el pleito, ${nfdName} fue nombrado albacea.`;
    const snippet = extractScopeSnippet(scope, "Agustin Sanchez");
    expect(snippet).not.toBeNull();
    expect(snippet!.match).toBe(nfdName);
  });

  it("matches when the anchor itself is decomposed (NFD)", () => {
    const acute = "́";
    const scope = "Consta que Agustin comparecio ante el escribano.";
    const snippet = extractScopeSnippet(scope, `Agusti${acute}n`);
    expect(snippet!.match).toBe("Agustin");
  });

  it("highlights the anchor at the very end of the scope", () => {
    const scope = "El acta solo menciona a Cartagena";
    const snippet = extractScopeSnippet(scope, "Cartagena");
    expect(snippet!.match).toBe("Cartagena");
    expect(snippet!.after).toBe("");
    expect(snippet!.truncatedEnd).toBe(false);
  });

  it("keeps the highlight intact and windows both sides on a long scope", () => {
    const lead = "A".repeat(300);
    const tail = "B".repeat(300);
    const scope = `${lead} Agustin Sanchez ${tail}`;
    const snippet = extractScopeSnippet(scope, "Agustín Sánchez", 160);
    expect(snippet!.match).toBe("Agustin Sanchez");
    expect(snippet!.truncatedStart).toBe(true);
    expect(snippet!.truncatedEnd).toBe(true);
    // The window is bounded (roughly the requested size, not the whole scope).
    const total = snippet!.before.length + snippet!.match.length + snippet!.after.length;
    expect(total).toBeLessThan(220);
    expect(total).toBeGreaterThan(80);
  });
});

// ---------------------------------------------------------------------------
// Pure helper — buildCardSnippet (the ruled ladder, incl. the OCR tier)
// ---------------------------------------------------------------------------

describe("buildCardSnippet", () => {
  it("prefers a scope match; ships the full scope for Show more when longer than the window", () => {
    // Long enough that the ~160-char window truncates it — Show more then
    // reveals the whole (capped) note.
    const scope =
      "En el pleito seguido ante la real audiencia, Agustin Sanchez fue nombrado albacea del difunto y luego demandado por sus herederos, quienes alegaron que la cuenta de gastos estaba abultada y pedían su remoción del cargo con costas.";
    const snip = buildCardSnippet(scope, "irrelevant ocr", "Agustín Sánchez");
    expect(snip).not.toBeNull();
    expect(snip!.source).toBe("scope");
    expect(snip!.match).toBe("Agustin Sanchez");
    // The window is a slice; the whole note rides the payload for Show more.
    expect(snip!.truncatedEnd).toBe(true);
    expect(snip!.wide).toBe(scope);
    expect(snip!.ocrLength).toBeNull();
    expect(snip!.anchors).toEqual(["Agustín Sánchez"]);
  });

  it("leaves `wide` null when the whole scope note already fits the window", () => {
    const scope = "Consta que Agustin Sanchez compareció ante el escribano.";
    const snip = buildCardSnippet(scope, "", "Agustín Sánchez");
    expect(snip!.source).toBe("scope");
    expect(snip!.wide).toBeNull(); // nothing more to reveal
  });

  it("falls to the OCR tier when the name is absent from a scope note", () => {
    // The scope note never names the place; the transcript does — the
    // 23%-of-junctions OCR-only case.
    const scope = "Expediente sobre reparto de tierras y aguas del común.";
    const ocr =
      "f. 1 r. En la ciudad de Huanuco a los tres dias del mes de mayo compareció el testigo y declaró lo que sabía sobre el litigio.";
    const snip = buildCardSnippet(scope, ocr, "Huánuco");
    expect(snip).not.toBeNull();
    expect(snip!.source).toBe("ocr");
    expect(snip!.match).toBe("Huanuco");
    expect(snip!.ocrLength).toBe(ocr.length);
    // The wide window is capped OCR shipped with the card (or null when the
    // transcript is already within the window).
    expect(snip!.wide === null || typeof snip!.wide === "string").toBe(true);
  });

  it("falls to the head of scope when the name is in neither text", () => {
    const scope =
      "Documento sobre la fundación del convento, sin mención del lugar buscado.";
    const snip = buildCardSnippet(scope, "unrelated transcript body", "Cúcuta");
    expect(snip!.source).toBe("scope-head");
    expect(snip!.match).toBe("");
  });

  it("returns null when there is neither scope nor an OCR match", () => {
    expect(buildCardSnippet("", "", "Cúcuta")).toBeNull();
    expect(buildCardSnippet(null, null, "Cúcuta")).toBeNull();
    // Non-empty OCR but no name match, no scope → still null (OCR never
    // contributes a head-of-transcript fallback).
    expect(buildCardSnippet("", "some transcript text", "Cúcuta")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Loader — loadLinkedDescriptionCards
// ---------------------------------------------------------------------------

function db() {
  return drizzle(env.DB);
}

describe("loadLinkedDescriptionCards", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("groups a multi-role description into one card and enriches it", async () => {
    await createTestRepository({
      id: "repo-ctx",
      code: "REPO-CTX",
      name: "Archivo General de la Nación",
    });
    const entity = await createTestEntity({
      id: "ent-ctx",
      entityCode: "ne-ctx001",
      displayName: "Agustín Sánchez",
    });
    await createTestDescription({
      id: "desc-ctx",
      repositoryId: "repo-ctx",
      title: "Pleito judicial II",
      referenceCode: "co-cihjml-acc-09907",
      dateExpression: "1789",
      scopeContent:
        "En el pleito seguido, Agustin Sanchez fue nombrado albacea del difunto y luego demandado.",
    });
    // `extent` isn't exposed by the description helper — set it directly
    // to cover the loader's passthrough of the physical-description field.
    await db()
      .update(schema.descriptions)
      .set({ extent: "12 folios" })
      .where(eq(schema.descriptions.id, "desc-ctx"));
    const venue = await createTestPlace({
      id: "place-venue",
      placeCode: "nl-ven001",
      displayName: "Santafé",
    });
    const mentioned = await createTestPlace({
      id: "place-ment",
      placeCode: "nl-men001",
      displayName: "Tunja",
    });

    // Two junction rows on one description: creator + defendant.
    await db().insert(schema.descriptionEntities).values({
      id: "de-creator",
      descriptionId: "desc-ctx",
      entityId: entity.id,
      role: "creator",
      roleRaw: "creador",
      nameAsRecorded: "Agustín Sánchez",
      sequence: 0,
      createdAt: Date.now(),
    });
    await db().insert(schema.descriptionEntities).values({
      id: "de-defendant",
      descriptionId: "desc-ctx",
      entityId: entity.id,
      role: "defendant",
      sequence: 1,
      createdAt: Date.now(),
    });

    // The description's own linked places (metadata strip).
    await db().insert(schema.descriptionPlaces).values({
      id: "dp-venue",
      descriptionId: "desc-ctx",
      placeId: venue.id,
      role: "venue",
      createdAt: Date.now(),
    });
    await db().insert(schema.descriptionPlaces).values({
      id: "dp-ment",
      descriptionId: "desc-ctx",
      placeId: mentioned.id,
      role: "mentioned",
      createdAt: Date.now(),
    });

    const result = await loadLinkedDescriptionCards(db(), {
      recordType: "entity",
      ownerId: entity.id,
      displayName: entity.displayName,
    });

    expect(result.totalCards).toBe(1);
    expect(result.totalLinks).toBe(2);
    expect(result.hiddenCards).toBe(0);
    expect(result.allLinkIds.sort()).toEqual(["de-creator", "de-defendant"]);

    const card = result.cards[0];
    expect(card.roles.map((r) => r.role).sort()).toEqual([
      "creator",
      "defendant",
    ]);
    expect(card.linkIds.sort()).toEqual(["de-creator", "de-defendant"]);
    expect(card.title).toBe("Pleito judicial II");
    expect(card.referenceCode).toBe("co-cihjml-acc-09907");
    expect(card.dateExpression).toBe("1789");
    expect(card.extent).toBe("12 folios");
    expect(card.repositoryName).toBe("Archivo General de la Nación");
    // Batched place lookup returns both, with roles for the chip logic.
    const placeNames = card.places.map((p) => p.name).sort();
    expect(placeNames).toEqual(["Santafé", "Tunja"]);
    expect(card.places.find((p) => p.role === "venue")?.name).toBe("Santafé");
    // Anchor came from the nameAsRecorded row and the snippet highlights
    // the un-accented source spelling.
    expect(card.nameAsRecorded).toBe("Agustín Sánchez");
    expect(card.snippet?.match).toBe("Agustin Sanchez");
  });

  it("uses the place display name as the anchor and carries no nameAsRecorded", async () => {
    await createTestRepository({ id: "repo-p", code: "REPO-P", name: "Repo P" });
    const place = await createTestPlace({
      id: "place-anchor",
      placeCode: "nl-anc001",
      displayName: "Cartagena",
    });
    await createTestDescription({
      id: "desc-p",
      repositoryId: "repo-p",
      title: "Fundación",
      referenceCode: "co-p-001",
      scopeContent: "Relación de la ciudad de Cartagena y su puerto.",
    });
    await db().insert(schema.descriptionPlaces).values({
      id: "dp-anchor",
      descriptionId: "desc-p",
      placeId: place.id,
      role: "subject",
      createdAt: Date.now(),
    });

    const result = await loadLinkedDescriptionCards(db(), {
      recordType: "place",
      ownerId: place.id,
      displayName: place.displayName,
    });

    expect(result.totalCards).toBe(1);
    const card = result.cards[0];
    expect(card.nameAsRecorded).toBeNull();
    expect(card.snippet?.match).toBe("Cartagena");
  });

  it("caps the visible cards and reports honest totals", async () => {
    await createTestRepository({ id: "repo-cap", code: "REPO-CAP", name: "Repo Cap" });
    const entity = await createTestEntity({
      id: "ent-cap",
      entityCode: "ne-cap001",
      displayName: "Prolific Person",
    });
    for (let i = 0; i < 3; i++) {
      await createTestDescription({
        id: `desc-cap-${i}`,
        repositoryId: "repo-cap",
        title: `Doc ${i}`,
        referenceCode: `co-cap-${i}`,
      });
      await db().insert(schema.descriptionEntities).values({
        id: `de-cap-${i}`,
        descriptionId: `desc-cap-${i}`,
        entityId: entity.id,
        role: "creator",
        sequence: i,
        createdAt: Date.now(),
      });
    }

    const result = await loadLinkedDescriptionCards(db(), {
      recordType: "entity",
      ownerId: entity.id,
      displayName: entity.displayName,
      cap: 2,
    });

    expect(result.totalCards).toBe(3);
    expect(result.totalLinks).toBe(3);
    expect(result.cards.length).toBe(2);
    expect(result.hiddenCards).toBe(1);
    // Every link is reported even for hidden cards (merge moves them all).
    expect(result.allLinkIds.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Unfold panel — loadLinkedDescriptionCard + loadJunctionOcrText
// ---------------------------------------------------------------------------

describe("loadLinkedDescriptionCard (worklist unfold)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("selects the OCR tier and carries grouped entities with the current one flagged", async () => {
    await createTestRepository({ id: "repo-u", code: "REPO-U", name: "Repo U" });
    const person = await createTestEntity({
      id: "ent-u",
      entityCode: "ne-u001",
      displayName: "Huánuco Person",
    });
    const other = await createTestEntity({
      id: "ent-u2",
      entityCode: "ne-u002",
      displayName: "Otro Testigo",
    });
    await createTestDescription({
      id: "desc-u",
      repositoryId: "repo-u",
      title: "Autos seguidos",
      referenceCode: "pe-bn-cdip-01611",
      // Empty scope note: the name lives only in the transcript.
      scopeContent: "",
    });
    await db()
      .update(schema.descriptions)
      .set({
        ocrText:
          "f.1r En la ciudad, el testigo Huanuco Person declaró ante el escribano lo que le constaba del pleito.",
      })
      .where(eq(schema.descriptions.id, "desc-u"));
    const junctionId = "de-u1";
    await db().insert(schema.descriptionEntities).values({
      id: junctionId,
      descriptionId: "desc-u",
      entityId: person.id,
      role: "creator",
      nameAsRecorded: "Huánuco Person",
      sequence: 0,
      createdAt: Date.now(),
    });
    await db().insert(schema.descriptionEntities).values({
      id: "de-u2",
      descriptionId: "desc-u",
      entityId: other.id,
      role: "witness",
      sequence: 1,
      createdAt: Date.now(),
    });

    const card = await loadLinkedDescriptionCard(db(), {
      recordType: "entity",
      ownerId: person.id,
      displayName: person.displayName,
      junctionId,
    });
    expect(card).not.toBeNull();
    expect(card!.snippet?.source).toBe("ocr");
    expect(card!.snippet?.match).toBe("Huanuco Person");
    // The description's entities are grouped for the unfold panel with the
    // current entity flagged (by id, not name).
    expect(card!.entities?.length).toBe(2);
    const current = card!.entities!.find((e) => e.isCurrent);
    expect(current?.name).toBe("Huánuco Person");
    expect(card!.entities!.filter((e) => e.isCurrent)).toHaveLength(1);
  });

  it("flags the current PLACE among the description's places", async () => {
    await createTestRepository({ id: "repo-up", code: "REPO-UP", name: "Repo UP" });
    const cur = await createTestPlace({
      id: "place-cur",
      placeCode: "nl-cur01",
      displayName: "Cúcuta",
    });
    const other = await createTestPlace({
      id: "place-oth",
      placeCode: "nl-oth01",
      displayName: "Pamplona",
    });
    await createTestDescription({
      id: "desc-up",
      repositoryId: "repo-up",
      title: "Causa de tierras",
      referenceCode: "co-up-001",
      scopeContent: "Litigio de tierras entre vecinos de Cúcuta y Pamplona.",
    });
    const jid = "dp-up1";
    await db().insert(schema.descriptionPlaces).values({
      id: jid,
      descriptionId: "desc-up",
      placeId: cur.id,
      role: "subject",
      createdAt: Date.now(),
    });
    await db().insert(schema.descriptionPlaces).values({
      id: "dp-up2",
      descriptionId: "desc-up",
      placeId: other.id,
      role: "mentioned",
      createdAt: Date.now(),
    });

    const card = await loadLinkedDescriptionCard(db(), {
      recordType: "place",
      ownerId: cur.id,
      displayName: cur.displayName,
      junctionId: jid,
    });
    const flagged = card!.places.filter((p) => p.isCurrent);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].name).toBe("Cúcuta");
    expect(card!.entities).toBeUndefined();
  });

  it("returns null for a foreign junction id (IDOR-safe)", async () => {
    await createTestRepository({ id: "repo-f", code: "REPO-F", name: "Repo F" });
    const mine = await createTestPlace({ id: "place-mine", placeCode: "nl-mine1", displayName: "Mine" });
    const other = await createTestPlace({ id: "place-other", placeCode: "nl-oth2", displayName: "Other" });
    await createTestDescription({ id: "desc-f", repositoryId: "repo-f", title: "D", referenceCode: "co-f-1" });
    await db().insert(schema.descriptionPlaces).values({
      id: "dp-foreign",
      descriptionId: "desc-f",
      placeId: other.id,
      role: "subject",
      createdAt: Date.now(),
    });
    // A junction belonging to `other`, requested as `mine` → null.
    const card = await loadLinkedDescriptionCard(db(), {
      recordType: "place",
      ownerId: mine.id,
      displayName: mine.displayName,
      junctionId: "dp-foreign",
    });
    expect(card).toBeNull();
  });
});

describe("loadJunctionOcrText (Show all)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("returns the full transcript for an owned junction and null for a foreign one", async () => {
    await createTestRepository({ id: "repo-o", code: "REPO-O", name: "Repo O" });
    const mine = await createTestEntity({ id: "ent-o", entityCode: "ne-o1", displayName: "Owner" });
    const other = await createTestEntity({ id: "ent-o2", entityCode: "ne-o2", displayName: "Stranger" });
    await createTestDescription({ id: "desc-o", repositoryId: "repo-o", title: "T", referenceCode: "co-o-1" });
    const transcript = "A".repeat(4000);
    await db()
      .update(schema.descriptions)
      .set({ ocrText: transcript })
      .where(eq(schema.descriptions.id, "desc-o"));
    await db().insert(schema.descriptionEntities).values({
      id: "de-o1",
      descriptionId: "desc-o",
      entityId: mine.id,
      role: "creator",
      sequence: 0,
      createdAt: Date.now(),
    });

    const owned = await loadJunctionOcrText(db(), {
      recordType: "entity",
      ownerId: mine.id,
      junctionId: "de-o1",
    });
    expect(owned).toBe(transcript);

    // Same junction, requested by a different owner → null (IDOR-safe).
    const foreign = await loadJunctionOcrText(db(), {
      recordType: "entity",
      ownerId: other.id,
      junctionId: "de-o1",
    });
    expect(foreign).toBeNull();
  });
});
