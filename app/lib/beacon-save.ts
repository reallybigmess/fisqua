/**
 * Beacon Save Body Builders
 *
 * This module deals with the pure helpers that isolate
 * `navigator.sendBeacon`'s payload-shape quirks behind a testable
 * seam. They are used to flush unsaved editor work as a best-effort
 * fire-and-forget when the user confirms an outgoing navigation.
 *
 * Why pure helpers:
 *
 *   - `navigator.sendBeacon` is not available under the Cloudflare
 *     Workers test pool nor under jsdom; mocking it inside route
 *     tests is awkward. The pill of logic that genuinely needs
 *     testing — the request body shape and the 64 KiB size guard —
 *     lives here as plain functions, with no Web API surface other
 *     than `Blob` (which Workers pool + node both ship natively).
 *
 *   - The two consumer routes need different body types:
 *       - description editor → JSON `Blob`
 *         (POST `/api/description/save` with `{ entryId, fields }`)
 *       - segmentation viewer → `FormData`
 *         (POST `/api/entries/save` with `volumeId` + serialised entries)
 *     Both endpoints already exist (research §2, "API endpoints —
 *     already exist") and accept the payloads the editors already
 *     send; sendBeacon's session cookie travels automatically.
 *
 * Beacon size guard (RESEARCH §2 + MDN):
 *
 *   `navigator.sendBeacon` silently drops payloads above 64 KiB. We
 *   apply a 60 KiB ceiling to leave one symbolic byte of headroom
 *   and to make the boundary semantic deterministic for tests. The
 *   guard is strict less-than: at exactly `BEACON_MAX_BYTES`,
 *   `shouldSendBeacon` returns `false`. Plan-checker LOW-02.
 *
 * @version v0.4.1
 */

/**
 * Maximum payload byte size we will hand to `navigator.sendBeacon`.
 * Strictly less than this is sent; at or above this we skip the
 * beacon and let the confirm dialog proceed without a flush.
 */
export const BEACON_MAX_BYTES = 60 * 1024;

/**
 * Whether a payload of `byteSize` bytes is small enough to send via
 * `navigator.sendBeacon`. Strict less-than against
 * `BEACON_MAX_BYTES`; see file header for rationale.
 */
export function shouldSendBeacon(byteSize: number): boolean {
  return byteSize < BEACON_MAX_BYTES;
}

/**
 * Build the request body for a description-editor beacon flush.
 * The endpoint `/api/description/save` expects JSON, so the Blob is
 * tagged `application/json` — sendBeacon requires the explicit Blob
 * wrapper for JSON (it cannot infer the content-type otherwise).
 */
export function buildDescriptionBeaconBody(
  entryId: string,
  fields: Record<string, unknown>,
): Blob {
  const payload = JSON.stringify({ entryId, fields });
  return new Blob([payload], { type: "application/json" });
}

/**
 * Build the request body for a segmentation-viewer beacon flush.
 * The endpoint `/api/entries/save` expects FormData (volumeId +
 * entries-as-JSON-string), which is a first-class sendBeacon body
 * type — no Blob wrapping needed. The content-type is set
 * automatically by the browser to `multipart/form-data` with a
 * boundary, matching what the route's loader already parses.
 */
export function buildEntriesBeaconBody(
  volumeId: string,
  entries: unknown,
): FormData {
  const fd = new FormData();
  fd.set("volumeId", volumeId);
  fd.set("entries", JSON.stringify(entries));
  return fd;
}

/* @version v0.4.1 */
