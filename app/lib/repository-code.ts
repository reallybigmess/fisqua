/**
 * Repository code suggestion — the house convention, derived not hand-built
 *
 * This module deals with suggesting a repository `code` from the name and
 * country the operator has already entered, following the convention the
 * production rows established: ISO 3166-1 alpha-2 lowercase + "-" + the
 * initials of the significant words of the name — "pe-bn" (Biblioteca
 * Nacional del Perú), "co-ahrb" (Archivo Histórico Regional de Boyacá),
 * "us-sbmal" (Santa Bárbara Mission Archive-Library).
 *
 * "Significant words": stopwords are skipped (Spanish, English, French,
 * and Portuguese articles/prepositions — the languages of the archives
 * this platform serves), hyphenated words count as their parts
 * (Archive-Library → A, L), diacritics are stripped FOR THE CODE ONLY
 * (Bárbara → b), and a word matching the selected country's own name is
 * skipped (Biblioteca Nacional del Perú → bn, not bnp — the country
 * already prefixes the code). The output is a SUGGESTION: the form fills
 * it only while the code field is untouched, and the operator's hand
 * always wins (production's own "co-cihjml" hand-shortens what this
 * derivation would give).
 *
 * Pure string functions — no i18n, no DOM, no server.
 *
 * @version v0.6.0
 */

import type { Country } from "./countries";

/**
 * Words that carry no initial: articles and prepositions of the four
 * languages repository names arrive in. Compared lowercase and
 * diacritic-stripped, so "DE" and "dé" both match.
 */
const STOPWORDS = new Set([
  // Spanish
  "de", "del", "la", "las", "el", "los", "y", "e", "en",
  // English
  "of", "the", "and", "for", "at",
  // French
  "du", "des", "le", "les", "et", "d", "l", "au", "aux",
  // Portuguese
  "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
]);

/** Lowercase and strip combining marks — for code derivation only. */
export function foldForCode(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * The significant words of a name: split on whitespace AND hyphens (a
 * hyphenated word counts as its parts), fold, drop stopwords, drop empty
 * fragments, and drop words matching any of `exclude` (folded) — the
 * country's own names, which the alpha-2 prefix already carries.
 */
export function significantWords(name: string, exclude: readonly string[] = []): string[] {
  const excluded = new Set(exclude.map(foldForCode));
  return name
    .split(/[\s\u2010-\u2015/-]+/)
    .map(foldForCode)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w !== "" && !STOPWORDS.has(w) && !excluded.has(w));
}

/**
 * Suggest a repository code for a name under a chosen country, per the
 * house convention. Null when nothing derivable remains (blank name, or a
 * name made only of stopwords).
 */
export function suggestRepositoryCode(name: string, country: Country): string | null {
  const words = significantWords(name, [country.nameEn, country.nameEs]);
  if (words.length === 0) return null;
  const initials = words.map((w) => w[0]).join("");
  return `${country.alpha2.toLowerCase()}-${initials}`;
}

/**
 * Suggest for a HAND-TYPED code: the operator's own value, country-prefixed
 * — never re-derived from the name (their word is theirs; "test" under the
 * United States suggests "us-test", not initials). The typed value is
 * normalised the way the derivation normalises words (lowercase,
 * diacritics stripped, non-alphanumerics dropped). Null when the value is
 * empty after normalisation OR already carries the country's prefix —
 * nothing to fix.
 */
export function suggestFromTypedCode(typed: string, country: Country): string | null {
  const prefix = `${country.alpha2.toLowerCase()}-`;
  const folded = foldForCode(typed.trim());
  if (folded === "" || folded.startsWith(prefix)) return null;
  const cleaned = folded.replace(/[^a-z0-9]/g, "");
  if (cleaned === "") return null;
  return prefix + cleaned;
}
