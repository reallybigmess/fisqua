/**
 * Project Settings Helpers
 *
 * This module deals with typed readers and writers for the
 * per-project settings JSON blob. It exposes helpers for the
 * document subtype list, description conventions, and the rest of
 * the structured settings that live alongside the free-form JSON
 * textarea on the project settings page.
 *
 * @version v0.3.0
 */
import { DEFAULT_DOCUMENT_SUBTYPES } from "../_data/document-subtypes";

export type ProjectSettings = {
  /**
   * Per-project document subtype list. When absent, callers get the
   * seeded `DEFAULT_DOCUMENT_SUBTYPES`. Never stored empty: setter
   * drops the key when the cataloguer clears the list so read falls
   * back to the seed.
   */
  documentSubtypes?: string[];
};

const EMPTY_SETTINGS: ProjectSettings = Object.freeze({});

/**
 * Parse a raw settings blob. Guarantees a plain object shape; malformed
 * / null / array inputs all coerce to `{}` so downstream accessors
 * never see a type surprise.
 */
export function readProjectSettings(raw: string | null | undefined): ProjectSettings {
  if (raw == null) return EMPTY_SETTINGS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return EMPTY_SETTINGS;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_SETTINGS;
    }
    return parsed as ProjectSettings;
  } catch {
    return EMPTY_SETTINGS;
  }
}

/**
 * Serialise a settings object for DB storage. Returns `null` when the
 * object is empty so the DB column stays NULL rather than `{}` -- this
 * matches the existing project-creation flow that uses plain NULL
 * defaults.
 */
export function writeProjectSettings(settings: ProjectSettings): string | null {
  // Drop keys that resolve to the seed-equivalent shape so round-trips
  // through the editor do not add spurious "customised" state.
  const payload: ProjectSettings = {};
  if (settings.documentSubtypes && settings.documentSubtypes.length > 0) {
    payload.documentSubtypes = [...settings.documentSubtypes];
  }
  const keys = Object.keys(payload);
  if (keys.length === 0) return null;
  // Stable key ordering for legible diffs.
  keys.sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = (payload as Record<string, unknown>)[k];
  return JSON.stringify(ordered);
}

/**
 * Resolve the effective document-subtype list for a project. Called by
 * every UI / server surface that needs to show the picklist, including
 * the settings editor itself (which lets the lead edit the resolved
 * list rather than starting from nothing).
 */
export function getDocumentSubtypes(raw: string | null | undefined): string[] {
  const settings = readProjectSettings(raw);
  const list = settings.documentSubtypes;
  if (!Array.isArray(list) || list.length === 0) {
    return [...DEFAULT_DOCUMENT_SUBTYPES];
  }
  // Filter to non-empty strings to guard against dirty JSON.
  const clean = list
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (clean.length === 0) return [...DEFAULT_DOCUMENT_SUBTYPES];
  return clean;
}

/**
 * Replace the document-subtype list on an existing settings blob.
 * Empty / all-whitespace incoming lists drop the key entirely so the
 * resolver falls back to the seed on next read.
 */
export function setDocumentSubtypes(
  raw: string | null | undefined,
  subtypes: readonly string[],
): string | null {
  // Clone via spread to guard against the frozen EMPTY_SETTINGS sentinel
  // returned by readProjectSettings on null / malformed input. Direct
  // mutation on the sentinel throws in strict mode.
  const settings: ProjectSettings = { ...readProjectSettings(raw) };
  const clean = subtypes
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (clean.length === 0) {
    delete settings.documentSubtypes;
  } else {
    settings.documentSubtypes = clean;
  }
  return writeProjectSettings(settings);
}

