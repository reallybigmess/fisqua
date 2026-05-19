/**
 * XML Emit and R2 Key Helpers
 *
 * This module deals with the shared XML utilities factored out of
 * `mets-builder.ts` so the METS, EAD3, and Dublin Core builders use
 * one source of truth for escaping, single-element emission, and
 * reference-code-to-R2-key sanitation. The string-replace approach is
 * deliberately the same as the original — a small Worker bundle is
 * the design constraint that motivates not pulling in an XML library.
 *
 * Every interpolated value flowing into `mets-builder.ts`,
 * `app/lib/export/ead/builder.ts`, and `app/lib/export/dc/builder.ts`
 * passes through `escapeXml` before concatenation.
 * Reference-code-derived R2 keys pass through `sanitiseRefForKey` to
 * close the path-traversal vector.
 *
 * @version v0.4.0
 */

/**
 * Escape XML special characters to prevent injection.
 *
 * Apostrophe (`'`) is escaped to `&apos;` for completeness against the
 * W3C XML 1.0 §2.4 list of attribute-value-disallowed characters. The
 * current callers wrap interpolated values in double quotes, so
 * unescaped apostrophes inside them are safe today, but a future
 * refactor to single-quoted attributes (XML permits both) would
 * silently break well-formedness without this entity. The threat
 * model assumes every interpolated value flows through escapeXml —
 * return the full canonical set.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Emit a non-empty single element; returns "" when text is null/empty. */
export function el(tag: string, text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `    <${tag}>${escapeXml(trimmed)}</${tag}>\n`;
}

/**
 * Strip path-traversal and URL-syntactic characters from a reference
 * code before using it as an R2 key.
 *
 * Previously this function only stripped `?` and `#`. R2 reference
 * codes come from `descriptions.referenceCode`,
 * a user-supplied D1 column with no character constraints — a
 * reference code containing `/`, `\`, or `..` could create R2 path
 * traversal (e.g. `co-ahr/gob` would create
 * `neogranadina/descriptions-co-ahr/gob.json`, two segments instead
 * of one). Strip the full path-traversal set in addition to the URL
 * syntactic two so the resulting key is always a single, bounded
 * segment within the tenant's R2 prefix.
 *
 * The `..` sequence is collapsed before the per-character strip so
 * `../etc` does not survive as `etc`. `\\` and `/` collapse to empty
 * to keep the key segment-bounded.
 */
export function sanitiseRefForKey(ref: string): string {
  return ref
    .replace(/\.\.+/g, "") // path-traversal segments
    .replace(/[/\\]/g, "") // path separators (forward and back)
    .replace(/[?#]/g, ""); // URL-syntactic characters
}
