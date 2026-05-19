/**
 * Description Formatter
 *
 * This module deals with mapping one Drizzle row off `descriptions`
 * into the shape the published JSON expects. It handles language-code
 * lookup, hierarchy level resolution, repository short-code
 * denormalisation, and the allowlist of fields that are safe to
 * publish — internal bookkeeping columns (createdBy, updatedBy,
 * internal notes) are deliberately excluded.
 *
 * @version v0.4.0
 */

import type { ExportDescription } from "./types";
import { LANGUAGE_MAP, LEVEL_HIERARCHY } from "./constants";

/**
 * Infer the archival level of a description's children.
 * Ported from Django _children_level in export_frontend_data.py.
 */
export function childrenLevel(
  refCode: string | null,
  level: string,
  childRefs: string[]
): string | null {
  const ref = refCode ?? "";

  if (/-caj\d+$/.test(ref)) return "carpeta";
  if (/-car\d+$/.test(ref)) return "item";
  if (/-leg\d+$/.test(ref)) return "item";
  if (/-tom\d+$/.test(ref)) return "item";
  if (/-t\d+$/.test(ref)) return "item";
  if (/-aht-\d+$/.test(ref)) return "item";
  if (/-cab-\d+$/.test(ref)) return "item";

  if (level === "fonds" && childRefs.length > 0) {
    const sample = childRefs.slice(0, 20);
    const hasCaja = sample.some((r) => r.includes("-caj"));
    const hasTomo = sample.some((r) => r.includes("-tom") || r.includes("-t0"));
    const hasCarpeta = sample.some((r) => r.includes("-car"));
    const hasLegajo = sample.some(
      (r) =>
        /-aht-\d+$/.test(r) || /-leg\d+$/.test(r) || /-cab-\d+$/.test(r)
    );

    const types = [hasCaja, hasTomo, hasCarpeta, hasLegajo].filter(
      Boolean
    ).length;
    if (types > 1) return null;
    if (hasCaja) return "caja";
    if (hasTomo) return "tomo";
    if (hasCarpeta) return "carpeta";
    if (hasLegajo) return "legajo";
  }

  return LEVEL_HIERARCHY[level] ?? null;
}

/**
 * Return the publication title for PE-BN CDIP items, null for everything else.
 * Matches Django logic: repo code starts with 'pe-bn' and ref code contains 'cdip'.
 */
export function publicationTitle(
  refCode: string,
  repoCode: string
): string | null {
  if (repoCode.startsWith("pe-bn") && refCode.includes("cdip")) {
    return "Colección Documental de la Independencia del Perú";
  }
  return null;
}

/**
 * Map a D1 description row + its repository to ExportDescription.
 * Only exported fields are included — internal fields (internalNotes,
 * createdBy, updatedBy) are excluded.
 */
export function formatDescription(
  row: {
    id: string;
    parentId: string | null;
    childCount: number;
    descriptionLevel: string;
    referenceCode: string;
    localIdentifier: string | null;
    title: string;
    dateExpression: string | null;
    dateStart: string | null;
    hasDigital: boolean | null;
    iiifManifestUrl: string | null;
    scopeContent: string | null;
    ocrText: string | null;
    extent: string | null;
    arrangement: string | null;
    accessConditions: string | null;
    reproductionConditions: string | null;
    language: string | null;
    locationOfOriginals: string | null;
    locationOfCopies: string | null;
    findingAids: string | null;
    notes: string | null;
    imprint: string | null;
    editionStatement: string | null;
    seriesStatement: string | null;
    uniformTitle: string | null;
    sectionTitle: string | null;
    pages: string | null;
    creatorDisplay: string | null;
    placeDisplay: string | null;
  },
  repo: { code: string; country: string | null },
  parentRefCode: string | null,
  childRefs: string[]
): ExportDescription {
  return {
    id: row.id,
    repository_code: repo.code,
    country: repo.country ?? "",
    reference_code: row.referenceCode,
    // local_identifier RELAXED to nullable in 0036 (DACS/RAD do not
    // mandate it). The export shape stays string for snapshot
    // continuity; coerce null to empty string.
    local_identifier: row.localIdentifier ?? "",
    title: row.title,
    description_level: row.descriptionLevel,
    date_expression: row.dateExpression,
    date_start: row.dateStart,
    parent_id: row.parentId,
    parent_reference_code: parentRefCode,
    has_children: row.childCount > 0,
    child_count: row.childCount,
    children_level: childrenLevel(
      row.referenceCode,
      row.descriptionLevel,
      childRefs
    ),
    has_digital: row.hasDigital ?? false,
    iiif_manifest_url: row.iiifManifestUrl ?? "",
    mets_url: `https://mets.zasqua.org/${row.referenceCode.replace(/[?#]/g, "")}.xml`,
    scope_content: row.scopeContent,
    ocr_text: row.ocrText ?? "",
    extent: row.extent,
    arrangement: row.arrangement,
    access_conditions: row.accessConditions,
    reproduction_conditions: row.reproductionConditions,
    language: LANGUAGE_MAP[row.language ?? ""] ?? row.language ?? null,
    location_of_originals: row.locationOfOriginals,
    location_of_copies: row.locationOfCopies,
    // Dropped in 0036 (0% populated); preserved as null in export
    // shape for downstream-snapshot continuity.
    related_materials: null,
    finding_aids: row.findingAids,
    notes: row.notes,
    publication_title: publicationTitle(row.referenceCode, repo.code),
    imprint: row.imprint,
    edition_statement: row.editionStatement,
    series_statement: row.seriesStatement,
    uniform_title: row.uniformTitle,
    section_title: row.sectionTitle,
    pages: row.pages,
    creator_display: row.creatorDisplay,
    place_display: row.placeDisplay,
  };
}
