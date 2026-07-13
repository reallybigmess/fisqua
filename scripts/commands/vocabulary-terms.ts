/**
 * Scripts — vocabulary terms importer
 *
 * This module deals with the one-time import of the controlled-vocabulary
 * authority backing the `entities.primary_function` field. It reads
 * `canonical_functions_v2.json` — the JSON dump that the enrichment
 * pipeline produces after collapsing ~27,695 raw Django function strings
 * down to ~16,185 distinct canonical terms — and emits the SQL that lands
 * those terms into `vocabulary_terms`.
 *
 * Two artefacts come out of `importVocabularyTerms`:
 *   1. A batched `INSERT INTO vocabulary_terms` SQL file under `.import/`
 *      that the bulk import CLI applies via wrangler. The COLUMNS array
 *      tracks `app/db/schema.ts:vocabularyTerms` so a column drift here
 *      surfaces as a SQL apply failure rather than a silent NULL.
 *   2. A lookup map JSON (`.import/vocabulary-term-lookup.json`) keyed by
 *      the lowercased raw input string and valued by the generated term
 *      UUID. The companion `vocabulary-migration.ts` script reads that
 *      lookup to rewrite `entities.primary_function_id` on the previously
 *      imported entity rows.
 *
 * Entries with a null canonical (the enrichment couldn't decide) skip the
 * `vocabulary_terms` insert but still appear in the lookup map as `null`,
 * so the downstream migration can route those entities to the explicit
 * "unresolved" branch rather than silently dropping the value.
 *
 * @version v0.4.2
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ImportResult } from "../lib/types";
import { escapeSql, generateInserts, writeSqlFiles } from "../lib/sql";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";

/**
 * Shape of each entry in canonical_functions_v2.json.
 * Keys are the original (raw) function strings; values describe the
 * canonical form, category, entity count, and resolution source.
 */
interface CanonicalFunctionEntry {
  canonical: string | null;
  canonical_parts?: { canonical: string }[];
  category: string | null;
  entity_count: number;
  source: string;
}

/** Intermediate record for a deduplicated canonical term */
interface TermRecord {
  id: string;
  canonical: string;
  category: string | null;
  entityCount: number;
}

const COLUMNS = [
  // federation_id (migration 0045): vocabulary_terms is federation-scoped.
  // The canonical vocabulary import files under the Neogranadina federation.
  "id", "federation_id", "canonical", "category", "status", "merged_into",
  "entity_count", "proposed_by", "reviewed_by", "reviewed_at",
  "notes", "created_at", "updated_at",
];

/**
 * Import vocabulary terms from canonical_functions_v2.json.
 *
 * Deduplicates entries by canonical form — the JSON has ~27,695 input strings
 * mapping to ~16,185 distinct canonicals. Entries with null canonical are
 * skipped from the vocabulary_terms table but still appear in the lookup map
 * (mapped to null) so the migration script can handle them.
 *
 * Also generates a lookup map JSON file (.import/vocabulary-term-lookup.json)
 * mapping every input string (lowercased) to the generated term UUID.
 */
export async function importVocabularyTerms(
  inputPath: string,
  outputDir = ".import"
): Promise<ImportResult> {
  const raw = await fs.readFile(inputPath, "utf8");
  const data = JSON.parse(raw) as Record<string, CanonicalFunctionEntry>;

  const now = Math.floor(Date.now() / 1000);

  // Deduplicate by canonical form
  const termsByCanonical = new Map<string, TermRecord>();
  // Lookup map: lowercased original string -> term UUID (or null for unresolved)
  const lookupMap: Record<string, string | null> = {};

  let totalEntries = 0;
  let skippedNull = 0;

  for (const [originalKey, entry] of Object.entries(data)) {
    totalEntries++;
    const lowerKey = originalKey.toLowerCase();

    if (entry.canonical === null) {
      // Compound or unresolved function — skip from vocabulary_terms
      lookupMap[lowerKey] = null;
      skippedNull++;
      continue;
    }

    const canonical = entry.canonical;
    const canonicalLower = canonical.toLowerCase();

    let term = termsByCanonical.get(canonicalLower);
    if (!term) {
      term = {
        id: crypto.randomUUID(),
        canonical,
        category: entry.category,
        entityCount: 0,
      };
      termsByCanonical.set(canonicalLower, term);
    }

    // Sum entity counts across all entries sharing the same canonical
    term.entityCount += entry.entity_count;

    // Map this input string to the term's UUID
    lookupMap[lowerKey] = term.id;
  }

  // Build SQL rows
  const rows: string[][] = [];
  for (const term of termsByCanonical.values()) {
    rows.push([
      escapeSql(term.id),
      escapeSql(NEOGRANADINA_FEDERATION_ID),
      escapeSql(term.canonical),
      escapeSql(term.category),
      escapeSql("approved"),
      escapeSql(null), // merged_into
      escapeSql(term.entityCount),
      escapeSql(null), // proposed_by
      escapeSql(null), // reviewed_by
      escapeSql(null), // reviewed_at
      escapeSql(null), // notes
      escapeSql(now),
      escapeSql(now),
    ]);
  }

  const statements = generateInserts("vocabulary_terms", COLUMNS, rows, 100);
  const sqlFiles = await writeSqlFiles("vocabulary_terms", statements, 50, outputDir);

  // Write lookup map
  const lookupPath = path.join(outputDir, "vocabulary-term-lookup.json");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(lookupPath, JSON.stringify(lookupMap, null, 2), "utf8");

  return {
    table: "vocabulary_terms",
    total: totalEntries,
    imported: termsByCanonical.size,
    skipped: skippedNull,
    errors: [],
    sqlFiles: [...sqlFiles, lookupPath],
  };
}
