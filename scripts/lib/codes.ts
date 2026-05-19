/**
 * Scripts — code generation
 *
 * This module deals with the generation of Fisqua entity (`ne-xxxxxx`) and
 * place (`nl-xxxxxx`) codes — 6-character identifiers drawn from a 30-char
 * alphabet (no visually-ambiguous `i/l/o/u/0/1`). They are stable, citable
 * handles surfaced in the URL bar (`/entities/ne-abc234`) and in publications.
 *
 * Two generators live here:
 *
 *   - `generateUniqueCodes(prefix, count)` — fresh-uniqueness across a
 *     single batch via in-memory Set + retry. Used for new (non-import)
 *     entity/place creation in admin UI flows.
 *
 *   - `deterministicCode(prefix, djangoPk)` — same Django pk → same
 *     Fisqua code across rounds. The 6-char body is
 *     SHA-256(`${prefix}:${djangoPk}`) mapped through ALPHABET. The
 *     stability across rounds matters because external publications,
 *     finding aids, and footnotes already cite `ne-/nl-` codes from
 *     prior rounds; refreshing them would silently break those
 *     references. Collisions are vanishingly rare at the production
 *     row counts (~78K entities + ~10K places against 30^6 = 729M
 *     codespace), but the importer still defensively falls back to
 *     `generateUniqueCodes` for any colliding pair to keep the
 *     `entity_code` UNIQUE index honest.
 *
 * @version v0.4.0
 */
import * as crypto from "node:crypto";

/** 30-char alphabet: no i/l/o/u/0/1 to avoid visual ambiguity */
export const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";

/**
 * Generate a batch of unique neogranadina codes using in-memory Set
 * for collision avoidance.
 *
 * @param prefix - "ne" for entities, "nl" for places
 * @param count - Number of unique codes to generate
 * @returns Array of unique codes in {prefix}-{6chars} format
 */
export function generateUniqueCodes(
  prefix: "ne" | "nl",
  count: number
): string[] {
  const codes = new Set<string>();
  let retries = 0;
  const maxRetries = 100;

  while (codes.size < count) {
    const chars = Array.from({ length: 6 }, () =>
      ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    ).join("");
    const code = `${prefix}-${chars}`;

    if (codes.has(code)) {
      retries++;
      if (retries > maxRetries) {
        throw new Error(
          `Failed to generate unique ${prefix} code after ${maxRetries} collision retries`
        );
      }
      continue;
    }

    codes.add(code);
    retries = 0;
  }

  return [...codes];
}

/**
 * Deterministic 6-char code derived from a Django primary key. Same
 * pk → same code across rounds, so external citations to `ne-/nl-`
 * codes survive between rounds of the production import.
 *
 * Hash input is the literal `${prefix}:${djangoPk}` (colon-delimited so
 * `ne:7` and `nl:7` cannot collide structurally). The first 6 bytes of
 * the SHA-256 digest each select an ALPHABET character via mod 30.
 * Callers that detect a collision (two different Django pks producing
 * the same 6-char body within the current import round) fall back to
 * `generateUniqueCodes` for the rare colliding row — at production row
 * counts the probability is ~0.4%.
 *
 * @param prefix - "ne" for entities, "nl" for places
 * @param djangoPk - Django catalog_entity.id / catalog_place.id
 * @returns Code in {prefix}-{6chars} format
 */
export function deterministicCode(prefix: "ne" | "nl", djangoPk: number): string {
  const hash = crypto.createHash("sha256").update(`${prefix}:${djangoPk}`).digest();
  let chars = "";
  for (let i = 0; i < 6; i++) chars += ALPHABET[hash[i] % ALPHABET.length];
  return `${prefix}-${chars}`;
}

// Version: v0.4.0
