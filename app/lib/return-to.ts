/**
 * returnTo — cross-surface hand-back links with an open-redirect guard
 *
 * This module deals with the "go create the thing you are missing, then
 * come back" flow (readiness-check journey): a blocking notice links to a
 * creation surface carrying a `returnTo` query parameter, the creation
 * form preserves it through validation-error re-renders in a hidden
 * field, and the create action redirects to it on success INSTEAD of its
 * usual destination.
 *
 * The guard is the load-bearing piece: `returnTo` round-trips through
 * client-controlled form data, so only INTERNAL paths may win. A value
 * qualifies iff it starts with a single "/" — a leading "//" is a
 * scheme-relative external URL and is refused, as is anything with a
 * scheme or any non-string. Refusal returns null and the caller falls
 * back to its usual destination; a bad value must never error a create
 * that otherwise succeeded.
 *
 * @version v0.6.0
 */

/** The guarded returnTo value, or null when it must not be honoured. */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  // Browsers normalise "\" to "/" and strip TAB/LF/CR when parsing a
  // Location URL, so "/\evil.example" and "/\t/evil.example" both
  // resolve scheme-relative external — the classic bypasses of a
  // starts-with-single-slash check. Any of those bytes disqualifies.
  if (/[\\\t\n\r]/.test(value)) return null;
  return value;
}

/** Append a returnTo parameter to an internal path (the notice-link href). */
export function withReturnTo(path: string, returnTo: string): string {
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}returnTo=${encodeURIComponent(returnTo)}`;
}
