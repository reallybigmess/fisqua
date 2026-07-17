/**
 * Import starter profiles — code-level definitions, not seeded rows
 *
 * This module deals with the pre-built mapping profiles the profile-pick
 * surface offers for the export formats archives ALREADY HOLD (spec §8).
 * A starter is a versioned CODE definition, never a database row: picking
 * one MINTS a normal per-tenant `import_profiles` row from the definition
 * (starter_key stamped, version 1, createdBy = the picking admin, name =
 * `defaultName`). The unique `(tenantId, name)` index governs — a tenant
 * mints the same starter twice only under a different name. Editing a
 * definition here never mutates already-minted profiles.
 *
 * PROVENANCE GAP ON RECORD (ruled acceptable for v1): the definition
 * `version` below is NOT persisted on minted rows — only `starter_key`
 * is. Minted profiles are independent copies, so definition updates can
 * never corrupt them, but a minted row cannot say WHICH definition
 * version it came from. Revisit deliberately in phase 8 / stewardship
 * stage 2 if mint provenance needs to be reconstructable.
 *
 * BINDING DISCIPLINE (every binding traces to a verified header source;
 * nothing is guessed). Sources cited per starter below:
 *
 *   - AtoM ISAD(G) CSV — `research/2026-07-11-imports-formats-research.md`
 *     §1 (verbatim ISAD(G) template header row; legacyId/parentId
 *     hierarchy; pipe-delimited multi-values).
 *   - AGN FUID — same doc §4 "Colombia — AGN's Formato Único de
 *     Inventario Documental" (verbatim row-level column table; Acuerdo
 *     042/2002).
 *   - EAP — `research/2026-07-12-eap-meap-templates.md` §1 (the "2.
 *     Description" worksheet, 51 columns verbatim; §1.7 ISAD 3.x mapping
 *     table is the binding authority; §1.3 Level vocabulary; §1.4 date
 *     conventions; §1.6 delimiter split).
 *   - MEAP — same doc §2 (the `Template` tab, 36 columns verbatim; §2.7
 *     Fisqua-union mapping; §2.5 Resource Type vocabulary; §2.6 pipe
 *     delimiter).
 *
 * Where the research documents a controlled value set, a `vocabulary`
 * transform remaps it; otherwise a column is direct-copied to its mapped
 * target, and a column with NO documented target is left UNBOUND and named
 * in the per-starter comment as awaiting evidence — never guessed. The
 * NO-FileMaker ruling stands (SBMAL is a bespoke one-off, not a starter).
 *
 * STANDARDS FIT is two-layered: a starter's `standards` list is the ruled
 * fit (AtoM ISAD(G)/EAP/FUID → isadg; MEAP → isadg + dacs, item-level and
 * cross-standard by design), and `startersForStandard` additionally
 * requires every binding target to be valid for the tenant's standard
 * (`isValidTarget`). A starter is offered only when both hold.
 *
 * @version v0.6.0
 */

import type { Standard } from "../standards/types";
import type { ProfileBinding } from "./profile-schema";
import { isValidTarget } from "./target-fields";

export interface StarterDefinition {
  /** Stamped on minted profiles as `starter_key`; stable across versions. */
  key: string;
  /** Definition version — bumped when the bindings below change. */
  version: number;
  /** Ruled descriptive-standard fit; offered only for these (+ target check). */
  standards: readonly Standard[];
  /** Stable default name for the minted profile (admin may rename). */
  defaultName: string;
  /** i18n key (imports namespace) for the pick-card title. */
  nameKey: string;
  /** i18n key (imports namespace) for the one-line pick-card description. */
  descriptionKey: string;
  /** The evidence-traced bindings, projected verbatim from the header source. */
  bindings: readonly ProfileBinding[];
}

// ---------------------------------------------------------------------------
// Controlled-value sets (documented in the research — remapped, not guessed)
// ---------------------------------------------------------------------------

// AtoM `levelOfDescription` carries ISAD(G) level names (formats-research
// §1: AtoM is ISAD(G) field-for-field). Fisqua's `DESCRIPTION_LEVELS` IS the
// ISAD level vocabulary; this map is a case/format NORMALISATION between two
// representations of the same documented level set, not an invented
// correspondence. Unlisted levels degrade to the `item` default (+ warning).
const ATOM_LEVEL_MAP: Record<string, string> = {
  Fonds: "fonds",
  Subfonds: "subfonds",
  Series: "series",
  Subseries: "subseries",
  File: "file",
  Item: "item",
  Collection: "collection",
};

// EAP `Level` is a documented five-value dropdown (eap-meap-templates §1.3,
// verbatim: Collection | Series | Sub-series | File | Item). "Sub-series"
// folds to Fisqua's hyphen-free `subseries`.
const EAP_LEVEL_MAP: Record<string, string> = {
  Collection: "collection",
  Series: "series",
  "Sub-series": "subseries",
  File: "file",
  Item: "item",
};

// MEAP has NO level column — it is item-level by construction
// (eap-meap-templates §2.3, verbatim: "always item"). `Resource Type` is a
// guaranteed-present required column with a documented closed vocabulary
// (§2.5); mapping its whole value set to `item` injects MEAP's documented
// level AND validates the source: an unlisted resource type still resolves
// to `item` (the default) but surfaces a warning, correctly flagging an
// off-template value — which a bare `constant` would silently ignore.
const MEAP_RESOURCE_TYPES = [
  "Still image",
  "Text",
  "Cartographic",
  "Moving image",
  "Sound recording-nonmusical",
  "Sound recording-musical",
  "Mixed material",
  "Three dimensional object",
  "Notated music",
  "Software/multimedia",
];
const MEAP_LEVEL_MAP: Record<string, string> = Object.fromEntries(
  MEAP_RESOURCE_TYPES.map((t) => [t, "item"]),
);

// ---------------------------------------------------------------------------
// 1. AtoM ISAD(G) CSV  (formats-research §1)  → isadg
// ---------------------------------------------------------------------------
// Hierarchy — NAMED LIMITATION, AtoM imports FLAT in v1: `identifier` is
// the real archival reference code, but `parentId` references `legacyId`
// (research §1: "values are arbitrary keys you invent"), NOT the reference
// code. Fisqua resolves parents strictly by referenceCode, and
// parent-by-legacyId resolution does not exist in v1 — so a `parentId` →
// `parent` binding would reject every child row in any export where
// legacyId differs from identifier. `parentId` is therefore UNBOUND, like
// `qubitParentSlug` (parent by AtoM slug — also not a reference code). A
// cataloguer whose export DID key legacyId to the reference code can add
// the parent binding in the editor after minting.
//
// UNBOUND AtoM headers (no documented isadg target; named, not guessed):
//   parentId, qubitParentSlug, accessionNumber, repository, archivalHistory,
//   acquisition, appraisal, accruals, script, languageNote,
//   physicalCharacteristics, relatedUnitsOfDescription, publicationNote,
//   digitalObjectPath, digitalObjectURI, subjectAccessPoints,
//   placeAccessPoints, nameAccessPoints, descriptionIdentifier,
//   institutionIdentifier, rules, descriptionStatus, levelOfDetail,
//   revisionHistory, languageOfDescription, scriptOfDescription, sources,
//   publicationStatus, physicalObjectName, physicalObjectLocation,
//   physicalObjectType, alternativeIdentifierLabels, eventDates,
//   eventTypes, eventEndDates, eventActorHistories, culture.
// (Access points are authorities — link-never-mint, spec §1. eventEndDates
//  is unbound because the catalogue cannot fold two date columns into one
//  range expression; eventStartDates carries the date.)
const ATOM_ISADG: StarterDefinition = {
  key: "atom-isadg-csv",
  version: 1,
  standards: ["isadg"],
  defaultName: "AtoM ISAD(G) CSV",
  nameKey: "starters.atomIsadg.name",
  descriptionKey: "starters.atomIsadg.desc",
  bindings: [
    { source: "identifier", target: "referenceCode" },
    { source: "legacyId", target: "legacyIds", provider: "atom-legacy-id" },
    // LIMITATION: a pipe-delimited alternativeIdentifiers cell lands as ONE
    // legacyIds entry (the pipes preserved inside it) — splitting one cell
    // into multiple legacyIds entries is engine work v1 does not do.
    {
      source: "alternativeIdentifiers",
      target: "legacyIds",
      provider: "atom-alternative-identifier",
    },
    { source: "title", target: "title" },
    {
      source: "levelOfDescription",
      target: "descriptionLevel",
      transform: { kind: "vocabulary", mapping: ATOM_LEVEL_MAP, default: "item" },
    },
    { source: "extentAndMedium", target: "extent" },
    { source: "scopeAndContent", target: "scopeContent" },
    { source: "arrangement", target: "arrangement" },
    { source: "accessConditions", target: "accessConditions" },
    { source: "reproductionConditions", target: "reproductionConditions" },
    {
      source: "language",
      target: "language",
      transform: { kind: "splitRejoin", inputSeparator: "|" },
    },
    { source: "findingAids", target: "findingAids" },
    { source: "locationOfOriginals", target: "locationOfOriginals" },
    { source: "locationOfCopies", target: "locationOfCopies" },
    { source: "generalNote", target: "notes" },
    { source: "archivistNote", target: "internalNotes" },
    {
      source: "genreAccessPoints",
      target: "genre",
      transform: { kind: "splitRejoin", inputSeparator: "|" },
    },
    {
      source: "eventStartDates",
      target: "dateExpression",
      transform: { kind: "date" },
    },
    {
      source: "eventActors",
      target: "creatorDisplay",
      transform: { kind: "splitRejoin", inputSeparator: "|" },
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. AGN FUID  (formats-research §4)  → isadg
// ---------------------------------------------------------------------------
// FUID is an inventory-control instrument, NOT a full ISAD(G) description
// (research §4 judgement): no scope-and-content, no access conditions, no
// creator, no explicit hierarchy column. `CÓDIGO` is the closest identifier/
// hierarchy key; `NÚMERO DE ORDEN` is the sequential entry number (a source
// id → legacyIds). Extent is assembled from folios + conservation unit
// (research: "extent ≈ NÚMERO DE FOLIOS + UNIDAD DE CONSERVACIÓN").
//
// There is NO canonical flat FUID CSV (the AGN form uses merged-cell
// headers); header names below follow the Acuerdo 042/2002 form's
// documented column labels verbatim, sub-columns flattened (Inicial/Final
// under FECHAS EXTREMAS; Caja/Carpeta/Tomo/Otro under UNIDAD DE
// CONSERVACIÓN).
//
// descriptionLevel: FUID rows are conservation units (expedientes) with no
// level column; the ISAD convention for an expediente is `file`. The level
// is a STRUCTURAL property of the format, so it is a `constant` transform
// bound on `CÓDIGO` (an always-present column) — the source cell is ignored
// by construction; the binding exists only to carry the constant. The
// `Otro` container sub-column (a carrier like Caja/Carpeta/Tomo, research
// §4) joins the extent concatenate with its own label, so a populated
// carrier value is preserved, never leaked into the level.
//
// UNBOUND FUID headers (named, not guessed): `Final` (the catalogue cannot
// fold Inicial/Final into one range expression; Inicial carries the date),
// `FRECUENCIA DE CONSULTA` (a valuation-only field — Alto/Medio/Bajo/Ninguno
// — with no descriptive target).
const AGN_FUID: StarterDefinition = {
  key: "agn-fuid",
  version: 1,
  standards: ["isadg"],
  defaultName: "AGN FUID (Inventario Documental)",
  nameKey: "starters.agnFuid.name",
  descriptionKey: "starters.agnFuid.desc",
  bindings: [
    { source: "CÓDIGO", target: "referenceCode" },
    {
      source: "NÚMERO DE ORDEN",
      target: "legacyIds",
      provider: "agn-fuid-orden",
    },
    { source: "NOMBRE DE LA SERIE, SUBSERIE O ASUNTOS", target: "title" },
    {
      source: "Inicial",
      target: "dateExpression",
      transform: { kind: "date" },
    },
    {
      source: "NÚMERO DE FOLIOS",
      target: "extent",
      transform: {
        kind: "concatenate",
        separator: "; ",
        parts: [
          { column: "Caja", label: "Caja" },
          { column: "Carpeta", label: "Carpeta" },
          { column: "Tomo", label: "Tomo" },
          { column: "Otro", label: "Otro" },
          { column: "NÚMERO DE FOLIOS", label: "Folios" },
        ],
      },
    },
    { source: "SOPORTE", target: "medium" },
    { source: "NOTAS", target: "notes" },
    // Structural constant — the CÓDIGO cell is never read (see above).
    {
      source: "CÓDIGO",
      target: "descriptionLevel",
      transform: { kind: "constant", value: "file" },
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. EAP  (eap-meap-templates §1)  → isadg
// ---------------------------------------------------------------------------
// EAP is explicitly ISAD(G)-native (§1.7 cites ISAD clauses field-by-field);
// bindings follow that table. Three title columns fold into title +
// translatedTitle (the transliterated title has no clean Fisqua home — see
// unbound list). Dates use the parameterised date transform (§1.4 controlled
// expressions: "c 1910", "1910?", "1910-1937", "1910s" — the parser's
// tolerance covers these; no numeric slash dates, so dayFirst is irrelevant).
// Languages of Material are pipe-delimited (§1.6).
//
// Hierarchy: EAP conveys nesting by row-order + Level with NO parent-key
// column (§1.3), which Fisqua's parent-by-referenceCode resolution cannot
// consume; EAP therefore imports FLAT in v1. NAMED LIMITATION — not guessed
// into a parent binding.
//
// UNBOUND EAP headers (no documented isadg target; named): `Title
// (Transliterated)`, `Content Type`, `Description (in alternative
// language)`, `Size and Dimensions of Original Material`, `Condition of
// Original Material`, `Country of Origin`, `Related
// Countries/Towns/Cities/Regions`, `Related Religions/Belief Systems`,
// `Related Subjects`, `Other Related Subjects`, `Related Title of Works`
// (place/subject access points — authorities, link-never-mint),
// `Alternative Calendar`, `Alternative Calendar Dates`,
// `Scribe(s)/Publisher(s)/Editor(s) of the Original Material` (only
// Author(s)/Creators binds; role-typed creators have no separate target),
// `Volume Number`, `Issue Number`, `Scripts of Material`, `Writing System`
// (no script column in isadg), `Restriction End Date`, `Reason for
// Restriction` (conditional companions to Access Conditions with no
// distinct target), and the entire Copyright/Data-Protection/Digital-Copies
// blocks (`Is the Material Still in Copyright?` … `Location of Digital
// Copies`).
const EAP: StarterDefinition = {
  key: "eap-listing",
  version: 1,
  standards: ["isadg"],
  defaultName: "EAP Catalogue Listing",
  nameKey: "starters.eap.name",
  descriptionKey: "starters.eap.desc",
  bindings: [
    { source: "Original Reference", target: "referenceCode" },
    {
      source: "Level",
      target: "descriptionLevel",
      transform: { kind: "vocabulary", mapping: EAP_LEVEL_MAP, default: "item" },
    },
    { source: "Title (In English)", target: "title" },
    { source: "Title (In Original Language/Script)", target: "translatedTitle" },
    {
      source: "Dates of Material (Gregorian Calendar)",
      target: "dateExpression",
      transform: { kind: "date" },
    },
    { source: "Number and Type of Original Material", target: "extent" },
    { source: "Author(s) / Creators of the Original Material", target: "creatorDisplay" },
    { source: "Custodial History", target: "provenance" },
    { source: "Description", target: "scopeContent" },
    { source: "System of Arrangement", target: "arrangement" },
    { source: "Access Conditions", target: "accessConditions" },
    {
      source: "Languages of Material",
      target: "language",
      transform: { kind: "splitRejoin", inputSeparator: "|" },
    },
    { source: "Location of Original Material", target: "locationOfOriginals" },
  ],
};

// ---------------------------------------------------------------------------
// 4. MEAP  (eap-meap-templates §2)  → isadg + dacs
// ---------------------------------------------------------------------------
// MEAP is DC/MODS item-level, one row per digital object (§2.3: no
// hierarchy, always item). It maps cleanly onto the core Fisqua identity/
// content/access fields shared by BOTH isadg and dacs, so its bindings are
// restricted to the cross-standard-valid target set (this is why Dimensions/
// Duration/Medium/Genre — isadg-only — and Alt Title/uniformTitle are left
// unbound: keeping MEAP offerable for both standards). Standardized Date
// (clean ISO) carries the date; Language Code and any repeats are
// pipe-delimited (§2.6). descriptionLevel is the constant `item` via the
// documented Resource Type vocabulary (§2.5 — see MEAP_LEVEL_MAP).
//
// UNBOUND MEAP headers (named, not guessed): `* Number of files`, `Alt
// Title` (uniformTitle is isadg-only), `Name.role2`/`Name.role3` (only
// role1 → creatorDisplay; role labels are per-project, §2.7b), `Place of
// Origin`, `* Date Created (human readable)` + `Date Range` (the catalogue
// cannot fold multiple date columns into one range; Standardized Date
// carries it), `Description | Lang`, `Note | Lang` (parallel-language — no
// cross-standard target), `Dimensions`/`Duration`/`Medium` (isadg-only),
// `* Genre` (isadg-only), `* Subject.topic`/`Subject.Name`/`Subject.
// Geographic`/`Subject.Temporal` (access points — authorities),
// `[Physical] Archival Collection Title`/`Archival Collection Number`/`Box`/
// `Folder` (flat physical context — no single descriptive target),
// `* Rights.publicationStatus`/`* Rights.servicesContact` (only
// copyrightStatus → reproductionConditions).
const MEAP: StarterDefinition = {
  key: "meap-object",
  version: 1,
  standards: ["isadg", "dacs"],
  defaultName: "MEAP Metadata (item-level)",
  nameKey: "starters.meap.name",
  descriptionKey: "starters.meap.desc",
  bindings: [
    { source: "Local identifier", target: "referenceCode" },
    { source: "* File Name", target: "legacyIds", provider: "meap-file-name" },
    { source: "* Title", target: "title" },
    { source: "Translated Title", target: "translatedTitle" },
    {
      source: "* Standardized Date (YYYY-MM-DD)",
      target: "dateExpression",
      transform: { kind: "date" },
    },
    { source: "* Extent", target: "extent" },
    { source: "Name.role1", target: "creatorDisplay" },
    { source: "* Description | English", target: "scopeContent" },
    { source: "Note | English", target: "notes" },
    { source: "* Rights.copyrightStatus", target: "reproductionConditions" },
    {
      source: "* Language Code",
      target: "language",
      transform: { kind: "splitRejoin", inputSeparator: "|" },
    },
    { source: "* Institution/Repository", target: "locationOfOriginals" },
    {
      source: "* Resource Type",
      target: "descriptionLevel",
      transform: { kind: "vocabulary", mapping: MEAP_LEVEL_MAP, default: "item" },
    },
  ],
};

/** All external-format starter definitions (the canonical template is separate). */
export const STARTER_DEFINITIONS: readonly StarterDefinition[] = [
  ATOM_ISADG,
  AGN_FUID,
  EAP,
  MEAP,
];

/** Resolve a starter definition by key (external formats only). */
export function getStarterDefinition(key: string): StarterDefinition | undefined {
  return STARTER_DEFINITIONS.find((s) => s.key === key);
}

/**
 * The external-format starters offered for a tenant's descriptive standard:
 * the standard is in the starter's ruled `standards` list AND every binding
 * target is valid for that standard (`isValidTarget`). A starter that would
 * bind a field the standard cannot hold is never shown.
 */
export function startersForStandard(standard: Standard): StarterDefinition[] {
  return STARTER_DEFINITIONS.filter(
    (s) =>
      s.standards.includes(standard) &&
      s.bindings.every((b) => isValidTarget(standard, b.target)),
  );
}
