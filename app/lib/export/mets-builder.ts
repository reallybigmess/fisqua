/**
 * METS XML Builder
 *
 * This builder deals with pure-function emission of METS 1.12.1 XML
 * with Dublin Core descriptive metadata. METS (Metadata Encoding and
 * Transmission Standard) is the preservation-friendly wrapper format
 * that IIIF viewers and digital-preservation tools consume. Ported
 * from Django's `generate_mets.py`; uses template literals with
 * strict XML escaping rather than a library to keep the Worker bundle
 * small.
 *
 * The local `escapeXml` and `dc()` helpers were factored out into
 * `./xml/escape.ts` so the EAD3 and Dublin Core builders share one
 * source of truth for XML escaping and single-element emission. The
 * existing `tests/export/mets-builder.test.ts` is the regression net.
 *
 * @version v0.4.0
 */

import { escapeXml, el } from "./xml/escape";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

const NS_METS = "http://www.loc.gov/METS/";
const NS_XLINK = "http://www.w3.org/1999/xlink";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_DCTERMS = "http://purl.org/dc/terms/";

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

const DC_TYPE_MAP: Record<string, string> = {
  fonds: "Collection",
  subfonds: "Collection",
  series: "Collection",
  subseries: "Collection",
  collection: "Collection",
  section: "Collection",
  file: "Collection",
  item: "Text",
  volume: "Text",
};

const LANGUAGE_MAP: Record<string, string> = {
  "192": "Español",
  "173": "Español",
  "195": "Español",
  Spanish: "Español",
};

export const RIGHTS_DEFAULT =
  "Los catálogos y descripciones de Zasqua son de libre acceso.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetsInput {
  referenceCode: string;
  title: string;
  descriptionLevel: string;
  dateExpression: string | null;
  scopeContent: string | null;
  creatorDisplay: string | null;
  language: string | null;
  extent: string | null;
  placeDisplay: string | null;
  imprint: string | null;
  parentReferenceCode: string | null;
  hasDigital: boolean;
  iiifManifestUrl: string | null;
}

export interface MetsRepository {
  name: string;
  city: string | null;
  code: string;
  rightsText: string | null;
}

// ---------------------------------------------------------------------------
// Re-exports (back-compat)
// ---------------------------------------------------------------------------

// Pre-Phase-37-02 callers imported `escapeXml` from this module. The helper
// now lives in `./xml/escape.ts` (T-37-02 single source of truth across the
// METS, EAD3, and Dublin Core builders); re-export keeps existing imports
// working without a wider sweep.
export { escapeXml };

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a METS 1.12.1 XML string for a single description.
 *
 * Mirrors Django's `build_mets()` structure exactly:
 * mets → metsHdr → dmdSec (DC) → fileSec (optional) → structMap
 */
export function buildMetsXml(
  desc: MetsInput,
  repo: MetsRepository | null,
  createDate: string
): string {
  const ref = desc.referenceCode || "";
  const title = desc.title || "";
  const level = desc.descriptionLevel || "";

  // Language mapping
  const lang = desc.language || "";
  const mappedLang = LANGUAGE_MAP[lang] ?? lang;

  // DC type mapping
  const dcType = DC_TYPE_MAP[level] ?? "";

  // Source: repository name + city
  let source = "";
  if (repo) {
    source = repo.name;
    if (repo.city) source += `, ${repo.city}`;
  }

  // Rights logic: use repo.rightsText for digitised items, default otherwise
  let rights = RIGHTS_DEFAULT;
  if (desc.hasDigital && repo?.rightsText) {
    rights = repo.rightsText;
  }

  const iiifUrl = desc.iiifManifestUrl || "";

  // -- Build XML sections --

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<mets xmlns="${NS_METS}" xmlns:xlink="${NS_XLINK}"\n`;
  xml += `      OBJID="${escapeXml(ref)}" LABEL="${escapeXml(title)}"`;
  if (level) xml += ` TYPE="${escapeXml(level)}"`;
  xml += ` PROFILE="http://www.loc.gov/standards/mets/profiles/">\n`;

  // <metsHdr>
  xml += `  <metsHdr CREATEDATE="${escapeXml(createDate)}">\n`;
  xml += `    <agent ROLE="CREATOR" TYPE="ORGANIZATION">\n`;
  xml += `      <name>Fundación Histórica Neogranadina (NIT 900.861.407), Bogotá, Colombia</name>\n`;
  xml += `      <note>https://neogranadina.org</note>\n`;
  xml += `    </agent>\n`;
  if (repo) {
    xml += `    <agent ROLE="CUSTODIAN" TYPE="ORGANIZATION">\n`;
    xml += `      <name>${escapeXml(repo.name)}</name>\n`;
    xml += `    </agent>\n`;
  }
  xml += `  </metsHdr>\n`;

  // <dmdSec>
  xml += `  <dmdSec ID="dmd-001">\n`;
  xml += `    <mdWrap MDTYPE="DC">\n`;
  xml += `      <xmlData xmlns:dc="${NS_DC}" xmlns:dcterms="${NS_DCTERMS}">\n`;
  xml += el("dc:title", title);
  xml += el("dc:identifier", ref);
  xml += el("dc:date", desc.dateExpression);
  xml += el("dc:description", desc.scopeContent);
  xml += el("dc:creator", desc.creatorDisplay);
  xml += el("dc:language", mappedLang || null);
  xml += el("dc:format", desc.extent);
  xml += el("dc:type", dcType || null);
  xml += el("dc:source", source || null);
  xml += el("dc:rights", rights);
  xml += el("dc:subject", desc.placeDisplay);
  xml += el("dcterms:isPartOf", desc.parentReferenceCode);
  xml += el("dc:publisher", desc.imprint);
  xml += `      </xmlData>\n`;
  xml += `    </mdWrap>\n`;
  xml += `  </dmdSec>\n`;

  // <fileSec> — only for items with IIIF manifest
  if (iiifUrl) {
    xml += `  <fileSec>\n`;
    xml += `    <fileGrp USE="IIIF manifest">\n`;
    xml += `      <file ID="iiif-manifest" MIMETYPE="application/ld+json">\n`;
    xml += `        <FLocat LOCTYPE="URL" xlink:href="${escapeXml(iiifUrl)}" />\n`;
    xml += `      </file>\n`;
    xml += `    </fileGrp>\n`;
    xml += `  </fileSec>\n`;
  }

  // <structMap>
  xml += `  <structMap TYPE="logical">\n`;
  xml += `    <div`;
  if (level) xml += ` TYPE="${escapeXml(level)}"`;
  xml += ` LABEL="${escapeXml(title)}" DMDID="dmd-001"`;
  if (iiifUrl) {
    xml += `>\n`;
    xml += `      <fptr FILEID="iiif-manifest" />\n`;
    xml += `    </div>\n`;
  } else {
    xml += ` />\n`;
  }
  xml += `  </structMap>\n`;

  xml += `</mets>\n`;

  return xml;
}
