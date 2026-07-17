/**
 * Canonical Fisqua template — a GENERATED projection of the union schema
 *
 * This module deals with the discrete Fisqua import/export template (spec
 * §8, ruled 2026-07-12): NOT an adopted external format but a generated
 * projection of the union schema. Where starter profiles serve data an
 * archive ALREADY HOLDS, the canonical template serves data an archive is
 * ABOUT TO CREATE — fill the template, upload, dry-run, commit, with no
 * column mapping to do.
 *
 * The header set is `allowedTargetFields(standard)` verbatim: one header
 * per bindable field (referenceCode and every standard descriptive column)
 * plus the structural `parent` and `legacyIds` columns. The pre-built
 * "Fisqua template" starter binds each header to its own field by direct
 * copy — source === target — so a filled template dry-runs with zero
 * unbound bindings and zero unrecognised headers (a fully symmetric round
 * trip). Because header names ARE field names, blank cells vanish under the
 * pipeline's blank-means-absent rule, so a fresh archive fills only what it
 * has.
 *
 * CONSTRAINT — LOCKSTEP VERSIONING: `CANONICAL_TEMPLATE_VERSION` moves only
 * when the generated header set changes. `CANONICAL_HEADER_SNAPSHOT` pins
 * the emitted headers per standard; the drift test asserts the generator
 * still matches the snapshot, so adding/removing a union-schema field fails
 * the build until the snapshot AND the version are updated together. This
 * keeps the template versioned in lockstep with the schema and validators.
 *
 * CONSTRAINT — EXPORT SHAPE: this same projection is the future export
 * pipeline's emission shape (spec §8: symmetric import/export round-trips).
 * The export work reuses `generateCanonicalHeaders` / the direct-copy
 * projection here rather than re-deriving a second column contract.
 *
 * @version v0.6.0
 */

import type { Standard } from "../standards/types";
import type { ProfileBinding } from "./profile-schema";
import { allowedTargetFields } from "./target-fields";

/** Bumped only when a generated header set below changes (drift test guards). */
export const CANONICAL_TEMPLATE_VERSION = 2;

/** The starter_key stamped on a minted canonical-template profile. */
export const CANONICAL_STARTER_KEY = "fisqua-canonical";

/** Stable default name for a minted canonical-template profile. */
export const CANONICAL_DEFAULT_NAME = "Fisqua template";

/**
 * The template headers for a standard: the union-schema projection verbatim
 * (referenceCode + every descriptive column + structural parent/legacyIds),
 * in `allowedTargetFields` order.
 */
export function generateCanonicalHeaders(standard: Standard): string[] {
  return allowedTargetFields(standard);
}

/**
 * The pre-built "Fisqua template" profile bindings for a standard: each
 * header bound to its own field by direct copy (no transforms — the
 * template is already in Fisqua's own shape). Valid for the standard by
 * construction (every target comes from `allowedTargetFields`).
 */
export function generateCanonicalBindings(standard: Standard): ProfileBinding[] {
  return generateCanonicalHeaders(standard).map((field) => ({
    source: field,
    target: field,
  }));
}

/** The downloadable template CSV — the header row only (spec §8). */
export function canonicalTemplateCsv(standard: Standard): string {
  return generateCanonicalHeaders(standard).join(",") + "\r\n";
}

/**
 * Pinned per-standard header snapshots. The drift test compares
 * `generateCanonicalHeaders(standard)` against these; a mismatch means the
 * union schema changed and BOTH this snapshot and `CANONICAL_TEMPLATE_VERSION`
 * must be updated. Never edit a snapshot without bumping the version.
 */
export const CANONICAL_HEADER_SNAPSHOT: Readonly<Record<Standard, readonly string[]>> = {
  isadg: [
    "referenceCode", "localIdentifier", "title", "translatedTitle", "uniformTitle",
    "descriptionLevel", "resourceType", "genre", "dateExpression", "dateStart",
    "dateEnd", "dateCertainty", "extent", "dimensions", "medium", "repositoryId",
    "provenance", "creatorDisplay", "scopeContent", "arrangement", "ocrText",
    "accessConditions", "reproductionConditions", "language", "locationOfOriginals",
    "locationOfCopies", "findingAids", "notes", "internalNotes", "imprint",
    "editionStatement", "seriesStatement", "volumeNumber", "issueNumber", "pages",
    "publicationTitle", "sectionTitle", "iiifManifestUrl", "hasDigital", "parent",
    "legacyIds",
  ],
  dacs: [
    "referenceCode", "localIdentifier", "title", "translatedTitle", "descriptionLevel",
    "dateExpression", "dateStart", "dateEnd", "extent", "repositoryId", "creatorDisplay",
    "adminBiogHistory", "provenance", "scopeContent", "systemOfArrangement", "arrangement",
    "physicalCharacteristics", "accessConditions", "reproductionConditions", "language",
    "acquisitionInfo", "locationOfOriginals", "locationOfCopies", "findingAids", "notes",
    "internalNotes", "preferredCitation", "iiifManifestUrl", "hasDigital", "parent",
    "legacyIds", "dateCertainty",
  ],
  rad: [
    "title", "translatedTitle", "descriptionLevel", "referenceCode", "localIdentifier",
    "repositoryId", "editionStatement", "dateExpression", "dateStart", "dateEnd",
    "dateCertainty", "extent", "dimensions", "medium", "physicalCharacteristics",
    "imprint", "seriesStatement", "publicationTitle", "creatorDisplay", "provenance",
    "scopeContent", "adminBiogHistory", "systemOfArrangement", "notes", "internalNotes",
    "iiifManifestUrl", "hasDigital", "parent", "legacyIds",
  ],
} as const;
