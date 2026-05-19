/**
 * Locale-Aware Formatting Helpers
 *
 * This module deals with the small set of locale-aware formatting
 * primitives the UI reaches for when rendering timestamps and numbers
 * to a Colombian Spanish audience. Everything routes through
 * `Intl.RelativeTimeFormat`, `Intl.DateTimeFormat`, and
 * `Intl.NumberFormat` pinned to `es-CO`, so a single `LOCALE` switch
 * controls the entire app's locale presentation.
 *
 * `relativeTime` collapses a unix-ms timestamp into "hace 3 días"-
 * style copy, picking the largest non-zero unit (day, hour, minute,
 * or second) so the surface stays readable as values age out.
 * `formatDate` renders a full Spanish long-form date for
 * archival-facing surfaces, and `formatNumber` applies Colombian
 * thousands-separator conventions (period rather than comma) for
 * tallies on dashboards. Null and undefined inputs collapse to the
 * em-dash glyph so empty cells render uniformly across tables.
 *
 * @version v0.3.0
 */
const LOCALE = "es-CO";

/**
 * Format a timestamp as relative time (e.g., "hace 3 dias").
 * Returns "—" for null or undefined values.
 */
export function relativeTime(timestamp: number | null): string {
  if (!timestamp) return "\u2014";

  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

  if (days > 0) return rtf.format(-days, "day");
  if (hours > 0) return rtf.format(-hours, "hour");
  if (minutes > 0) return rtf.format(-minutes, "minute");
  return rtf.format(0, "second");
}

/**
 * Format a timestamp as a full date (e.g., "3 de julio de 1593").
 */
export function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(timestamp));
}

/**
 * Format a number with Colombian conventions (e.g., 20545 -> "20.545").
 */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat(LOCALE).format(n);
}
