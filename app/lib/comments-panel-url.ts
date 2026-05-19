/**
 * Comments Panel URL Helpers
 *
 * This module deals with the pure helpers that encode the currently
 * focused comment thread into the URL search params —
 * `?comments=entry:<id>` or `?comments=flag:<id>` — and decode it on
 * the way back in. Routing selection through ordinary URL state lets
 * the outline, viewer, and flag card stay in sync without a separate
 * client-side store.
 *
 * @version v0.3.0
 */
/**
 * The five kinds of selection the unified comments panel recognises.
 * Mirrors CONTEXT.
 */
export type CommentsPanelSelection =
  | { kind: "entry"; entryId: string }
  | { kind: "page"; pageId: string }
  | { kind: "region"; commentId: string }
  | { kind: "comment"; commentId: string }
  | { kind: "flag"; qcFlagId: string }
  | { kind: "reseg"; resegFlagId: string };

/**
 * Parse a raw `?comments=` query-parameter value into a typed
 * selection. Returns `null` for any input that is missing, empty, or
 * malformed; never throws. Splits on the first colon only so ids
 * containing colons are preserved intact.
 */
export function parseCommentsParam(
  raw: string | null
): CommentsPanelSelection | null {
  if (!raw) return null;
  const colonIdx = raw.indexOf(":");
  if (colonIdx <= 0) return null; // no kind, or leading colon
  const kind = raw.slice(0, colonIdx);
  const id = raw.slice(colonIdx + 1);
  if (!id) return null; // empty id
  switch (kind) {
 case "entry":
 return { kind: "entry", entryId: id };
 case "page":
 return { kind: "page", pageId: id };
 case "region":
 return { kind: "region", commentId: id };
 case "comment":
 return { kind: "comment", commentId: id };
 case "flag":
 return { kind: "flag", qcFlagId: id };
 case "reseg":
 return { kind: "reseg", resegFlagId: id };
 default:
 return null;
  }
}

/**
 * Encode a typed selection back into the canonical `<kind>:<id>` wire
 * format. Returns `null` when the selection is itself `null`, which
 * lets callers funnel their `setSearchParams` logic through a single
 * helper ("null out the param when selection is empty").
 */
export function encodeCommentsParam(
  selection: CommentsPanelSelection | null
): string | null {
  if (!selection) return null;
  switch (selection.kind) {
 case "entry":
 return `entry:${selection.entryId}`;
 case "page":
 return `page:${selection.pageId}`;
 case "region":
 return `region:${selection.commentId}`;
 case "comment":
 return `comment:${selection.commentId}`;
 case "flag":
 return `flag:${selection.qcFlagId}`;
 case "reseg":
 return `reseg:${selection.resegFlagId}`;
  }
}

