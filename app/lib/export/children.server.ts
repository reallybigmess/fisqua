/**
 * Children Map Builder
 *
 * This module deals with walking a flat list of exported
 * descriptions and building the nested `children` maps that the
 * static frontend uses to render the archival hierarchy without
 * issuing follow-up fetches. Keyed by reference code rather than UUID
 * so that the published JSON stays human-readable.
 *
 * @version v0.3.0
 */

import type { ExportChildEntry } from "./types";

/** Minimal row shape needed for children map generation. */
export interface DescriptionRow {
  id: string;
  parentId: string | null;
  referenceCode: string;
  title: string;
  descriptionLevel: string;
  dateExpression: string | null;
  childCount: number;
  hasDigital: boolean | null;
  position: number;
}

/**
 * Generate a Map of children arrays keyed by parent reference code.
 *
 * Takes an array of published description rows (already filtered to
 * isPublished=true). Groups children by their parent's reference code
 *. Children are sorted
 * by position ascending within each parent.
 *
 * The caller uploads each map entry as `children/{referenceCode}.json`.
 */
export function generateChildrenMap(
  descriptions: DescriptionRow[]
): Map<string, ExportChildEntry[]> {
  // Build lookup: id -> row
  const byId = new Map<string, DescriptionRow>();
  for (const d of descriptions) {
    byId.set(d.id, d);
  }

  // Group children by parent id
  const childrenByParentId = new Map<string, DescriptionRow[]>();
  for (const d of descriptions) {
    if (d.parentId === null) continue;
    const group = childrenByParentId.get(d.parentId);
    if (group) {
      group.push(d);
    } else {
      childrenByParentId.set(d.parentId, [d]);
    }
  }

  // Build result map keyed by parent reference code
  const result = new Map<string, ExportChildEntry[]>();

  for (const [parentId, children] of childrenByParentId) {
    const parent = byId.get(parentId);
    if (!parent) continue;

    // Sort by position ascending
    const sorted = [...children].sort((a, b) => a.position - b.position);

    const entries: ExportChildEntry[] = sorted.map((child) => ({
      id: child.id,
      reference_code: child.referenceCode,
      title: child.title,
      description_level: child.descriptionLevel,
      date_expression: child.dateExpression,
      has_children: child.childCount > 0,
      child_count: child.childCount,
      has_digital: child.hasDigital ?? false,
    }));

    result.set(parent.referenceCode, entries);
  }

  return result;
}
