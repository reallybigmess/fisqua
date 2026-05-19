/**
 * Export Pipeline Constants
 *
 * This module deals with the static lookup tables shared by the
 * per-entity formatters in this directory: the D1 language-code to
 * display-name map and the description-level hierarchy that tells us
 * what level a child node should be at given its parent.
 *
 * @version v0.3.0
 */

/** Map D1 language codes to display names */
export const LANGUAGE_MAP: Record<string, string> = {
  "192": "Español",
  "173": "Español",
  "195": "Español",
  Spanish: "Español",
};

/** Hierarchy: given a description level, what level are its children */
export const LEVEL_HIERARCHY: Record<string, string> = {
  fonds: "caja",
  collection: "file",
  subfonds: "series",
  series: "subseries",
  subseries: "file",
  file: "item",
};
