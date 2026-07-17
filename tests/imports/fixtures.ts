/**
 * Tests — imports fixtures
 *
 * This helper carries the VERBATIM AtoM ISAD(G) 2.x CSV template header
 * row (the verified AtoM CSV import template) and a builder that emits a
 * well-formed CSV from it. Fixture data rows are deliberately minimal
 * and self-evidently template-shaped placeholders — never invented
 * archival records.
 *
 * @version v0.6.0
 */

/** The AtoM ISAD(G) CSV template headers, in file order, verbatim. */
export const ATOM_ISADG_HEADERS = [
  "legacyId",
  "parentId",
  "qubitParentSlug",
  "accessionNumber",
  "identifier",
  "title",
  "levelOfDescription",
  "extentAndMedium",
  "repository",
  "archivalHistory",
  "acquisition",
  "scopeAndContent",
  "appraisal",
  "accruals",
  "arrangement",
  "accessConditions",
  "reproductionConditions",
  "language",
  "script",
  "languageNote",
  "physicalCharacteristics",
  "findingAids",
  "locationOfOriginals",
  "locationOfCopies",
  "relatedUnitsOfDescription",
  "publicationNote",
  "digitalObjectPath",
  "digitalObjectURI",
  "generalNote",
  "subjectAccessPoints",
  "placeAccessPoints",
  "nameAccessPoints",
  "genreAccessPoints",
  "descriptionIdentifier",
  "institutionIdentifier",
  "rules",
  "descriptionStatus",
  "levelOfDetail",
  "revisionHistory",
  "languageOfDescription",
  "scriptOfDescription",
  "sources",
  "archivistNote",
  "publicationStatus",
  "physicalObjectName",
  "physicalObjectLocation",
  "physicalObjectType",
  "alternativeIdentifiers",
  "alternativeIdentifierLabels",
  "eventDates",
  "eventTypes",
  "eventStartDates",
  "eventEndDates",
  "eventActors",
  "eventActorHistories",
  "culture",
] as const;

type HeaderRow = Partial<Record<(typeof ATOM_ISADG_HEADERS)[number], string>>;

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build an AtoM ISAD(G) CSV from partial row objects. Every emitted row
 * is aligned to the verbatim header order; absent columns are empty.
 */
export function makeAtomCsv(rows: HeaderRow[]): string {
  const lines = [ATOM_ISADG_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      ATOM_ISADG_HEADERS.map((h) => csvField(row[h] ?? "")).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Two minimal, clearly template-shaped rows over the AtoM headers. */
export const SAMPLE_ATOM_ROWS: HeaderRow[] = [
  {
    legacyId: "1",
    identifier: "TEST-FONDS-001",
    title: "Sample fonds (template row)",
    levelOfDescription: "Fonds",
    eventStartDates: "1700",
    eventEndDates: "1799",
    language: "es",
  },
  {
    legacyId: "2",
    parentId: "1",
    identifier: "TEST-FILE-001",
    title: "Sample file (template row)",
    levelOfDescription: "File",
    eventStartDates: "1750",
    eventEndDates: "1750",
    language: "es|la",
  },
];

/**
 * A Fonds + a File row over the AtoM headers, for the AtoM STARTER dry-run.
 * Synthetic ("Example …"), never invented records. legacyId/parentId are
 * ARBITRARY migration keys deliberately DIFFERENT from `identifier` — the
 * realistic AtoM export shape (research §1: parentId references legacyId,
 * not the reference code). The starter leaves parentId unbound, so both
 * rows import FLAT: the fixture pins that no row rejects and no parent
 * linkage is inferred. The Fonds row is fully populated so it passes the
 * isadg fonds required-field set.
 */
export const SAMPLE_ATOM_STARTER_ROWS: HeaderRow[] = [
  {
    legacyId: "471",
    identifier: "EXFONDS-1",
    title: "Example fonds title",
    levelOfDescription: "Fonds",
    extentAndMedium: "1 linear metre of textual records",
    scopeAndContent: "Example scope and content of the fonds.",
    accessConditions: "Open",
    genreAccessPoints: "Correspondence|Reports",
    language: "es|la",
    eventStartDates: "1700",
    eventActors: "Example creator",
  },
  {
    legacyId: "472",
    parentId: "471",
    identifier: "EXFONDS-1-1",
    title: "Example file title",
    levelOfDescription: "File",
    eventStartDates: "1750",
    language: "es",
  },
];

// ---------------------------------------------------------------------------
// SBMAL DACS fixtures — REAL rows, verbatim from
// sbmal-catalogues/data/dacs/SBMAL_MASTER_all_catalogues_DACS.csv (the 5,576
// -item master export). Headers are the real DACS-shaped column names; the
// rows below are copied verbatim (reference codes, titles, dates, scope
// notes) — never invented archival records. Used by the validation and
// dry-run suites so the pipeline is exercised against genuine data shapes.
// ---------------------------------------------------------------------------

/** The SBMAL DACS export headers, in file order, verbatim. */
export const SBMAL_DACS_HEADERS = [
  "Reference_Code",
  "Source_Catalogue",
  "Collection",
  "Series",
  "Repository",
  "Title",
  "Date_Expressed",
  "Date_Start",
  "Date_End",
  "Date_Certainty",
  "Place_of_Creation",
  "Scope_and_Content",
  "Notes",
  "Former_Reference_Geiger",
  "Former_Reference_Engelhardt",
  "Languages_and_Scripts",
  "Extent",
  "Name_of_Creator",
  "Report_Type",
  "Format",
  "Holding_Location",
  "Original_Title",
  "Parse_Review_Flag",
] as const;

type SbmalRow = Partial<Record<(typeof SBMAL_DACS_HEADERS)[number], string>>;

/**
 * Build an SBMAL DACS CSV from partial row objects, aligned to the verbatim
 * header order; absent columns are empty. `extraHeaders` appends columns —
 * e.g. an explicit parent-reference-code column for the container-tree
 * hierarchy pattern, which the base export does not carry.
 */
export function makeSbmalCsv(
  rows: SbmalRow[],
  extraHeaders: readonly string[] = [],
): string {
  const headers = [...SBMAL_DACS_HEADERS, ...extraHeaders];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers.map((h) => csvField((row as Record<string, string>)[h] ?? "")).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * The first EIGHT rows of the SBMAL master export — the real consecutive
 * run CMD 1, 2, 3, 3a, 4, 5, 5a, 6 with no gaps — every populated cell
 * byte-verbatim from the file; keys absent below are cells that are EMPTY
 * in the master. Blank across all eight rows there: Series,
 * Languages_and_Scripts, Extent, Name_of_Creator, Report_Type, Format,
 * Holding_Location. Partially populated: Date_Start (blank on CMD 3a),
 * Date_Certainty (only CMD 3a, "approximate"), Place_of_Creation (blank on
 * CMD 3a and CMD 5a), Notes (only CMD 3a and CMD 4),
 * Former_Reference_Geiger (blank on CMD 3a, CMD 5, CMD 5a),
 * Former_Reference_Engelhardt (only CMD 6), Parse_Review_Flag (only
 * CMD 3a, CMD 4, CMD 5a). `2/4/1640` and its siblings are US month-first
 * slash dates (the master's own Date_Start says 1640-02-04); the blank
 * Extent is what the DACS validator suite relies on.
 */
export const SBMAL_REAL_ROWS: SbmalRow[] = [
  {
    Reference_Code: "CMD 1",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "Mexico. 1521-1605.",
    Date_Expressed: "1521-1605",
    Date_Start: "1521",
    Date_End: "1605",
    Place_of_Creation: "Mexico",
    Scope_and_Content: "Summary declarations from various papal bulls on the privileges conceded to friars of mendicant orders in the Indies arranged by Fray Juan Focher, O.F.M., and Dr. Sedeño, at the command of Viceroy Luís de Velasco. Pr. pp., 305-348 of an unidentified book. Contains summaries from the bulls of Leo X, April 25, 1521; Adrian VI, 1522; Paul III, February 25, 1535; Paul III, Dec. 25, 1537; Pius V, March 24, 1567; Paul V, August 18, 1605; and Clement VIII, July 13, 1604. Latin. 43 pp.",
    Former_Reference_Geiger: "Geiger 1",
    Original_Title: "Mexico. 1521-1605.",
  },
  {
    Reference_Code: "CMD 2",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "Mexico. 2/4/1640.",
    Date_Expressed: "2/4/1640",
    Date_Start: "1640-02-04",
    Date_End: "1640-02-04",
    Place_of_Creation: "Mexico",
    Scope_and_Content: "Constitutions of the Franciscan Province of Santo Evangelio as amended by the Provincial Chapter held in Mexico City, February 4, 1640. Typed & certified transcription by Fr. Maynard Geiger, O.F.M., made at Holy Name College, Wash., D. C., 1936. Spanish. 41 pp.",
    Former_Reference_Geiger: "Geiger 2",
    Original_Title: "Mexico. 2/4/1640.",
  },
  {
    Reference_Code: "CMD 3",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "Mexico. 5/7/1667.",
    Date_Expressed: "5/7/1667",
    Date_Start: "1667-05-07",
    Date_End: "1667-05-07",
    Place_of_Creation: "Mexico",
    Scope_and_Content: "Constitutions of the Franciscan Province of Santo Evangelio as changed on May 7, 1667. Pp. 29-32. Copied from the original at Orizaba, Mexico, September 5, 1905, by Zephyrin Engelhardt, O.F.M., Handwritten transcription in Spanish. 4 pp.",
    Former_Reference_Geiger: "Geiger 3",
    Original_Title: "Mexico. 5/7/1667.",
  },
  {
    Reference_Code: "CMD 3a",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "Before 1700.",
    Date_Expressed: "Before 1700",
    Date_End: "1700",
    Date_Certainty: "approximate",
    Scope_and_Content: "Respuesta del Reverendismo Padre Pablo Señeri de la Compañia de Jesus, Predecador de N.S.P. Innocencia 12 a la consulta de un Gran Prelado a cerca de la probabilidad de las opiniones. Traducida de la lengua Toscana a la Castellana por Dr. Joseph de Torquemada. 76 pp. Innocent XII. 1691-1700.",
    Notes: "Does Innocent XII. 1691-1700 belong here.",
    Original_Title: "Before 1700.",
    Parse_Review_Flag: "no-place",
  },
  {
    Reference_Code: "CMD 4",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "Zacatecas. 1686-1719. DOCUMENT MISSING.",
    Date_Expressed: "1686-1719",
    Date_Start: "1686",
    Date_End: "1719",
    Place_of_Creation: "Zacatecas",
    Scope_and_Content: "Bulls concerning apostolic colleges. A Ms. booklet containing bull of Innocent XI, July 28, 1686, brief of same, October 16, 1686; decree of the Propaganda Fide on missions, colleges, etc., Rome, November 16, 1688; and the Constitutions of the Apostolic College of Our Lady of Guadalupe, Zacatecas, November 13, 1713, and September 26, 1719. \n79 pp.",
    Notes: "[from title] DOCUMENT MISSING",
    Former_Reference_Geiger: "Geiger 4",
    Original_Title: "Zacatecas. 1686-1719. DOCUMENT MISSING.",
    Parse_Review_Flag: "trailing-text",
  },
  {
    Reference_Code: "CMD 5",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "Province of Cantabria. 1693-1752.",
    Date_Expressed: "1693-1752",
    Date_Start: "1693",
    Date_End: "1752",
    Place_of_Creation: "Province of Cantabria",
    Scope_and_Content: "Marriage record of Juan de Lasuén and Magdalena de Aspiunza, paternal grandparents of Fray Fermín Francisco de Lasuén, O.F.M., June 22, 1693; baptismal record of Lorenzo de Lasuén, father of Fermín, March 6, 1701; marriage record of Lorenzo de Lasuén and María de Arizqueta, parents of Fermín, April 5, 1728; baptismal record of Fray Fermín Francisco de Lasuén, Vitoria, July 8, 1736; record of reception of Franciscan habit at Vitoria by Lasuén, March 19, 1751; profession of Lasuén at Vitoria July 7, 1752. Photograph. Spanish. 4 pp.",
    Original_Title: "Province of Cantabria. 1693-1752.",
  },
  {
    Reference_Code: "CMD 5a",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "2/28/1774.",
    Date_Expressed: "2/28/1774",
    Date_Start: "1774-02-28",
    Date_End: "1774-02-28",
    Scope_and_Content: "List of soldiers at Presidio of Loreto.",
    Original_Title: "2/28/1774.",
    Parse_Review_Flag: "no-place",
  },
  {
    Reference_Code: "CMD 6",
    Source_Catalogue: "California Mission Documents (CMD)",
    Collection: "California Mission Documents (CMD)",
    Repository: "Santa Barbara Mission Archive-Library, Santa Barbara, California, USA",
    Title: "San Francisco. 2/18/1785.",
    Date_Expressed: "2/18/1785",
    Date_Start: "1785-02-18",
    Date_End: "1785-02-18",
    Place_of_Creation: "San Francisco",
    Scope_and_Content: "Fray Francisco Palóu, O.F.M., to Joseph Antonio Rengel congratulating him on his elevation to the commandancy-generalship of the Provincias Internas. In Palóu's hand but unsigned. Santa Bárbara Mission Archive-Library. Spanish. 1 p.",
    Former_Reference_Geiger: "Geiger 87",
    Former_Reference_Engelhardt: "Zephyrin 139",
    Original_Title: "San Francisco. 2/18/1785.",
  },
];

/** The reference codes of `SBMAL_REAL_ROWS`, in file order. */
export const SBMAL_REAL_CODES = [
  "CMD 1",
  "CMD 2",
  "CMD 3",
  "CMD 3a",
  "CMD 4",
  "CMD 5",
  "CMD 5a",
  "CMD 6",
] as const;

/**
 * A mapping profile over the SBMAL DACS headers. `descriptionLevel` is set
 * from the (blank) `Format` column via default-when-blank, so every row
 * resolves to `item` (SBMAL's master export is item-level). `Date_Expressed`
 * carries the one date transform, month-first (`dayFirst: false` — the
 * master's own Date_Start reads `2/4/1640` as 1640-02-04). BOTH former-
 * reference columns archive into `legacyIds`, each entry tagged with its
 * own source-derived provider.
 */
export const SBMAL_DACS_BINDINGS = [
  { source: "Reference_Code", target: "referenceCode" },
  { source: "Title", target: "title", transform: { kind: "direct" as const } },
  {
    source: "Date_Expressed",
    target: "dateExpression",
    transform: { kind: "date" as const, dayFirst: false },
  },
  { source: "Scope_and_Content", target: "scopeContent", transform: { kind: "direct" as const } },
  { source: "Languages_and_Scripts", target: "language", transform: { kind: "direct" as const } },
  { source: "Extent", target: "extent", transform: { kind: "direct" as const } },
  {
    source: "Format",
    target: "descriptionLevel",
    transform: { kind: "defaultWhenBlank" as const, default: "item" },
  },
  { source: "Former_Reference_Geiger", target: "legacyIds", transform: { kind: "direct" as const } },
  { source: "Former_Reference_Engelhardt", target: "legacyIds", transform: { kind: "direct" as const } },
];

// ---------------------------------------------------------------------------
// Starter-profile fixtures — VERBATIM template headers from the research docs
// (research/2026-07-11-imports-formats-research.md §4 for FUID;
//  research/2026-07-12-eap-meap-templates.md §1.2 for EAP and §2.1 for MEAP).
// Every data row below is SYNTHETIC and self-evidently template-shaped
// ("Example …") — never an invented archival record. They exist only to
// prove each starter's header binding resolves cleanly and produces sane
// verdicts against its own template.
// ---------------------------------------------------------------------------

/** Generic CSV builder: header row + partial rows aligned to the headers. */
function makeCsv(
  headers: readonly string[],
  rows: Record<string, string>[],
): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// --- EAP: the "2. Description" worksheet, 51 columns, verbatim (§1.2) --------
export const EAP_HEADERS = [
  "Level",
  "Original Reference",
  "Title (In English)",
  "Title (In Original Language/Script)",
  "Title (Transliterated)",
  "Content Type",
  "Description",
  "Description (in alternative language)",
  "Number and Type of Original Material",
  "Size and Dimensions of Original Material",
  "Condition of Original Material",
  "Country of Origin",
  "Related Countries",
  "Related Towns/Cities",
  "Related Regions",
  "Related Religions/Belief Systems",
  "Related Subjects",
  "Other Related Subjects",
  "Related Title of Works",
  "Dates of Material (Gregorian Calendar)",
  "Alternative Calendar",
  "Alternative Calendar Dates",
  "System of Arrangement",
  "Custodial History",
  "Location of Original Material",
  "Author(s) / Creators of the Original Material",
  "Scribe(s) of the Original Material",
  "Publisher(s) of the Original Material",
  "Editor(s) of the Original Material",
  "Volume Number",
  "Issue Number",
  "Languages of Material",
  "Scripts of Material",
  "Writing System",
  "Access Conditions",
  "Restriction End Date",
  "Reason for Restriction",
  "Is the Material Still in Copyright?",
  "Copyright Holder's Name",
  "Have you obtained written consent for the Material to be included on the EAP website?",
  "Have You Sent All Written Permissions to the EAP Office?",
  "Attribution",
  "Does the Material Contain Sensitive Personal Data about Living People?",
  "The Nature of Sensitive Personal Data",
  "Digital Folder Name",
  "Digital File Name (First)",
  "Digital File Name (Last)",
  "Creation Date of Digital Files",
  "Format of Digital Files",
  "Number of Digital Files",
  "Location of Digital Copies",
] as const;

export function makeEapCsv(rows: Record<string, string>[]): string {
  return makeCsv(EAP_HEADERS, rows);
}

/** A Collection + a File child, both synthetic; both clean isadg creates. */
export const SAMPLE_EAP_ROWS: Record<string, string>[] = [
  {
    Level: "Collection",
    "Original Reference": "EAP000/1",
    "Title (In English)": "Example collection title",
    "Dates of Material (Gregorian Calendar)": "1900-1950",
    "Number and Type of Original Material": "120 manuscripts",
    "Author(s) / Creators of the Original Material": "Example creator",
    "Custodial History": "Held by the example owner.",
    Description: "Example scope and content of the collection.",
    "System of Arrangement": "Arranged by subject.",
    "Access Conditions": "Unrestricted",
    "Languages of Material": "Arabic|English",
    "Location of Original Material": "Example repository, Example City",
  },
  {
    Level: "File",
    "Original Reference": "EAP000/1/1",
    "Title (In English)": "Example file title",
    "Dates of Material (Gregorian Calendar)": "c 1910",
    "Languages of Material": "Arabic",
  },
];

// --- MEAP: the `Template` tab, 36 columns, verbatim (§2.1) -------------------
export const MEAP_HEADERS = [
  "* File Name",
  "* Number of files",
  "Local identifier",
  "* Title",
  "Translated Title",
  "Alt Title",
  "Name.role1",
  "Name.role2",
  "Name.role3",
  "Place of Origin",
  "* Date Created (human readable)",
  "* Standardized Date (YYYY-MM-DD)",
  "Date Range (YYYY-MM-DD/YYYY-MM-DD)",
  "* Language Code",
  "* Description | English",
  "* Description | Lang",
  "Note | English",
  "Note | Lang",
  "* Extent",
  "Dimensions",
  "Duration",
  "Medium",
  "* Resource Type",
  "* Genre",
  "* Subject.topic",
  "Subject.Name",
  "Subject.Geographic",
  "Subject.Temporal",
  "* Institution/Repository",
  "[Physical] Archival Collection Title",
  "Archival Collection Number",
  "Box",
  "Folder",
  "* Rights.copyrightStatus",
  "* Rights.publicationStatus",
  "* Rights.servicesContact",
] as const;

export function makeMeapCsv(rows: Record<string, string>[]): string {
  return makeCsv(MEAP_HEADERS, rows);
}

/** Two item-level objects, synthetic; clean creates under isadg AND dacs. */
export const SAMPLE_MEAP_ROWS: Record<string, string>[] = [
  {
    "* File Name": "EX-001.tif",
    "* Number of files": "1",
    "Local identifier": "EX-001",
    "* Title": "Example object title",
    "Translated Title": "Título de objeto de ejemplo",
    "Name.role1": "Example photographer",
    "* Date Created (human readable)": "June 1, 1935",
    "* Standardized Date (YYYY-MM-DD)": "1935-06-01",
    "* Language Code": "spa",
    "* Description | English": "Example description of the object.",
    "* Description | Lang": "Descripción de ejemplo.",
    "* Extent": "1 photograph",
    "* Resource Type": "Still image",
    "* Genre": "black-and-white photographs",
    "* Subject.topic": "Example subject",
    "* Institution/Repository": "Example repository",
    "* Rights.copyrightStatus": "public domain",
    "* Rights.publicationStatus": "published",
    "* Rights.servicesContact": "archives@example.org",
  },
  {
    "* File Name": "EX-002.tif",
    "* Number of files": "1",
    "Local identifier": "EX-002",
    "* Title": "Example object title 2",
    "* Date Created (human readable)": "1936",
    "* Standardized Date (YYYY-MM-DD)": "1936",
    "* Language Code": "eng",
    "* Description | English": "Another example description.",
    "* Extent": "2 photographs",
    "* Resource Type": "Text",
    "* Genre": "correspondence",
    "* Subject.topic": "Example subject",
    "* Institution/Repository": "Example repository",
    "* Rights.copyrightStatus": "unknown",
    "* Rights.publicationStatus": "unpublished",
    "* Rights.servicesContact": "archives@example.org",
  },
];

// --- AGN FUID: the Acuerdo 042/2002 row-level columns, verbatim labels (§4) --
// FUID has no canonical flat CSV (merged-cell form); headers follow the AGN
// form's documented column labels, sub-columns flattened (Inicial/Final under
// FECHAS EXTREMAS; Caja/Carpeta/Tomo/Otro under UNIDAD DE CONSERVACIÓN).
export const FUID_HEADERS = [
  "NÚMERO DE ORDEN",
  "CÓDIGO",
  "NOMBRE DE LA SERIE, SUBSERIE O ASUNTOS",
  "Inicial",
  "Final",
  "Caja",
  "Carpeta",
  "Tomo",
  "Otro",
  "NÚMERO DE FOLIOS",
  "SOPORTE",
  "FRECUENCIA DE CONSULTA",
  "NOTAS",
] as const;

export function makeFuidCsv(rows: Record<string, string>[]): string {
  return makeCsv(FUID_HEADERS, rows);
}

/**
 * Three conservation units, synthetic; clean isadg creates at `file` level.
 * The third row populates the `Otro` carrier sub-column — its value must
 * land in extent (with the other container parts), never in the level.
 */
export const SAMPLE_FUID_ROWS: Record<string, string>[] = [
  {
    "NÚMERO DE ORDEN": "1",
    "CÓDIGO": "1.1",
    "NOMBRE DE LA SERIE, SUBSERIE O ASUNTOS": "Example series, subseries or subject",
    Inicial: "1780",
    Final: "1785",
    Caja: "1",
    Carpeta: "1",
    "NÚMERO DE FOLIOS": "45",
    SOPORTE: "Físico",
    NOTAS: "Example inventory note.",
  },
  {
    "NÚMERO DE ORDEN": "2",
    "CÓDIGO": "1.2",
    "NOMBRE DE LA SERIE, SUBSERIE O ASUNTOS": "Example series, subseries or subject 2",
    Inicial: "1790",
    Final: "1799",
    Caja: "1",
    Carpeta: "2",
    "NÚMERO DE FOLIOS": "30",
    SOPORTE: "Físico",
  },
  {
    "NÚMERO DE ORDEN": "3",
    "CÓDIGO": "1.3",
    "NOMBRE DE LA SERIE, SUBSERIE O ASUNTOS": "Example series, subseries or subject 3",
    Inicial: "1800",
    Final: "1805",
    Otro: "Legajo de ejemplo 3",
    "NÚMERO DE FOLIOS": "12",
    SOPORTE: "Físico",
  },
];

/** Encode a string as UTF-8 bytes with a leading BOM (the Excel reality). */
export function withBom(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf], 0);
  out.set(body, 3);
  return out;
}
