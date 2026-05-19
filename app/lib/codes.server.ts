/**
 * Reference Code Helpers
 *
 * This module deals with the server-side utilities for generating and
 * validating archival reference codes: per-fonds sequence increment,
 * duplicate detection, and the format rules that keep codes legible
 * across every surface that renders them.
 *
 * @version v0.3.0
 */
import { eq } from "drizzle-orm";

/** 30-char alphabet: no i/l/o/u/0/1 to avoid visual ambiguity */
const ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";

function generateCode(prefix: "ne" | "nl"): string {
  const chars = Array.from({ length: 6 }, () =>
    ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  ).join("");
  return `${prefix}-${chars}`;
}

/**
 * Generate a unique neogranadina code with collision retry.
 * Prefixes: "ne" for entities, "nl" for places.
 */
export async function generateUniqueCode(
  db: any,
  prefix: "ne" | "nl",
  table: any,
  codeColumn: any,
  maxRetries = 5
): Promise<string> {
  for (let i = 0; i < maxRetries; i++) {
    const code = generateCode(prefix);
    const existing = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(codeColumn, code))
      .get();
    if (!existing) return code;
  }
  throw new Error(
    `Failed to generate unique ${prefix} code after ${maxRetries} retries`
  );
}
