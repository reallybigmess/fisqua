/**
 * Authority linked-description context — rich card data for the
 * merge/split workbenches
 *
 * The merge and split workbenches (spec §4) show each linked
 * description as a "linked description" card rather than a bare title +
 * count. This module owns the server-side computation behind those
 * cards:
 *
 *   - `extractScopeSnippet` — a pure, offset-faithful window of
 *     `scopeContent` around the first accent-/case-insensitive match of
 *     an anchor (the junction's `nameAsRecorded`, falling back to the
 *     authority record's display name; for places always the place's
 *     display name). It mirrors the `normaliseName` normalisation from
 *     the 3b duplicates work (NFD accent-strip + lowercase + punctuation
 *     folding) but keeps a per-character map back to the ORIGINAL
 *     string, so the highlighted span shows the text exactly as it
 *     appears in the source (production scope texts spell "Agustin
 *     Sanchez" without accents while `nameAsRecorded` carries them). The
 *     fallback ladder never fabricates text: match → window + highlight;
 *     no match but scope present → head of scope, no highlight; no scope
 *     → null.
 *
 *   - `loadLinkedDescriptionCards` — groups a record's junction rows BY
 *     DESCRIPTION (one description = one card even with several roles),
 *     caps the visible cards, and batches the per-description place and
 *     repository lookups over the visible ids (no N+1). Serves both the
 *     entity and place workbenches, on both merge sides and the split
 *     assignment list.
 *
 * @version v0.4.3
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";

/** Records per side rendered as cards; honest totals report the rest. */
export const LINKED_CARD_CAP = 25;

/** Default character window for a scope snippet (approximate). */
export const SCOPE_WINDOW = 160;

/** OCR first-match window (~140 each side of the match — a transcript is
 * denser than a curated scope note, so it earns a wider first look). */
export const OCR_WINDOW = 280;

/** Wide capped OCR window (~1.5 KB centred on the first match) shipped
 * with the card for "Show more"; the full transcript (up to 89 KB) is
 * fetched only on "Show all" (`&full=1`). */
export const OCR_WIDE = 1500;

/** Full-scope ship cap. Scope notes cap at ~6.3 KB, so the whole note
 * rides the card payload for "Show more"; OCR never does. */
export const SCOPE_CAP = 6300;

/**
 * Which text a snippet came from (the ruled ladder, spec §5):
 *   - `scope`      accent-insensitive name match in `scope_content`;
 *   - `ocr`        no scope match — matched in `ocr_text` instead;
 *   - `scope-head` no name match anywhere — head of a non-empty scope.
 */
export type SnippetSource = "scope" | "ocr" | "scope-head";

/**
 * A scope snippet split into the text before the match, the matched
 * text (empty when there is no highlight — the head-of-scope fallback),
 * and the text after. `truncatedStart`/`truncatedEnd` say whether the
 * window was clipped from the surrounding scope (the UI renders an
 * ellipsis).
 */
export interface ScopeSnippet {
  source: SnippetSource;
  before: string;
  /** The original-string span that matched the anchor; "" = no highlight. */
  match: string;
  after: string;
  truncatedStart: boolean;
  truncatedEnd: boolean;
}

/**
 * A card snippet: the collapsed window (a `ScopeSnippet` — the merge/split
 * card renders it verbatim, now carrying `source`) plus the on-demand
 * expansion payload the detail-page unfold panel needs. `wide` is the
 * "Show more" text — the whole scope note (scope tier, ≤ SCOPE_CAP) or a
 * wide capped OCR window (ocr tier) — and `anchors` are the name(s) the
 * client re-matches (accent-insensitively) to highlight and step through
 * every occurrence in whatever text is currently shown.
 */
export interface CardSnippet extends ScopeSnippet {
  anchors: string[];
  /** "Show more" text; null when the window already shows everything. */
  wide: string | null;
  /** OCR transcript length in chars (ocr tier only) — drives the caption
   * and whether "Show all" (`&full=1`) has more than `wide`. */
  ocrLength: number | null;
}

/** One normalised character mapped back to its original-string span. */
interface NormChar {
  ch: string;
  srcStart: number;
  srcEnd: number;
}

const ALNUM = /[\p{L}\p{N}]/u;

/**
 * Normalise a string the same way `normaliseName` does (NFD
 * accent-strip, lowercase, punctuation/space folded to a single space,
 * trimmed) while recording, for every emitted character, the
 * [srcStart, srcEnd) span of the ORIGINAL string it came from. This is
 * what lets a match found in normalised space map back to the exact
 * original offsets for highlighting.
 */
function normaliseWithMap(s: string): { norm: string; map: NormChar[] } {
  const map: NormChar[] = [];
  let sepPending = false;
  let sepSrc = -1;
  for (let i = 0; i < s.length; i++) {
    const decomposed = s[i]
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
    if (decomposed.length === 0) {
      // Pure combining mark that stripped to nothing (an accent stored as
      // its own code point, i.e. NFD/decomposed source text). `normaliseName`
      // removes these in place BEFORE folding punctuation, so the base
      // letters on either side stay adjacent — it is NOT a separator.
      // Skipping it (rather than opening a separator) keeps this normaliser
      // in lockstep with `normaliseName` for decomposed input. The mark's
      // original code point still falls inside [matchStart, matchEnd), so a
      // highlight slice reproduces the source spelling faithfully.
      continue;
    }
    for (const dc of decomposed) {
      if (ALNUM.test(dc)) {
        // Emit a single collapsed space between tokens (never leading).
        if (sepPending && map.length > 0) {
          map.push({ ch: " ", srcStart: sepSrc, srcEnd: sepSrc + 1 });
        }
        sepPending = false;
        sepSrc = -1;
        map.push({ ch: dc, srcStart: i, srcEnd: i + 1 });
      } else if (!sepPending) {
        sepPending = true;
        sepSrc = i;
      }
    }
  }
  return { norm: map.map((m) => m.ch).join(""), map };
}

/** Move `pos` forward to just after the next whitespace within
 * [pos, limit), else return `pos` — a window must open on a word
 * boundary and never cross into the match region (limit). */
function snapForward(text: string, pos: number, limit: number): number {
  for (let i = pos; i < limit; i++) {
    if (/\s/.test(text[i])) return i + 1;
  }
  return pos;
}

/** Move `pos` back to just before the previous whitespace, if any lies
 * in (limit, pos); otherwise return `pos`. */
function snapBack(text: string, pos: number, limit: number): number {
  for (let i = pos - 1; i > limit; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return pos;
}

/**
 * Extract a ~`windowSize`-character snippet of `scopeContent` around the
 * first accent-/case-insensitive match of `anchor`, with the matched
 * ORIGINAL text isolated for highlighting. Pure and deterministic.
 *
 * Fallback ladder (never fabricates text):
 *   (a) anchor matches            → window + highlight;
 *   (b) no match, scope present   → head of scope (~windowSize), no highlight;
 *   (c) no scope                  → null.
 * A null/empty anchor collapses to (b)/(c).
 */
export function extractScopeSnippet(
  scopeContent: string | null | undefined,
  anchor: string | null | undefined,
  windowSize: number = SCOPE_WINDOW,
): ScopeSnippet | null {
  const scope = scopeContent ?? "";
  if (scope.trim().length === 0) return null;
  const len = scope.length;

  const anchorNorm = anchor ? normaliseWithMap(anchor).norm : "";
  if (anchorNorm.length > 0) {
    const { norm: scopeNorm, map } = normaliseWithMap(scope);
    const idx = scopeNorm.indexOf(anchorNorm);
    if (idx >= 0) {
      const matchStart = map[idx].srcStart;
      const matchEnd = map[idx + anchorNorm.length - 1].srcEnd;
      const matchLen = matchEnd - matchStart;
      const pad = Math.max(0, Math.floor((windowSize - matchLen) / 2));

      let start = Math.max(0, matchStart - pad);
      let end = Math.min(len, matchEnd + pad);
      // Reclaim the window on the side that was clamped so the snippet
      // stays close to windowSize.
      if (start === 0) end = Math.min(len, end + (pad - (matchStart - start)));
      if (end === len) start = Math.max(0, start - (pad - (end - matchEnd)));

      // Snap to word boundaries, never crossing into the match itself.
      if (start > 0) start = snapForward(scope, start, matchStart);
      if (end < len) end = snapBack(scope, end, matchEnd);

      return {
        source: "scope",
        before: scope.slice(start, matchStart),
        match: scope.slice(matchStart, matchEnd),
        after: scope.slice(matchEnd, end),
        truncatedStart: start > 0,
        truncatedEnd: end < len,
      };
    }
  }

  // Fallback (b): head of the scope, no highlight.
  let end = Math.min(len, windowSize);
  if (end < len) end = snapBack(scope, end, 0);
  return {
    source: "scope-head",
    before: scope.slice(0, end),
    match: "",
    after: "",
    truncatedStart: false,
    truncatedEnd: end < len,
  };
}

/** Offsets [start, end) of the first accent-/case-insensitive match of
 * `anchor` in `text`, mapped back to the ORIGINAL string, or null. Shares
 * the `normaliseWithMap` normalisation so it agrees with the snippet
 * windowing and `normaliseName`. */
function firstMatchOffset(
  text: string,
  anchor: string,
): { start: number; end: number } | null {
  const anchorNorm = normaliseWithMap(anchor).norm;
  if (anchorNorm.length === 0) return null;
  const { norm, map } = normaliseWithMap(text);
  const idx = norm.indexOf(anchorNorm);
  if (idx < 0) return null;
  return { start: map[idx].srcStart, end: map[idx + anchorNorm.length - 1].srcEnd };
}

/** A raw wide window of `text` centred on [off.start, off.end), capped at
 * `wide` chars. Ellipsis is the caller's (client-side) concern; the match
 * is re-found and highlighted client-side over this slice. */
function wideSlice(
  text: string,
  off: { start: number; end: number },
  wide: number,
): string {
  const half = Math.floor(wide / 2);
  const start = Math.max(0, off.start - half);
  const end = Math.min(text.length, off.end + half);
  return text.slice(start, end);
}

/**
 * Build the full card snippet for one description, applying the ruled
 * ladder (spec §5) over its scope note and OCR transcript:
 *   (a) name matches in `scopeContent`  → scope window (+ full scope for
 *       "Show more", ≤ SCOPE_CAP);
 *   (b) else matches in `ocrText`        → OCR window flagged `ocr` (+ a
 *       wide capped window for "Show more"; "Show all" fetches the rest);
 *   (c) else non-empty scope             → head of scope, no highlight;
 *   (d) else                             → null.
 * Pure and deterministic. The client re-runs the accent-insensitive match
 * over whatever text it currently shows (window / wide / full) to
 * highlight and count occurrences — see `CardSnippet.anchors`.
 */
export function buildCardSnippet(
  scopeContent: string | null | undefined,
  ocrText: string | null | undefined,
  anchor: string | null | undefined,
): CardSnippet | null {
  const anchorStr = anchor && anchor.trim().length > 0 ? anchor : "";
  const anchors = anchorStr ? [anchorStr] : [];
  const scope = scopeContent ?? "";
  const ocr = ocrText ?? "";

  // (a) scope match
  if (anchorStr) {
    const s = extractScopeSnippet(scope, anchorStr, SCOPE_WINDOW);
    if (s && s.source === "scope") {
      const windowLen = s.before.length + s.match.length + s.after.length;
      const wide = scope.length > windowLen ? scope.slice(0, SCOPE_CAP) : null;
      return { ...s, anchors, wide, ocrLength: null };
    }
  }

  // (b) OCR match — only when the name is actually found in the transcript
  // (a head-of-OCR fallback is never surfaced; the ladder falls to scope).
  if (anchorStr && ocr.trim().length > 0) {
    const s = extractScopeSnippet(ocr, anchorStr, OCR_WINDOW);
    if (s && s.source === "scope") {
      const off = firstMatchOffset(ocr, anchorStr);
      const wide = off ? wideSlice(ocr, off, OCR_WIDE) : null;
      const windowLen = s.before.length + s.match.length + s.after.length;
      return {
        ...s,
        source: "ocr",
        anchors,
        wide: wide && wide.length > windowLen ? wide : null,
        ocrLength: ocr.length,
      };
    }
  }

  // (c) head of a non-empty scope
  if (scope.trim().length > 0) {
    const s = extractScopeSnippet(scope, "", SCOPE_WINDOW)!;
    const wide = scope.length > s.before.length ? scope.slice(0, SCOPE_CAP) : null;
    return { ...s, anchors, wide, ocrLength: null };
  }

  // (d) nothing
  return null;
}

/** One record (place or entity) linked to a description — a metadata-strip
 * chip on the merge/split card, and a grouped-by-role chip on the detail
 * unfold panel. `isCurrent` marks the record the worklist belongs to, so
 * the unfold panel can highlight it (set only by the single-junction
 * loader; the merge/split batch loader leaves it undefined). */
export interface CardPlace {
  name: string;
  role: string;
  isCurrent?: boolean;
}

/** Server-computed data for one linked-description card. */
export interface LinkedDescriptionCardData {
  descriptionId: string;
  title: string;
  referenceCode: string;
  /** One entry per junction row on this description (distinct roles). */
  roles: { role: string; roleRaw: string | null }[];
  /** Every junction-row id on this description — assigned as one unit. */
  linkIds: string[];
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  extent: string | null;
  repositoryName: string | null;
  places: CardPlace[];
  /** Entity workbenches only; the chosen row's `nameAsRecorded`. */
  nameAsRecorded: string | null;
  /** `roleRaw` of the chosen `nameAsRecorded` row, for the as-recorded line. */
  asRecordedRoleRaw: string | null;
  /** Canonical role of the chosen `nameAsRecorded` row. */
  asRecordedRole: string | null;
  snippet: CardSnippet | null;
  /** Entity-record unfold panel only: the description's linked ENTITIES
   * grouped by their role, with the current entity flagged. Empty for
   * place records and unset by the merge/split batch loader. */
  entities?: CardPlace[];
}

export interface LinkedDescriptionCardList {
  cards: LinkedDescriptionCardData[];
  /** Distinct descriptions linked to the record (uncapped). */
  totalCards: number;
  /** Junction rows linked to the record (uncapped). */
  totalLinks: number;
  /** Description cards hidden by the cap (totalCards − cards.length). */
  hiddenCards: number;
  /** Every junction-row id on the record, capped and hidden alike — the
   * merge default moves all of them, so the client needs the full set. */
  allLinkIds: string[];
}

interface JunctionRow {
  linkId: string;
  descriptionId: string;
  role: string;
  roleRaw: string | null;
  nameAsRecorded: string | null;
  title: string;
  referenceCode: string;
  dateExpression: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  extent: string | null;
  repositoryId: string;
  scopeContent: string | null;
  ocrText: string | null;
  order: number;
}

/**
 * Build the linked-description cards for one authority record. Groups
 * the record's junction rows by description (preserving first-appearance
 * order), caps the visible cards at `cap`, and batches the place and
 * repository lookups over the visible description ids. `displayName` is
 * the anchor fallback (and the sole anchor for places, whose junction
 * has no `nameAsRecorded`).
 */
export async function loadLinkedDescriptionCards(
  db: DrizzleD1Database<any>,
  args: {
    recordType: "entity" | "place";
    ownerId: string;
    displayName: string;
    cap?: number;
  },
): Promise<LinkedDescriptionCardList> {
  const { and, eq, inArray, asc } = await import("drizzle-orm");
  const {
    descriptions,
    descriptionEntities,
    descriptionPlaces,
    repositories,
    places,
  } = await import("../db/schema");

  const cap = args.cap ?? LINKED_CARD_CAP;

  // Pull the record's junction rows joined to their descriptions. The
  // entity junction carries nameAsRecorded/sequence; the place junction
  // has neither (order by createdAt), so we normalise both into
  // JunctionRow.
  let rows: JunctionRow[];
  if (args.recordType === "entity") {
    const raw = await db
      .select({
        linkId: descriptionEntities.id,
        descriptionId: descriptionEntities.descriptionId,
        role: descriptionEntities.role,
        roleRaw: descriptionEntities.roleRaw,
        nameAsRecorded: descriptionEntities.nameAsRecorded,
        sequence: descriptionEntities.sequence,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        dateExpression: descriptions.dateExpression,
        dateStart: descriptions.dateStart,
        dateEnd: descriptions.dateEnd,
        extent: descriptions.extent,
        repositoryId: descriptions.repositoryId,
        scopeContent: descriptions.scopeContent,
      })
      .from(descriptionEntities)
      .innerJoin(
        descriptions,
        eq(descriptionEntities.descriptionId, descriptions.id),
      )
      .where(eq(descriptionEntities.entityId, args.ownerId))
      .orderBy(asc(descriptionEntities.sequence))
      .all();
    rows = raw.map((r, i) => ({
      linkId: r.linkId,
      descriptionId: r.descriptionId,
      role: r.role,
      roleRaw: r.roleRaw,
      nameAsRecorded: r.nameAsRecorded,
      title: r.title,
      referenceCode: r.referenceCode,
      dateExpression: r.dateExpression,
      dateStart: r.dateStart,
      dateEnd: r.dateEnd,
      extent: r.extent,
      repositoryId: r.repositoryId,
      scopeContent: r.scopeContent,
      // OCR is fetched only for the visible (capped) descriptions below —
      // transcripts reach 89 KB and must never be selected across every
      // junction row.
      ocrText: null,
      order: i,
    }));
  } else {
    const raw = await db
      .select({
        linkId: descriptionPlaces.id,
        descriptionId: descriptionPlaces.descriptionId,
        role: descriptionPlaces.role,
        roleRaw: descriptionPlaces.roleRaw,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        dateExpression: descriptions.dateExpression,
        dateStart: descriptions.dateStart,
        dateEnd: descriptions.dateEnd,
        extent: descriptions.extent,
        repositoryId: descriptions.repositoryId,
        scopeContent: descriptions.scopeContent,
      })
      .from(descriptionPlaces)
      .innerJoin(
        descriptions,
        eq(descriptionPlaces.descriptionId, descriptions.id),
      )
      .where(eq(descriptionPlaces.placeId, args.ownerId))
      .orderBy(asc(descriptionPlaces.createdAt))
      .all();
    rows = raw.map((r, i) => ({
      linkId: r.linkId,
      descriptionId: r.descriptionId,
      role: r.role,
      roleRaw: r.roleRaw,
      nameAsRecorded: null,
      title: r.title,
      referenceCode: r.referenceCode,
      dateExpression: r.dateExpression,
      dateStart: r.dateStart,
      dateEnd: r.dateEnd,
      extent: r.extent,
      repositoryId: r.repositoryId,
      scopeContent: r.scopeContent,
      // OCR is fetched only for the visible (capped) descriptions below —
      // transcripts reach 89 KB and must never be selected across every
      // junction row.
      ocrText: null,
      order: i,
    }));
  }

  // Group by description, preserving first-appearance order.
  const groups = new Map<string, JunctionRow[]>();
  for (const row of rows) {
    const g = groups.get(row.descriptionId);
    if (g) g.push(row);
    else groups.set(row.descriptionId, [row]);
  }

  const totalCards = groups.size;
  const totalLinks = rows.length;
  const visibleIds = Array.from(groups.keys()).slice(0, cap);

  // Batch the per-description place + repository lookups over the
  // visible descriptions only (bounded by the cap — no N+1).
  const placesByDescription = new Map<string, CardPlace[]>();
  const repoNameById = new Map<string, string>();
  if (visibleIds.length > 0) {
    const placeRows = await db
      .select({
        descriptionId: descriptionPlaces.descriptionId,
        name: places.displayName,
        role: descriptionPlaces.role,
      })
      .from(descriptionPlaces)
      .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
      .where(inArray(descriptionPlaces.descriptionId, visibleIds))
      .all();
    for (const p of placeRows) {
      const list = placesByDescription.get(p.descriptionId);
      const entry = { name: p.name, role: p.role };
      if (list) list.push(entry);
      else placesByDescription.set(p.descriptionId, [entry]);
    }

    const repoIds = Array.from(
      new Set(visibleIds.map((id) => groups.get(id)![0].repositoryId)),
    );
    if (repoIds.length > 0) {
      const repoRows = await db
        .select({ id: repositories.id, name: repositories.name })
        .from(repositories)
        .where(inArray(repositories.id, repoIds))
        .all();
      for (const r of repoRows) repoNameById.set(r.id, r.name);
    }
  }

  // OCR transcripts for the visible descriptions only (bounded by the
  // cap) — the ladder consults them when the name is absent from scope.
  const ocrByDescription = new Map<string, string | null>();
  if (visibleIds.length > 0) {
    const ocrRows = await db
      .select({ id: descriptions.id, ocrText: descriptions.ocrText })
      .from(descriptions)
      .where(inArray(descriptions.id, visibleIds))
      .all();
    for (const r of ocrRows) ocrByDescription.set(r.id, r.ocrText);
  }

  const cards: LinkedDescriptionCardData[] = visibleIds.map((descId) => {
    const g = groups.get(descId)!;
    const first = g[0];
    // Anchor: the row with a non-empty nameAsRecorded (entity only);
    // otherwise the record's display name (always, for places).
    const asRecordedRow = g.find(
      (r) => r.nameAsRecorded && r.nameAsRecorded.trim().length > 0,
    );
    const anchor =
      args.recordType === "place"
        ? args.displayName
        : (asRecordedRow?.nameAsRecorded ?? args.displayName);

    return {
      descriptionId: descId,
      title: first.title,
      referenceCode: first.referenceCode,
      roles: g.map((r) => ({ role: r.role, roleRaw: r.roleRaw })),
      linkIds: g.map((r) => r.linkId),
      dateExpression: first.dateExpression,
      dateStart: first.dateStart,
      dateEnd: first.dateEnd,
      extent: first.extent,
      repositoryName: repoNameById.get(first.repositoryId) ?? null,
      places: placesByDescription.get(descId) ?? [],
      nameAsRecorded: asRecordedRow?.nameAsRecorded ?? null,
      asRecordedRoleRaw: asRecordedRow?.roleRaw ?? null,
      asRecordedRole: asRecordedRow?.role ?? null,
      snippet: buildCardSnippet(
        first.scopeContent,
        ocrByDescription.get(descId) ?? null,
        anchor,
      ),
    };
  });

  return {
    cards,
    totalCards,
    totalLinks,
    hiddenCards: Math.max(0, totalCards - cards.length),
    allLinkIds: rows.map((r) => r.linkId),
  };
}

/**
 * Build ONE linked-description card for a single junction row, on
 * demand — the click-to-unfold context card on the authority detail
 * worklist. The junction id MUST belong to `ownerId`: the lookup is
 * scoped to the owner's junction table, so a junction id from another
 * record (an IDOR probe) resolves to null, never another record's
 * scope text. The card groups every one of the owner's junction rows
 * that share the resolved description (so a description linked under
 * several roles shows all its role chips), exactly as the merge/split
 * cards do.
 */
export async function loadLinkedDescriptionCard(
  db: DrizzleD1Database<any>,
  args: {
    recordType: "entity" | "place";
    ownerId: string;
    displayName: string;
    junctionId: string;
  },
): Promise<LinkedDescriptionCardData | null> {
  const { and, eq, inArray, asc } = await import("drizzle-orm");
  const {
    descriptions,
    descriptionEntities,
    descriptionPlaces,
    repositories,
    places,
    entities,
  } = await import("../db/schema");

  // Resolve the junction to its description, scoped to the owner. A
  // junction id that is not this record's is not found — ownership is
  // the WHERE clause, not a post-hoc check.
  const owned =
    args.recordType === "entity"
      ? await db
          .select({ descriptionId: descriptionEntities.descriptionId })
          .from(descriptionEntities)
          .where(
            and(
              eq(descriptionEntities.id, args.junctionId),
              eq(descriptionEntities.entityId, args.ownerId),
            ),
          )
          .get()
      : await db
          .select({ descriptionId: descriptionPlaces.descriptionId })
          .from(descriptionPlaces)
          .where(
            and(
              eq(descriptionPlaces.id, args.junctionId),
              eq(descriptionPlaces.placeId, args.ownerId),
            ),
          )
          .get();
  if (!owned) return null;
  const descId = owned.descriptionId;

  // Every junction row this owner has on the resolved description.
  let group: JunctionRow[];
  if (args.recordType === "entity") {
    const raw = await db
      .select({
        linkId: descriptionEntities.id,
        descriptionId: descriptionEntities.descriptionId,
        role: descriptionEntities.role,
        roleRaw: descriptionEntities.roleRaw,
        nameAsRecorded: descriptionEntities.nameAsRecorded,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        dateExpression: descriptions.dateExpression,
        dateStart: descriptions.dateStart,
        dateEnd: descriptions.dateEnd,
        extent: descriptions.extent,
        repositoryId: descriptions.repositoryId,
        scopeContent: descriptions.scopeContent,
        ocrText: descriptions.ocrText,
      })
      .from(descriptionEntities)
      .innerJoin(
        descriptions,
        eq(descriptionEntities.descriptionId, descriptions.id),
      )
      .where(
        and(
          eq(descriptionEntities.entityId, args.ownerId),
          eq(descriptionEntities.descriptionId, descId),
        ),
      )
      .orderBy(asc(descriptionEntities.sequence))
      .all();
    group = raw.map((r, i) => ({ ...r, nameAsRecorded: r.nameAsRecorded, order: i }));
  } else {
    const raw = await db
      .select({
        linkId: descriptionPlaces.id,
        descriptionId: descriptionPlaces.descriptionId,
        role: descriptionPlaces.role,
        roleRaw: descriptionPlaces.roleRaw,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        dateExpression: descriptions.dateExpression,
        dateStart: descriptions.dateStart,
        dateEnd: descriptions.dateEnd,
        extent: descriptions.extent,
        repositoryId: descriptions.repositoryId,
        scopeContent: descriptions.scopeContent,
        ocrText: descriptions.ocrText,
      })
      .from(descriptionPlaces)
      .innerJoin(
        descriptions,
        eq(descriptionPlaces.descriptionId, descriptions.id),
      )
      .where(
        and(
          eq(descriptionPlaces.placeId, args.ownerId),
          eq(descriptionPlaces.descriptionId, descId),
        ),
      )
      .orderBy(asc(descriptionPlaces.createdAt))
      .all();
    group = raw.map((r, i) => ({ ...r, nameAsRecorded: null, order: i }));
  }
  if (group.length === 0) return null;

  // Places + repository for this one description (bounded lookups). The
  // unfold panel groups these by role and highlights the current record,
  // so the current place is flagged by id (exact, not name-matched).
  const placeRows = await db
    .select({
      id: descriptionPlaces.placeId,
      name: places.displayName,
      role: descriptionPlaces.role,
    })
    .from(descriptionPlaces)
    .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
    .where(eq(descriptionPlaces.descriptionId, descId))
    .all();
  const cardPlaces: CardPlace[] = placeRows.map((p) => ({
    name: p.name,
    role: p.role,
    isCurrent: args.recordType === "place" && p.id === args.ownerId,
  }));

  // Entity-record unfold panel: the description's linked entities grouped
  // by their role, the current entity flagged (again by id). Not fetched
  // for place records — their panel groups places only.
  let cardEntities: CardPlace[] | undefined;
  if (args.recordType === "entity") {
    const entityRows = await db
      .select({
        id: descriptionEntities.entityId,
        name: entities.displayName,
        role: descriptionEntities.role,
      })
      .from(descriptionEntities)
      .innerJoin(entities, eq(descriptionEntities.entityId, entities.id))
      .where(eq(descriptionEntities.descriptionId, descId))
      .orderBy(asc(descriptionEntities.sequence))
      .all();
    cardEntities = entityRows.map((e) => ({
      name: e.name,
      role: e.role,
      isCurrent: e.id === args.ownerId,
    }));
  }

  const first = group[0];
  let repositoryName: string | null = null;
  if (first.repositoryId) {
    const repo = await db
      .select({ name: repositories.name })
      .from(repositories)
      .where(inArray(repositories.id, [first.repositoryId]))
      .get();
    repositoryName = repo?.name ?? null;
  }

  const asRecordedRow = group.find(
    (r) => r.nameAsRecorded && r.nameAsRecorded.trim().length > 0,
  );
  const anchor =
    args.recordType === "place"
      ? args.displayName
      : (asRecordedRow?.nameAsRecorded ?? args.displayName);

  return {
    descriptionId: descId,
    title: first.title,
    referenceCode: first.referenceCode,
    roles: group.map((r) => ({ role: r.role, roleRaw: r.roleRaw })),
    linkIds: group.map((r) => r.linkId),
    dateExpression: first.dateExpression,
    dateStart: first.dateStart,
    dateEnd: first.dateEnd,
    extent: first.extent,
    repositoryName,
    places: cardPlaces,
    nameAsRecorded: asRecordedRow?.nameAsRecorded ?? null,
    asRecordedRoleRaw: asRecordedRow?.roleRaw ?? null,
    asRecordedRole: asRecordedRow?.role ?? null,
    snippet: buildCardSnippet(first.scopeContent, first.ocrText, anchor),
    entities: cardEntities,
  };
}

/**
 * Fetch the FULL OCR transcript for the description behind a junction —
 * the "Show all" (`&full=1`) on-demand branch. Ownership is the WHERE
 * clause, identical to `loadLinkedDescriptionCard`: a junction id that is
 * not this record's resolves to null, never a foreign transcript. Never
 * called on page load — transcripts reach 89 KB.
 */
export async function loadJunctionOcrText(
  db: DrizzleD1Database<any>,
  args: {
    recordType: "entity" | "place";
    ownerId: string;
    junctionId: string;
  },
): Promise<string | null> {
  const { and, eq } = await import("drizzle-orm");
  const { descriptions, descriptionEntities, descriptionPlaces } =
    await import("../db/schema");

  const row =
    args.recordType === "entity"
      ? await db
          .select({ ocrText: descriptions.ocrText })
          .from(descriptionEntities)
          .innerJoin(
            descriptions,
            eq(descriptionEntities.descriptionId, descriptions.id),
          )
          .where(
            and(
              eq(descriptionEntities.id, args.junctionId),
              eq(descriptionEntities.entityId, args.ownerId),
            ),
          )
          .get()
      : await db
          .select({ ocrText: descriptions.ocrText })
          .from(descriptionPlaces)
          .innerJoin(
            descriptions,
            eq(descriptionPlaces.descriptionId, descriptions.id),
          )
          .where(
            and(
              eq(descriptionPlaces.id, args.junctionId),
              eq(descriptionPlaces.placeId, args.ownerId),
            ),
          )
          .get();
  if (!row) return null;
  return row.ocrText ?? "";
}
