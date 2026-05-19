/**
 * Dublin Core Bulk Export Builder
 *
 * This builder deals with per-fonds bulk Dublin Core emission. One
 * file per fonds; OAI-PMH 2.0 `<ListRecords>` envelope; one
 * `<record>` per published description; each record carries an
 * `<oai_dc:dc>` block with the 15 simple Dublin Core elements in spec
 * order. Future OAI-PMH endpoint (post-v0.5) streams these files
 * verbatim — no re-serialisation step.
 *
 * Element mapping reuses the line-anchored precedent at
 * `mets-builder.ts:161-173` (every one of the 15 mappings has an
 * analog there). The `el()` helper from `app/lib/export/xml/escape.ts`
 * handles null-safety (null/empty input emits no element) and XML
 * escaping.
 *
 * Scope: descriptions only. Entities and places have no canonical
 * Dublin Core mapping.
 *
 * Pure function: no D1, no R2, no fetch. The publish pipeline wires
 * the data fetch + R2 PUT around this; the builder takes
 * already-fetched fonds rows + repository map + fonds code +
 * datestamp as input and returns the document as a UTF-8 string.
 *
 * @version v0.4.0
 */

import { escapeXml, el, sanitiseRefForKey } from "../xml/escape";
import type { EadInput, EadRepository } from "../types";

// ---------------------------------------------------------------------------
// Namespaces (OAI-PMH 2.0 + OAI-DC + DC simple)
// ---------------------------------------------------------------------------

const NS_OAI = "http://www.openarchives.org/OAI/2.0/";
const NS_OAI_DC = "http://www.openarchives.org/OAI/2.0/oai_dc/";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const OAI_DC_SCHEMA_LOCATION =
  "http://www.openarchives.org/OAI/2.0/oai_dc/ http://www.openarchives.org/OAI/2.0/oai_dc.xsd";

// ---------------------------------------------------------------------------
// Mappings (lifted from mets-builder.ts:36-53; LANGUAGE_MAP extended with
// `spa` / `eng` ISO 639-3 codes that mets-builder did not have but the
// EadInput.language column can carry — the EAD3 builder already uses these,
// so DC matches for cross-builder consistency)
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
  spa: "Español",
  eng: "English",
  fra: "Français",
  por: "Português",
};

// Default rights string used when the repository has no `rightsText`. Matches
// the v0.4 multi-tenant default — repositories that need a different licence
// override via the `rightsText` column on `repositories`.
const RIGHTS_DEFAULT =
  "All materials in the public domain. Please credit the institution.";

const IDENTIFIER_PREFIX = "fisqua:";

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Emit one Dublin Core bulk file for one fonds.
 *
 * @param fondsRows  All descriptions in the fonds (caller filters by
 *                   tenant_id; the pipeline integration does that).
 *                   Unpublished rows (`isPublished === false`) are skipped.
 * @param repos      Repository lookup keyed by `repositoryId`. Used for
 *                   `<dc:source>` (name + city) and `<dc:rights>`
 *                   (rightsText fallback to RIGHTS_DEFAULT).
 * @param fondsCode  Reference code of the fonds (kept on the signature for
 *                   diagnostics + future per-fonds wrapper attributes —
 *                   not currently embedded in the OAI envelope itself).
 * @param datestamp  ISO-8601 date (typically YYYY-MM-DD) emitted as the
 *                   `<datestamp>` of every `<record>` in this file.
 *                   Typically the publish-run timestamp.
 *
 * @returns OAI-PMH 2.0 `<ListRecords>` document as a UTF-8 string. The
 *          file is structurally complete even when zero rows are
 *          published — empty `<ListRecords>` is well-formed XML and lets
 *          a future OAI endpoint signal an empty fonds slice without a
 *          separate "no rows" code path.
 */
export function buildDcBulk(
  fondsRows: ReadonlyArray<EadInput>,
  repos: ReadonlyMap<string, EadRepository>,
  fondsCode: string,
  datestamp: string,
): string {
  // fondsCode is part of the contract for future per-fonds wrapper
  // attributes (e.g. an `<about>` block keyed by fonds reference); not
  // currently embedded but kept on the signature so future per-fonds
  // wrapper attributes don't need a re-typing pass.
  void fondsCode;

  const published = fondsRows.filter((r) => r.isPublished);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<ListRecords xmlns="${NS_OAI}"\n`;
  xml += `             xmlns:oai_dc="${NS_OAI_DC}"\n`;
  xml += `             xmlns:dc="${NS_DC}"\n`;
  xml += `             xmlns:xsi="${NS_XSI}"\n`;
  xml += `             xsi:schemaLocation="${OAI_DC_SCHEMA_LOCATION}">\n`;

  for (const row of published) {
    xml += renderRecord(row, repos, datestamp);
  }

  xml += `</ListRecords>\n`;
  return xml;
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Emit one `<record>` block for one published description row. Element
 * ordering inside `<oai_dc:dc>` is OAI-DC spec order (RESEARCH Open
 * Question 4 lock): title, creator, subject, description, publisher,
 * contributor, date, type, format, identifier, source, language,
 * relation, coverage, rights.
 *
 * `dc:contributor` is intentionally omitted in v0.4 — entity-level
 * contributors are OAI-PMH-endpoint scope, not bulk-export scope
 * (RESEARCH §Pattern 3). The slot stays in the documented ordering so
 * the future v0.5+ insertion lands without renumbering the rest.
 */
function renderRecord(
  row: EadInput,
  repos: ReadonlyMap<string, EadRepository>,
  datestamp: string,
): string {
  const repo = repos.get(row.repositoryId);
  const ref = sanitiseRefForKey(row.referenceCode);

  let r = `  <record>\n`;
  r += `    <header>\n`;
  r += `      <identifier>${escapeXml(IDENTIFIER_PREFIX + ref)}</identifier>\n`;
  r += `      <datestamp>${escapeXml(datestamp)}</datestamp>\n`;
  r += `    </header>\n`;
  r += `    <metadata>\n`;
  r += `      <oai_dc:dc>\n`;

  // Spec order: title, creator, subject, description, publisher,
  // contributor, date, type, format, identifier, source, language,
  // relation, coverage, rights.
  r += elIndented("dc:title", row.title);
  r += elIndented("dc:creator", row.creatorDisplay);
  r += elIndented("dc:subject", row.placeDisplay);
  r += elIndented("dc:description", row.scopeContent);
  r += elIndented("dc:publisher", row.imprint);
  // dc:contributor — intentionally empty for v0.4 (RESEARCH §Pattern 3).
  r += elIndented("dc:date", row.dateExpression);

  const dcType = DC_TYPE_MAP[row.descriptionLevel] ?? null;
  r += elIndented("dc:type", dcType);

  r += elIndented("dc:format", row.extent);
  r += elIndented("dc:identifier", ref);

  // dc:source — repository name + city when both are populated; emit
  // nothing (via el() null-safety) when the repo is unknown.
  const source =
    repo && repo.name && repo.city ? `${repo.name}, ${repo.city}` : null;
  r += elIndented("dc:source", source);

  // dc:language — map known codes to human-readable labels; pass-through
  // unknown codes so the consumer still sees the original value.
  const langName = row.language
    ? (LANGUAGE_MAP[row.language] ?? row.language)
    : null;
  r += elIndented("dc:language", langName);

  r += elIndented("dc:relation", row.parentReferenceCode);
  // dc:coverage — DCMI permits dates here; reusing dateExpression is
  // canonical for archival materials (one source, two facets).
  r += elIndented("dc:coverage", row.dateExpression);

  // dc:rights — repository override → fall back to RIGHTS_DEFAULT.
  // Matches mets-builder.ts:128-132's rights logic, less the hasDigital
  // gate (DC bulk emits for every published description, not only
  // digitised items, so the repository-level rights string is the
  // canonical override).
  const rights =
    repo?.rightsText && repo.rightsText.trim().length > 0
      ? repo.rightsText
      : RIGHTS_DEFAULT;
  r += elIndented("dc:rights", rights);

  r += `      </oai_dc:dc>\n`;
  r += `    </metadata>\n`;
  r += `  </record>\n`;
  return r;
}

/**
 * Indent `el()` output for the OAI-DC nesting depth.
 *
 * `el()` in `xml/escape.ts` emits `    <tag>...</tag>\n` (4-space indent)
 * because that's the single nesting level it was originally written for
 * inside `<dmdSec>` → `<mdWrap>` → `<xmlData>`. Inside the OAI envelope
 * the `<dc:*>` elements sit one level deeper (`<record>` → `<metadata>`
 * → `<oai_dc:dc>` → `<dc:*>`), so we re-indent to 8 spaces.
 *
 * Returns "" for null/empty input — the el() helper's null-safety
 * propagates here unchanged (RESEARCH Pitfall 4).
 */
function elIndented(tag: string, text: string | null | undefined): string {
  const out = el(tag, text);
  if (!out) return "";
  return out.replace(/^    /, "        ");
}

/* @version v0.4.0 */
