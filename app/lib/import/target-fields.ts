/**
 * Import target fields — the bindable description columns per standard
 *
 * This module deals with the set of description fields a mapping
 * profile may bind a CSV header to. The set is derived from the
 * tenant's descriptive standard (`StandardConfig`), never hardcoded, so
 * a DACS tenant maps against DACS columns and an ISAD(G) tenant against
 * ISAD(G) columns without a per-standard branch in the UI.
 *
 * Three families make up the allowed set:
 *
 *   - every descriptive column declared in the standard's sections,
 *     minus the linker placeholders (`entities`, `places`): v1 imports
 *     descriptions only, and authorities are linked, never minted by an
 *     import (spec §1);
 *   - two structural pseudo-targets the schema owns rather than the
 *     form: `parent` (resolved by parent reference code, spec §3) and
 *     `legacyIds` (the landing spot for source-system identifiers, spec
 *     §2 — never a new typed column per source);
 *   - the supplementary targets: real `descriptions` columns that no
 *     standard's section declares as a form field (a section field is
 *     what a cataloguer fills by hand; these are set by the import's own
 *     machinery instead) but that are still legal to bind directly, for
 *     a migration that arrives already carrying the value.
 *
 * `referenceCode` is always present (it is a standard identity field),
 * which is what makes the profile-schema's "referenceCode binding
 * required" rule satisfiable for every standard.
 *
 * @version v0.6.0
 */

import { getStandardConfig } from "../standards/registry";
import type { Standard } from "../standards/types";

/** Structural targets the profile owns directly, outside the standard's sections. */
export const STRUCTURAL_TARGETS = ["parent", "legacyIds"] as const;

/**
 * Supplementary targets: real `descriptions` columns that the date
 * machinery sets (`app/lib/import/date-parser.ts` spreads a parsed
 * `dateCertainty` into the assembled record — see `validate.ts`), not a
 * field any standard's section declares, but a legal bind target — a
 * migration whose dates arrive already parsed (the SBMAL master is the
 * motivating case) can land certainty directly via a vocabulary
 * transform instead of re-deriving it from free text. Standard-agnostic:
 * `dateCertainty` is `z.string().max(20).optional()` on the shared base
 * schema (`app/lib/validation/description.ts`) with no standard
 * layering a restriction on top, so it validates for every standard.
 */
export const SUPPLEMENTARY_TARGETS = ["dateCertainty"] as const;

/** The identity target every profile must bind (spec §2, §3). */
export const REQUIRED_TARGET = "referenceCode" as const;

// Linker placeholders in a StandardConfig are not real description
// columns and are out of scope for v1 imports (link-never-mint).
const EXCLUDED_COLUMNS = new Set(["entities", "places"]);

/**
 * The ordered list of description fields bindable for a standard. The
 * standard's own section columns first (in declaration order), then the
 * structural pseudo-targets, then the supplementary targets.
 * Deduplicated defensively — a column appearing in two sections, or a
 * supplementary target a standard already declares as a section field
 * (ISAD(G) and RAD both declare `dateCertainty`), still yields one
 * target.
 */
export function allowedTargetFields(standard: Standard): string[] {
  const config = getStandardConfig(standard);
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const section of config.sections) {
    for (const field of section.fields) {
      if (EXCLUDED_COLUMNS.has(field.column)) continue;
      if (seen.has(field.column)) continue;
      seen.add(field.column);
      targets.push(field.column);
    }
  }
  for (const structural of STRUCTURAL_TARGETS) {
    if (!seen.has(structural)) {
      seen.add(structural);
      targets.push(structural);
    }
  }
  for (const supplementary of SUPPLEMENTARY_TARGETS) {
    if (!seen.has(supplementary)) {
      seen.add(supplementary);
      targets.push(supplementary);
    }
  }
  return targets;
}

/** Whether `target` is a valid binding target for `standard`. */
export function isValidTarget(standard: Standard, target: string): boolean {
  return allowedTargetFields(standard).includes(target);
}
