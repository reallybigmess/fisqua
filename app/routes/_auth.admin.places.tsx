/**
 * Places Admin — combined list + map surface
 *
 * ONE surface for the place authority records (spec §5 "Combined places
 * surface", mockup 2026-07-11): a server-rendered, paginated list pane
 * on the left and the shipped MapLibre explorer on the right, driven by
 * one control row. Places are modelled after the Linked Places Format
 * with coordinates and external authority links (Getty TGN, WHG, HGIS).
 *
 * The `view=map` table|map toggle is retired: an incoming `?view=map`
 * normalises to the plain route with a redirect (old worklist links keep
 * working), preserving `q` and the missing-coordinates filter. The
 * control row drives BOTH panes at once:
 *   - a search input (server-side over display_name, name_variants, and
 *     place_code; URL state `?q=`), debounced client-side and backed by
 *     the FTS5 index so `bogota` matches `Bogotá` and `cordoba` matches
 *     both `Córdoba` and `Córdova` variants, with a LIKE fallback when
 *     FTS5 MATCH rejects the input;
 *   - the missing-coordinates filter chip (`?missingCoords=true`) — turns
 *     the list into the geocoding worklist and empties the map's points;
 *   - the place-type filter (`?placeType=`, the old table's param) — a
 *     chip-styled select faceted to the types actually present;
 *   - three external-identifier presence tri-states (`?tgn|hgis|whg=
 *     has|missing`) — "missing" is the reconciliation worklist; rows
 *     carry TGN/HGIS/WHG badges for at-a-glance visibility;
 *   - the viewport-filter toggle — when on, every map settle (moveend)
 *     re-fetches the visible rows server-side through the `_rows`
 *     branch with the settled bounds (debounced; page one on every
 *     bounds change), with a real in-view COUNT for the count line;
 *     coordinate-less and merged places are excluded, mirroring the
 *     points payload;
 *   - the show-merged chip (`?showMerged=true`, spec §4 merge aftermath:
 *     merged-away records stay findable) — merged rows join the list
 *     with the superseded styling and their survivor pointer, but never
 *     the map (merged places have no pin; the points payload excludes
 *     them unconditionally).
 * Row↔pin selection is component state: a row click flies the map to the
 * pin; a pin click scrolls the row into view. Both open the same card.
 * Separately, per-row checkboxes drive the two-row merge entry point
 * (spec §4): the bulk-merge toolbar appears at ≥1 selected and deep-links
 * the pair into the merge workbench at exactly 2. Checkbox clicks stop
 * propagation so they never trigger the row's map fly-to.
 *
 * Authority scope is the federation (migrations 0045-0048): every read of
 * `places` is filtered by `tenant.federationId`, resolved from the
 * session tenant's federation.
 *
 * @version v0.4.3
 */

import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams, useFetcher, redirect } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Search,
  Plus,
  MapPin,
  MapPinOff,
  GitMerge,
  X,
  RotateCcw,
  List as ListIcon,
  Map as MapIcon,
} from "lucide-react";
import {
  PlaceMapExplorer,
  type MapPoint,
  type Viewport,
} from "~/components/admin/place-maps";
import { BulkMergeToolbar } from "~/components/admin/bulk-merge-toolbar";
import { toggleSelection } from "~/lib/list-selection";
import {
  nextTriState,
  isAnyFilterActive,
  clearFilterParams,
} from "~/lib/places-filters";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { PLACE_TYPES } from "~/lib/validation/enums";
import type { Route } from "./+types/_auth.admin.places";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlaceRow {
  id: string;
  placeCode: string | null;
  displayName: string;
  placeType: (typeof PLACE_TYPES)[number] | null;
  latitude: number | null;
  longitude: number | null;
  /** Coordinate-precision vocabulary — drives the "to review" row badge
   * (value 'uncertain'). */
  coordinatePrecision: string | null;
  /** Batched from description_places — never an N+1 per-row query. */
  linkCount: number;
  /** Non-null on merged-away rows (visible only with showMerged on). */
  mergedInto: string | null;
  /** Survivor's label, resolved in one IN query when showMerged is on. */
  survivorName: string | null;
  /** External-identifier presence — drives the row's TGN/HGIS/WHG badges. */
  tgn: boolean;
  hgis: boolean;
  whg: boolean;
}

/** A map point enriched with the badge booleans the list rows render
 * in viewport-filter mode (the map component ignores the extras). */
interface PagePoint extends MapPoint {
  tgn: boolean;
  hgis: boolean;
  whg: boolean;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, like, or, gt, asc, isNull, sql } = await import(
    "drizzle-orm"
  );
  const { places, descriptionPlaces } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);
  const sp = url.searchParams;

  // Lightweight JSON search API for the merge workbench survivor
  // typeahead. Kept verbatim — unrelated to the combined surface.
  if (sp.get("_search") === "true") {
    const searchQ = sp.get("q")?.trim() || "";
    const excludeId = sp.get("exclude") || "";
    const likePattern = `%${searchQ}%`;
    const conditions = [
      eq(places.federationId, tenant.federationId),
      like(places.label, likePattern),
    ];
    if (excludeId) {
      conditions.push(sql`${places.id} != ${excludeId}`);
    }
    conditions.push(isNull(places.mergedInto));
    const results = await db
      .select({
        id: places.id,
        displayName: places.label,
        code: places.placeCode,
      })
      .from(places)
      .where(and(...conditions))
      .orderBy(asc(places.label))
      .limit(10)
      .all();
    return Response.json(results);
  }

  // The table|map toggle is retired (spec §5). Normalise any surviving
  // `?view=…` link to the plain route, preserving q + missing-coords so
  // bookmarked worklist links keep resolving.
  if (sp.has("view")) {
    const params = new URLSearchParams(sp);
    params.delete("view");
    const qs = params.toString();
    return redirect(qs ? `/admin/places?${qs}` : "/admin/places");
  }

  // The old advanced-search exact-lookup params (`?tgnId=` etc.) fold
  // into the search — the id arms of the `q` predicate resolve them —
  // via the same canonical-URL normalisation as `?view`. When `q` is
  // also present it wins and the legacy param is simply dropped.
  const LEGACY_ID_PARAMS = ["tgnId", "hgisId", "whgId"] as const;
  if (LEGACY_ID_PARAMS.some((p) => sp.has(p))) {
    const params = new URLSearchParams(sp);
    const existingQ = params.get("q")?.trim() || "";
    let legacyValue = "";
    for (const p of LEGACY_ID_PARAMS) {
      const v = params.get(p)?.trim();
      if (!legacyValue && v) legacyValue = v;
      params.delete(p);
    }
    if (!existingQ && legacyValue) params.set("q", legacyValue);
    const qs = params.toString();
    return redirect(qs ? `/admin/places?${qs}` : "/admin/places");
  }

  const q = sp.get("q")?.trim() || null;
  const missingCoords = sp.get("missingCoords") === "true";
  // The two coordinate-status chips are mutually exclusive — no row can
  // be both coordinate-less and located-but-uncertain — so "missing"
  // wins if both params somehow arrive together.
  const reviewCoords = !missingCoords && sp.get("reviewCoords") === "true";
  const showMerged = sp.get("showMerged") === "true";
  // Place-type filter — the old table's param name, so old links work.
  // Off-vocabulary values are ignored, as before.
  const rawPlaceType = sp.get("placeType");
  const placeType =
    rawPlaceType && (PLACE_TYPES as readonly string[]).includes(rawPlaceType)
      ? (rawPlaceType as (typeof PLACE_TYPES)[number])
      : null;
  // External-identifier presence filters, one tri-state per authority:
  // absent = any, `has` = a non-empty id, `missing` = none yet (the
  // reconciliation worklist).
  type ExtState = "has" | "missing" | null;
  const extState = (name: string): ExtState => {
    const v = sp.get(name);
    return v === "has" || v === "missing" ? v : null;
  };
  const extTgn = extState("tgn");
  const extHgis = extState("hgis");
  const extWhg = extState("whg");
  const cursor = sp.get("cursor") || null;
  const rowsOnly = sp.get("_rows") === "true";
  // Viewport-filter bounds ("w,s,e,n"), sent by the client's `_rows`
  // fetch on every map settle (spec §5: the toggle re-filters the
  // visible list on moveend). Malformed values are ignored — the fetch
  // then behaves like a plain rows request rather than erroring.
  let bounds: { w: number; s: number; e: number; n: number } | null = null;
  const boundsRaw = sp.get("bounds");
  if (boundsRaw) {
    const nums = boundsRaw.split(",").map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite)) {
      bounds = { w: nums[0], s: nums[1], e: nums[2], n: nums[3] };
    }
  }
  const PAGE_SIZE = 50;

  // Accent-insensitive search: the FTS5 index (label, display_name,
  // name_variants; unicode61 folds diacritics) makes `bogota` match
  // `Bogotá`, which plain LIKE cannot. The MATCH expression mirrors the
  // old list's fast path exactly — a fully-quoted query passes through
  // as an exact phrase, anything else becomes prefix tokens (`t*`).
  // FTS5 MATCH has its own operator syntax and throws on inputs like an
  // unbalanced quote or a bare `*`/`-`, so the expression is probed
  // once here: when the probe throws, the FTS arm is dropped and the
  // LIKE arms below stand alone (the old code's catch-to-LIKE fallback,
  // composed as a predicate instead of forked as a branch).
  let ftsMatch: string | null = null;
  if (q) {
    const isExact = q.startsWith('"') && q.endsWith('"');
    const expr = isExact
      ? q
      : q
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `${t}*`)
          .join(" ");
    if (expr) {
      try {
        await db.all(
          sql`SELECT rowid FROM places_fts WHERE places_fts MATCH ${expr} LIMIT 1`,
        );
        ftsMatch = expr;
      } catch {
        ftsMatch = null;
      }
    }
  }

  // Filter predicates shared by every list and count query: the FTS arm
  // above (accent-insensitive over label/display_name/name_variants)
  // OR'd with LIKE arms over display name, name variants (substring
  // inside the JSON array text), place code, and the external
  // identifiers (TGN/HGIS/WHG — not FTS-indexed; pasting an id finds
  // the place holding it, and `q` is trimmed at parse so whitespace
  // around a pasted id is harmless); plus the place-type filter and the
  // per-identifier presence tri-states. `includeType` lets the type
  // facet query below count sibling types without its own filter. The
  // liveness predicate (`isNull(places.mergedInto)`) is composed per
  // site — the list drops it under showMerged (spec §4: merged-away
  // records stay findable), while the map points and the coordinate
  // totals keep it unconditionally (merged places have no pin). The
  // federation-scope predicate (`eq(places.federationId, …)`) is spelt
  // out INLINE at each query site below — both so the tenant-isolation
  // static guard sees it and so scoping is never one indirection away.
  function searchConditions(includeType = true): any[] {
    const conditions: any[] = [];
    if (q) {
      const pat = `%${q}%`;
      const arms: any[] = [
        like(places.displayName, pat),
        like(places.nameVariants, pat),
        like(places.placeCode, pat),
        like(places.tgnId, pat),
        like(places.hgisId, pat),
        like(places.whgId, pat),
      ];
      if (ftsMatch) {
        // Same join shape as the old fast path (fts.rowid = p.rowid),
        // folded into a predicate so it composes with the filters,
        // keyset pagination, counts, and the points payload.
        arms.push(
          sql`${places.id} IN (SELECT p.id FROM places p INNER JOIN places_fts f ON f.rowid = p.rowid WHERE places_fts MATCH ${ftsMatch})`,
        );
      }
      conditions.push(or(...arms)!);
    }
    if (includeType && placeType) {
      conditions.push(eq(places.placeType, placeType));
    }
    // Presence tri-states: `has` demands a non-empty id (the old
    // columns' truthy check); `missing` is its exact complement.
    for (const [state, col] of [
      [extTgn, places.tgnId],
      [extHgis, places.hgisId],
      [extWhg, places.whgId],
    ] as const) {
      if (state === "has") {
        conditions.push(sql`(${col} IS NOT NULL AND ${col} != '')`);
      } else if (state === "missing") {
        conditions.push(sql`(${col} IS NULL OR ${col} = '')`);
      }
    }
    return conditions;
  }

  // Link counts for the whole federation in one grouped query (no
  // per-row N+1). Reused for both the list rows and the map points.
  const countRows = await db
    .select({
      placeId: descriptionPlaces.placeId,
      count: sql<number>`count(*)`,
    })
    .from(descriptionPlaces)
    .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
    .where(eq(places.federationId, tenant.federationId))
    .groupBy(descriptionPlaces.placeId)
    .all();
  const countMap = new Map(countRows.map((r) => [r.placeId, r.count]));

  // One keyset page (label, id) of the filtered list. When the
  // missing-coordinates chip is on, the list becomes the geocoding
  // worklist (coordinate-less places only).
  async function pageRows(
    cur: string | null,
  ): Promise<{ rows: PlaceRow[]; next: string | null }> {
    const conditions = [
      eq(places.federationId, tenant.federationId),
      ...searchConditions(),
    ];
    if (!showMerged) conditions.push(isNull(places.mergedInto));
    if (missingCoords) {
      conditions.push(
        sql`(${places.latitude} IS NULL OR ${places.longitude} IS NULL)`,
      );
    }
    if (reviewCoords) {
      // Located AND flagged uncertain — the coordinate-review worklist.
      conditions.push(
        sql`${places.latitude} IS NOT NULL`,
        sql`${places.longitude} IS NOT NULL`,
        eq(places.coordinatePrecision, "uncertain"),
      );
    }
    if (bounds) {
      // Viewport mode: located places inside the map's bounds. Liveness
      // is forced regardless of showMerged — merged places have no pin,
      // so the in-view list mirrors the points payload.
      conditions.push(
        isNull(places.mergedInto),
        sql`${places.latitude} IS NOT NULL`,
        sql`${places.longitude} IS NOT NULL`,
        sql`${places.latitude} BETWEEN ${bounds.s} AND ${bounds.n}`,
        sql`${places.longitude} BETWEEN ${bounds.w} AND ${bounds.e}`,
      );
    }
    if (cur) {
      const [cl, ci] = cur.split("|");
      conditions.push(
        or(
          gt(places.label, cl),
          and(eq(places.label, cl), gt(places.id, ci)),
        )!,
      );
    }
    const raw = await db
      .select({
        id: places.id,
        placeCode: places.placeCode,
        label: places.label,
        displayName: places.displayName,
        placeType: places.placeType,
        latitude: places.latitude,
        longitude: places.longitude,
        coordinatePrecision: places.coordinatePrecision,
        mergedInto: places.mergedInto,
        tgnId: places.tgnId,
        hgisId: places.hgisId,
        whgId: places.whgId,
      })
      .from(places)
      .where(and(...conditions))
      .orderBy(asc(places.label), asc(places.id))
      .limit(PAGE_SIZE + 1)
      .all();

    let next: string | null = null;
    const page = raw.slice(0, PAGE_SIZE);
    if (raw.length > PAGE_SIZE) {
      const last = page[page.length - 1];
      next = `${last.label}|${last.id}`;
    }

    // With merged rows visible, resolve each merged row's survivor name
    // in one IN query so the list can render the "merged → survivor"
    // indicator (same mechanism the old table used).
    const survivorNames = new Map<string, string>();
    if (showMerged) {
      const mergedIds = Array.from(
        new Set(
          page
            .map((r) => r.mergedInto)
            .filter((v): v is string => v != null),
        ),
      );
      if (mergedIds.length > 0) {
        const { inArray } = await import("drizzle-orm");
        const survivors = await db
          .select({ id: places.id, label: places.label })
          .from(places)
          .where(
            and(
              eq(places.federationId, tenant.federationId),
              inArray(places.id, mergedIds),
            ),
          )
          .all();
        for (const s of survivors) survivorNames.set(s.id, s.label);
      }
    }

    const rows: PlaceRow[] = page.map((r) => ({
      id: r.id,
      placeCode: r.placeCode,
      displayName: r.displayName,
      placeType: r.placeType,
      latitude: r.latitude,
      longitude: r.longitude,
      coordinatePrecision: r.coordinatePrecision,
      linkCount: countMap.get(r.id) ?? 0,
      mergedInto: r.mergedInto,
      survivorName: r.mergedInto
        ? (survivorNames.get(r.mergedInto) ?? null)
        : null,
      tgn: !!r.tgnId,
      hgis: !!r.hgisId,
      whg: !!r.whgId,
    }));
    return { rows, next };
  }

  // "Load more" fetches the next page only — points and totals are not
  // recomputed on scroll. With bounds present (the viewport filter's
  // per-settle fetch) the response also carries a real COUNT of every
  // in-view match, so the count line never reads a capped page length.
  if (rowsOnly) {
    const { rows, next } = await pageRows(cursor);
    let inViewCount: number | null = null;
    if (bounds) {
      const countConditions = [
        eq(places.federationId, tenant.federationId),
        ...searchConditions(),
        isNull(places.mergedInto),
        sql`${places.latitude} IS NOT NULL`,
        sql`${places.longitude} IS NOT NULL`,
        sql`${places.latitude} BETWEEN ${bounds.s} AND ${bounds.n}`,
        sql`${places.longitude} BETWEEN ${bounds.w} AND ${bounds.e}`,
      ];
      if (missingCoords) {
        countConditions.push(
          sql`(${places.latitude} IS NULL OR ${places.longitude} IS NULL)`,
        );
      }
      if (reviewCoords) {
        countConditions.push(eq(places.coordinatePrecision, "uncertain"));
      }
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(places)
        .where(and(...countConditions))
        .all();
      inViewCount = count;
    }
    return Response.json({ places: rows, nextCursor: next, inViewCount });
  }

  const firstPage = await pageRows(null);

  // Honest totals against the current search (not capped array lengths).
  // Both totals are over LIVE places only — merged rows are counted
  // separately below so the count line can name them explicitly.
  const [{ count: withCoords }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(places)
    .where(
      and(
        eq(places.federationId, tenant.federationId),
        isNull(places.mergedInto),
        ...searchConditions(),
        sql`${places.latitude} IS NOT NULL`,
        sql`${places.longitude} IS NOT NULL`,
      ),
    )
    .all();
  const [{ count: withoutCoords }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(places)
    .where(
      and(
        eq(places.federationId, tenant.federationId),
        isNull(places.mergedInto),
        ...searchConditions(),
        sql`(${places.latitude} IS NULL OR ${places.longitude} IS NULL)`,
      ),
    )
    .all();
  // Located-but-uncertain: the "to review" chip's honest count (real
  // COUNT, never a capped array length). Live places, search applied.
  const [{ count: uncertainCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(places)
    .where(
      and(
        eq(places.federationId, tenant.federationId),
        isNull(places.mergedInto),
        ...searchConditions(),
        sql`${places.latitude} IS NOT NULL`,
        sql`${places.longitude} IS NOT NULL`,
        eq(places.coordinatePrecision, "uncertain"),
      ),
    )
    .all();

  // Merged rows matching the current search (and, when the worklist
  // chip is on, its coordinate predicate) — a real COUNT feeding the
  // count line's "N merged records shown" suffix under showMerged.
  let mergedCount = 0;
  if (showMerged) {
    const mergedConditions = [
      eq(places.federationId, tenant.federationId),
      sql`${places.mergedInto} IS NOT NULL`,
      ...searchConditions(),
    ];
    if (missingCoords) {
      mergedConditions.push(
        sql`(${places.latitude} IS NULL OR ${places.longitude} IS NULL)`,
      );
    }
    if (reviewCoords) {
      mergedConditions.push(
        sql`${places.latitude} IS NOT NULL`,
        sql`${places.longitude} IS NOT NULL`,
        eq(places.coordinatePrecision, "uncertain"),
      );
    }
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(places)
      .where(and(...mergedConditions))
      .all();
    mergedCount = count;
  }

  // Facet counts for the place-type filter: the types actually present
  // under every OTHER active filter (the type filter itself is skipped,
  // so the control keeps offering sibling types). Liveness and the
  // worklist predicate follow the list's composition.
  const typeCountConditions = [
    eq(places.federationId, tenant.federationId),
    ...searchConditions(false),
    sql`${places.placeType} IS NOT NULL`,
  ];
  if (!showMerged) typeCountConditions.push(isNull(places.mergedInto));
  if (missingCoords) {
    typeCountConditions.push(
      sql`(${places.latitude} IS NULL OR ${places.longitude} IS NULL)`,
    );
  }
  if (reviewCoords) {
    typeCountConditions.push(
      sql`${places.latitude} IS NOT NULL`,
      sql`${places.longitude} IS NOT NULL`,
      eq(places.coordinatePrecision, "uncertain"),
    );
  }
  const typeCounts = await db
    .select({ type: places.placeType, count: sql<number>`count(*)` })
    .from(places)
    .where(and(...typeCountConditions))
    .groupBy(places.placeType)
    .orderBy(asc(places.placeType))
    .all();

  // Points: the whole filtered located set (search applies here too).
  // Merged places are excluded unconditionally — they have no pin, with
  // or without showMerged. The missing-coordinates chip excludes located
  // places by definition, so the map goes empty and dims (spec §5).
  let points: PagePoint[] = [];
  if (!missingCoords) {
    const pointConditions = [
      eq(places.federationId, tenant.federationId),
      isNull(places.mergedInto),
      ...searchConditions(),
      sql`${places.latitude} IS NOT NULL`,
      sql`${places.longitude} IS NOT NULL`,
    ];
    // The review chip narrows the map to the uncertain set it lists, so
    // the map mirrors the worklist rather than showing every located pin.
    if (reviewCoords) {
      pointConditions.push(eq(places.coordinatePrecision, "uncertain"));
    }
    const located = await db
      .select({
        id: places.id,
        name: places.displayName,
        code: places.placeCode,
        type: places.placeType,
        lat: places.latitude,
        lng: places.longitude,
        tgnId: places.tgnId,
        hgisId: places.hgisId,
        whgId: places.whgId,
      })
      .from(places)
      .where(and(...pointConditions))
      .all();
    points = located.map((r) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      type: r.type,
      count: countMap.get(r.id) ?? 0,
      lat: r.lat as number,
      lng: r.lng as number,
      tgn: !!r.tgnId,
      hgis: !!r.hgisId,
      whg: !!r.whgId,
    }));
  }

  const maptilerKey = env.MAPTILER_KEY;

  return {
    places: firstPage.rows,
    nextCursor: firstPage.next,
    points,
    maptilerKey,
    q: q ?? "",
    missingCoords,
    reviewCoords,
    showMerged,
    placeType,
    extTgn,
    extHgis,
    extWhg,
    typeCounts,
    withCoords,
    withoutCoords,
    uncertainCount,
    mergedCount,
  };
}

// ---------------------------------------------------------------------------
// Row helper — one shape for both list modes
// ---------------------------------------------------------------------------

interface DisplayRow {
  id: string;
  name: string;
  code: string | null;
  type: string | null;
  lat: number | null;
  lng: number | null;
  precision: string | null;
  count: number;
  merged: boolean;
  survivorName: string | null;
  tgn: boolean;
  hgis: boolean;
  whg: boolean;
}

function fmtCoord(n: number): string {
  return n.toFixed(4);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminPlacesPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    places,
    nextCursor,
    points,
    maptilerKey,
    missingCoords,
    reviewCoords,
    showMerged,
    placeType,
    extTgn,
    extHgis,
    extWhg,
    typeCounts,
    withCoords,
    withoutCoords,
    uncertainCount,
    mergedCount,
  } = loaderData;
  const { t } = useTranslation("places");
  const { t: ta } = useTranslation("authorities");
  const [searchParams, setSearchParams] = useSearchParams();

  // -- Search: the debounce-then-navigate idiom the entities list uses.
  const currentSearch = searchParams.get("q") || "";
  const [searchInput, setSearchInput] = useState(currentSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(currentSearch);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    if (debouncedSearch !== currentSearch) {
      const params = new URLSearchParams(searchParams);
      if (debouncedSearch) params.set("q", debouncedSearch);
      else params.delete("q");
      params.delete("cursor");
      setSearchParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // -- Viewport filter: toggle + last-settled bounds are client state;
  // the visible rows are SERVER state, re-fetched (debounced) on every
  // map settle via the `_rows` branch with bounds params (spec §5: the
  // toggle re-filters the visible list on moveend). Server paging keeps
  // the list capped and the count line reads a real COUNT — the earlier
  // client-side derivation rendered every in-view point as a DOM row
  // (thousands after the initial fitBounds), which is what made the
  // list appear frozen under panning in UAT.
  const [filterToView, setFilterToView] = useState(false);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const viewFetcher = useFetcher<{
    places: PlaceRow[];
    nextCursor: string | null;
    inViewCount: number | null;
  }>();
  const [viewRows, setViewRows] = useState<PlaceRow[]>([]);
  const [viewCursor, setViewCursor] = useState<string | null>(null);
  const [viewCount, setViewCount] = useState<number | null>(null);
  const viewModeRef = useRef<"reset" | "more">("reset");
  const viewProcessedRef = useRef<unknown>(null);
  const boundsParam = viewport
    ? [viewport.west, viewport.south, viewport.east, viewport.north].join(",")
    : null;

  // Every settle (new bounds) or filter change re-fetches page one —
  // pagination resets coherently on bounds change. 250ms debounce
  // absorbs settle bursts (flyTo chains, inertia).
  useEffect(() => {
    if (!filterToView || !boundsParam) return;
    const timer = setTimeout(() => {
      viewModeRef.current = "reset";
      const params = new URLSearchParams(searchParams);
      params.set("_rows", "true");
      params.set("bounds", boundsParam);
      params.delete("cursor");
      viewFetcher.load(`/admin/places?${params.toString()}`);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterToView, boundsParam, searchParams]);

  useEffect(() => {
    if (
      viewFetcher.state === "idle" &&
      viewFetcher.data &&
      viewFetcher.data !== viewProcessedRef.current
    ) {
      viewProcessedRef.current = viewFetcher.data;
      const data = viewFetcher.data;
      setViewRows((prev) =>
        viewModeRef.current === "reset" ? data.places : [...prev, ...data.places],
      );
      setViewCursor(data.nextCursor);
      setViewCount(data.inViewCount ?? null);
    }
  }, [viewFetcher.state, viewFetcher.data]);

  const loadMoreView = () => {
    if (!viewCursor || !boundsParam) return;
    viewModeRef.current = "more";
    const params = new URLSearchParams(searchParams);
    params.set("_rows", "true");
    params.set("bounds", boundsParam);
    params.set("cursor", viewCursor);
    viewFetcher.load(`/admin/places?${params.toString()}`);
  };

  const clearViewportState = () => {
    setViewRows([]);
    setViewCursor(null);
    setViewCount(null);
  };

  // -- Selection sync (component state, not URL).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const selectFromMap = (id: string) => {
    setSelectedId(id);
    const el = rowRefs.current.get(id);
    if (el) el.scrollIntoView({ block: "nearest" });
  };

  // -- Checkbox selection for the two-row merge entry point (spec §4).
  // Independent of the map selection above; checkbox clicks stop
  // propagation so they never trigger the row's fly-to.
  const [selIds, setSelIds] = useState<Set<string>>(() => new Set());
  const toggleSel = (id: string) => setSelIds((prev) => toggleSelection(prev, id));

  // -- Load-more accumulation (browse mode). A fetcher pages the list
  // without recomputing the map points; results append client-side.
  const fetcher = useFetcher<{ places: PlaceRow[]; nextCursor: string | null }>();
  const [extraRows, setExtraRows] = useState<PlaceRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(nextCursor);
  const processedRef = useRef<unknown>(null);
  useEffect(() => {
    // A fresh server page (new search/filter) resets the accumulation.
    setExtraRows([]);
    setCursor(nextCursor);
  }, [places, nextCursor]);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      fetcher.data !== processedRef.current
    ) {
      processedRef.current = fetcher.data;
      setExtraRows((prev) => [...prev, ...fetcher.data!.places]);
      setCursor(fetcher.data.nextCursor);
    }
  }, [fetcher.state, fetcher.data]);
  const loadMore = () => {
    const params = new URLSearchParams(searchParams);
    params.set("_rows", "true");
    if (cursor) params.set("cursor", cursor);
    fetcher.load(`/admin/places?${params.toString()}`);
  };

  // -- Mobile pane switch — the only surviving toggle (spec §5).
  const [mobilePane, setMobilePane] = useState<"list" | "map">("list");

  // -- Compose the visible list rows. Browse and viewport modes share
  // the PlaceRow server shape, so one mapping serves both.
  const toDisplay = (r: PlaceRow): DisplayRow => ({
    id: r.id,
    name: r.displayName,
    code: r.placeCode,
    type: r.placeType,
    lat: r.latitude,
    lng: r.longitude,
    precision: r.coordinatePrecision,
    count: r.linkCount,
    merged: r.mergedInto != null,
    survivorName: r.survivorName,
    tgn: r.tgn,
    hgis: r.hgis,
    whg: r.whg,
  });
  const browseRows: DisplayRow[] = [...places, ...extraRows].map(toDisplay);
  const viewDisplayRows: DisplayRow[] = viewRows.map(toDisplay);
  const listRows: DisplayRow[] = filterToView ? viewDisplayRows : browseRows;

  // -- Honest count line.
  const total = withCoords + withoutCoords;
  // Rows counted against the live totals: merged rows are surfaced
  // separately in the suffix, so they must not inflate `shown` (which
  // is measured against a live-only COUNT).
  const liveShown = browseRows.filter((r) => !r.merged).length;
  let countLine: string;
  if (filterToView) {
    // viewCount is a real server COUNT of every in-view match; until
    // the first bounds fetch lands there is no honest number to show.
    countLine =
      viewCount == null
        ? t("loadingMore")
        : t("countViewport", {
            shown: viewDisplayRows.length,
            inView: viewCount,
            located: withCoords,
            without: withoutCoords,
          });
  } else if (missingCoords) {
    countLine = t("countMissing", {
      shown: liveShown,
      total: withoutCoords,
    });
  } else if (reviewCoords) {
    countLine = t("countReview", {
      shown: liveShown,
      total: uncertainCount,
    });
  } else {
    countLine = t("countBrowse", {
      shown: liveShown,
      total,
      located: withCoords,
      without: withoutCoords,
    });
  }
  // Merged rows are extra to the live totals; say so explicitly. The
  // viewport list derives from the points payload, which never carries
  // merged places, so the suffix is meaningless there.
  if (showMerged && !filterToView) {
    countLine += ` ${t("countMergedSuffix", { count: mergedCount })}`;
  }

  // -- Empty state: no places at all, no search or filter active.
  // showMerged counts as an active filter — with it on, merged records
  // may still exist to show, so fall through to the normal surface.
  const noFilters =
    !currentSearch &&
    !missingCoords &&
    !reviewCoords &&
    !showMerged &&
    !placeType &&
    !extTgn &&
    !extHgis &&
    !extWhg;
  if (total === 0 && noFilters) {
    return (
      <div className="mx-auto max-w-7xl px-8 py-12">
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-4xl font-semibold text-stone-700">
            {t("title")}
          </h1>
          <Link
            to="/admin/places/new"
            className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            <Plus className="h-4 w-4" />
            {t("primaryCta")}
          </Link>
        </div>
        <div className="mt-12 text-center">
          <h2 className="font-sans text-lg font-semibold text-stone-700">
            {t("emptyHeading")}
          </h2>
          <p className="mt-2 font-sans text-sm text-stone-500">
            {t("emptyBody")}
          </p>
          <Link
            to="/admin/places/new"
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            <Plus className="h-4 w-4" />
            {t("primaryCta")}
          </Link>
        </div>
      </div>
    );
  }

  // -- The list pane markup, shared across desktop and mobile.
  const listPane = (
    <div className="flex h-[520px] flex-col overflow-hidden rounded-lg border border-stone-200">
      <div className="flex-1 overflow-y-auto">
        {listRows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white shadow-sm">
              <MapPinOff className="h-5 w-5 text-stone-400" strokeWidth={1.5} />
            </span>
            <p className="font-serif text-15 text-indigo">
              {t("listEmptyTitle")}
            </p>
            <p className="measure-36 text-13 text-stone-500">
              {t("listEmptyBody")}
            </p>
          </div>
        ) : (
          listRows.map((row) => {
            const hasCoords = row.lat != null && row.lng != null;
            const isSel = selectedId === row.id;
            return (
              <div
                key={row.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.id, el);
                  else rowRefs.current.delete(row.id);
                }}
                onClick={() => setSelectedId(row.id)}
                className={`relative flex cursor-pointer items-start gap-3 border-b border-stone-100 px-4 py-2.5 last:border-b-0 ${
                  isSel
                    ? "bg-verdigris-tint before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-verdigris"
                    : "hover:bg-stone-50"
                }`}
              >
                {/* Two-row merge entry point. stopPropagation keeps the
                    checkbox from triggering the row's map fly-to. */}
                <input
                  type="checkbox"
                  aria-label={ta("bulkMerge")}
                  checked={selIds.has(row.id)}
                  onChange={() => toggleSel(row.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-indigo"
                />
                <div
                  className={`grid min-w-0 flex-1 grid-cols-[1fr_auto] gap-x-3 ${
                    row.merged ? "opacity-55" : ""
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/admin/places/${row.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-serif text-14 font-semibold text-indigo hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.merged && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-madder-tint px-2 py-0.5 text-11 font-semibold text-madder-deep">
                        <GitMerge className="h-3 w-3" strokeWidth={1.5} />
                        {ta("mergedPill")}
                      </span>
                    )}
                    {row.merged && row.survivorName && (
                      <span className="text-11 text-stone-500">
                        {ta("mergedArrow", { survivor: row.survivorName })}
                      </span>
                    )}
                  </span>
                  <span className="self-center text-right text-12 nums text-stone-600">
                    {t("linkCount", { count: row.count })}
                  </span>
                  <p className="col-span-2 mt-0.5 flex flex-wrap items-center gap-x-1.5 font-mono text-11 text-stone-500">
                    {row.code && <span>{row.code}</span>}
                    {row.type && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="font-sans">{t(row.type)}</span>
                      </>
                    )}
                    <span aria-hidden>·</span>
                    {hasCoords ? (
                      <span className="nums">
                        {fmtCoord(row.lat as number)}, {fmtCoord(row.lng as number)}
                      </span>
                    ) : (
                      <span className="rounded-full bg-madder-tint px-2 py-0.5 font-sans text-10 font-semibold text-madder-deep">
                        {t("noPin")}
                      </span>
                    )}
                    {/* Coordinate-review badge: located but flagged
                        uncertain (spec §6 tri-state status). */}
                    {hasCoords && row.precision === "uncertain" && (
                      <span className="rounded-full bg-saffron-tint px-2 py-0.5 font-sans text-10 font-semibold text-saffron-deep">
                        {t("reviewBadge")}
                      </span>
                    )}
                    {/* External-identifier badges — the at-a-glance
                        visibility the old optional columns provided. */}
                    {(
                      [
                        [row.tgn, t("field.tgnId")],
                        [row.hgis, t("field.hgisId")],
                        [row.whg, t("field.whgId")],
                      ] as const
                    ).map(
                      ([present, label]) =>
                        present && (
                          <span
                            key={label}
                            className="rounded bg-indigo-wash px-1.5 py-0.5 font-sans text-10 font-semibold text-indigo-soft"
                          >
                            {label}
                          </span>
                        ),
                    )}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>
      {/* Load more — both modes page server-side; the viewport mode
          pages within the current bounds (a settle resets to page one). */}
      {(filterToView ? viewCursor : cursor) && (
        <button
          type="button"
          onClick={filterToView ? loadMoreView : loadMore}
          disabled={
            (filterToView ? viewFetcher.state : fetcher.state) !== "idle"
          }
          className="border-t border-stone-200 bg-stone-100 py-2.5 text-center text-13 font-semibold text-stone-600 hover:bg-stone-200 disabled:opacity-60"
        >
          {(filterToView ? viewFetcher.state : fetcher.state) !== "idle"
            ? t("loadingMore")
            : t("loadMore")}
        </button>
      )}
    </div>
  );

  // -- The map pane markup.
  const mapPane = (
    <div className="relative">
      {maptilerKey && (
        <PlaceMapExplorer
          points={points}
          maptilerKey={maptilerKey}
          onViewportChange={setViewport}
          selectedId={selectedId}
          onSelect={selectFromMap}
          t={t}
        />
      )}
      {/* Missing-coordinates filter dims the map (spec §5). */}
      {missingCoords && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[10px] bg-white/70">
          <p className="rounded-md bg-white px-3 py-1.5 text-13 text-stone-600 shadow-sm">
            {t("mapDimmed")}
          </p>
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-semibold text-stone-700">
          {t("title")}
        </h1>
      </div>

      {/* Control row — drives both panes */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="w-full rounded-lg border border-stone-300 py-2 pl-9 pr-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
        </div>

        {/* Missing-coordinates filter chip. Mutually exclusive with the
            review chip — enabling one clears the other. */}
        <button
          type="button"
          aria-pressed={missingCoords}
          onClick={() => {
            const params = new URLSearchParams(searchParams);
            if (missingCoords) params.delete("missingCoords");
            else {
              params.set("missingCoords", "true");
              params.delete("reviewCoords");
            }
            params.delete("cursor");
            setSearchParams(params, { replace: true });
          }}
          className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-13 font-semibold ${
            missingCoords
              ? "border-transparent bg-madder-tint text-madder-deep"
              : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
          }`}
        >
          <MapPinOff className="h-3.5 w-3.5" strokeWidth={1.5} />
          {t("missingCoordsChip")}
          <span className="font-mono text-11 text-stone-500">
            {withoutCoords}
          </span>
        </button>

        {/* Coordinates-to-review chip: located but flagged uncertain.
            Mutually exclusive with the missing-coordinates chip. */}
        <button
          type="button"
          aria-pressed={reviewCoords}
          onClick={() => {
            const params = new URLSearchParams(searchParams);
            if (reviewCoords) params.delete("reviewCoords");
            else {
              params.set("reviewCoords", "true");
              params.delete("missingCoords");
            }
            params.delete("cursor");
            setSearchParams(params, { replace: true });
          }}
          className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-13 font-semibold ${
            reviewCoords
              ? "border-transparent bg-saffron-tint text-saffron-deep"
              : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
          }`}
        >
          <MapPin className="h-3.5 w-3.5" strokeWidth={1.5} />
          {t("reviewCoordsChip")}
          <span className="font-mono text-11 text-stone-500">
            {uncertainCount}
          </span>
        </button>

        {/* Show-merged chip (spec §4: merged-away records stay findable) */}
        <button
          type="button"
          aria-pressed={showMerged}
          onClick={() => {
            const params = new URLSearchParams(searchParams);
            if (showMerged) params.delete("showMerged");
            else params.set("showMerged", "true");
            params.delete("cursor");
            setSearchParams(params, { replace: true });
          }}
          className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-13 font-semibold ${
            showMerged
              ? "border-transparent bg-indigo-tint text-indigo"
              : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50"
          }`}
        >
          <GitMerge className="h-3.5 w-3.5" strokeWidth={1.5} />
          {ta("showMerged")}
        </button>

        {/* Place-type filter — the old table's param, now a chip-styled
            select listing the types actually present (facet counts). */}
        <select
          value={placeType ?? ""}
          aria-label={t("field.placeType")}
          onChange={(e) => {
            const params = new URLSearchParams(searchParams);
            if (e.target.value) params.set("placeType", e.target.value);
            else params.delete("placeType");
            params.delete("cursor");
            setSearchParams(params, { replace: true });
          }}
          className="flex-shrink-0 rounded-full border border-stone-300 bg-white px-3 py-1.5 font-sans text-13 font-semibold text-stone-600 focus:border-indigo focus:outline-none"
        >
          <option value="">{t("allTypes")}</option>
          {typeCounts.map(({ type, count }) => (
            <option key={type} value={type ?? ""}>
              {`${t(type ?? "")} (${count})`}
            </option>
          ))}
          {placeType && !typeCounts.some((tc) => tc.type === placeType) && (
            <option value={placeType}>{`${t(placeType)} (0)`}</option>
          )}
        </select>

        {/* External-identifier presence tri-states: the chip body cycles
            any → has → missing → any; an active chip also carries an
            explicit × that clears straight back to any, so a click
            meaning "turn this off" is never trapped in the cycle. */}
        {(
          [
            ["tgn", extTgn, t("field.tgnId")],
            ["hgis", extHgis, t("field.hgisId")],
            ["whg", extWhg, t("field.whgId")],
          ] as const
        ).map(([param, state, label]) => (
          <span
            key={param}
            className={`inline-flex flex-shrink-0 items-center overflow-hidden rounded-full border text-13 font-semibold ${
              state === "has"
                ? "border-transparent bg-verdigris-tint text-verdigris-deep"
                : state === "missing"
                  ? "border-transparent bg-madder-tint text-madder-deep"
                  : "border-stone-300 bg-white text-stone-600"
            }`}
          >
            <button
              type="button"
              aria-label={t("extFilterAria", { id: label })}
              onClick={() => {
                const params = new URLSearchParams(searchParams);
                const next = nextTriState(state);
                if (next) params.set(param, next);
                else params.delete(param);
                params.delete("cursor");
                setSearchParams(params, { replace: true });
              }}
              className={`py-1.5 pl-3 ${state === null ? "pr-3 hover:bg-stone-50" : "pr-1"}`}
            >
              {state === "has"
                ? t("extHas", { id: label })
                : state === "missing"
                  ? t("extMissing", { id: label })
                  : label}
            </button>
            {state !== null && (
              <button
                type="button"
                aria-label={t("extClearAria", { id: label })}
                onClick={() => {
                  const params = new URLSearchParams(searchParams);
                  params.delete(param);
                  params.delete("cursor");
                  setSearchParams(params, { replace: true });
                }}
                className="py-1.5 pl-0.5 pr-2.5 opacity-70 hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            )}
          </span>
        ))}

        {/* Viewport-filter toggle */}
        <span className="inline-flex flex-shrink-0 items-center gap-2 rounded-full border border-stone-300 bg-white px-3 py-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={filterToView}
            aria-label={t("mapFilterToggle")}
            onClick={() => {
              // Leaving viewport mode drops its fetched rows so a
              // later re-enable starts from a fresh page one.
              if (filterToView) clearViewportState();
              setFilterToView(!filterToView);
            }}
            className={`relative h-5 w-[38px] flex-shrink-0 rounded-full transition-colors ${
              filterToView ? "bg-verdigris" : "bg-stone-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                filterToView ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
          <span className="text-13 text-stone-700">{t("mapFilterToggle")}</span>
        </span>

        {/* Reset — visible whenever any filter or search is active; one
            click returns to the plain default list (bare URL, viewport
            toggle off, selection cleared). */}
        {(isAnyFilterActive(searchParams) || filterToView) && (
          <button
            type="button"
            onClick={() => {
              setSearchInput("");
              setDebouncedSearch("");
              setFilterToView(false);
              clearViewportState();
              setSelIds(new Set());
              setSelectedId(null);
              setSearchParams(clearFilterParams(searchParams), {
                replace: true,
              });
            }}
            className="inline-flex flex-shrink-0 items-center gap-1.5 text-13 font-semibold text-stone-600 underline underline-offset-2 hover:text-indigo"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
            {t("resetFilters")}
          </button>
        )}

        {/* Add place */}
        <Link
          to="/admin/places/new"
          className="ml-auto inline-flex flex-shrink-0 items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          <Plus className="h-4 w-4" />
          {t("primaryCta")}
        </Link>
      </div>

      {/* Honest count line */}
      <p className="mt-3 text-12 nums text-stone-500">{countLine}</p>

      {/* Two-row merge entry point (spec §4): appears at ≥1 selected,
          deep-links into the merge workbench at exactly 2. */}
      <div className="mt-3">
        <BulkMergeToolbar
          selectedIds={Array.from(selIds)}
          onClear={() => setSelIds(new Set())}
          basePath="/admin/places"
          t={ta}
        />
      </div>

      {/* Mobile pane switch — the only surviving toggle */}
      <div className="mt-3 flex overflow-hidden rounded-md border border-stone-300 md:hidden">
        {(
          [
            { key: "list", icon: ListIcon, label: t("paneList") },
            { key: "map", icon: MapIcon, label: t("paneMap") },
          ] as const
        ).map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={mobilePane === key}
            onClick={() => setMobilePane(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-1.5 text-13 font-semibold ${
              mobilePane === key
                ? "bg-indigo text-parchment"
                : "bg-white text-stone-500 hover:bg-stone-50"
            }`}
          >
            <Icon className="h-4 w-4" strokeWidth={1.5} />
            {label}
          </button>
        ))}
      </div>

      {/* Two panes */}
      <div className="mt-3 grid gap-4 md:grid-cols-[400px_1fr]">
        <div className={mobilePane === "list" ? "block" : "hidden md:block"}>
          {listPane}
        </div>
        <div className={mobilePane === "map" ? "block" : "hidden md:block"}>
          {mapPane}
        </div>
      </div>
    </div>
  );
}
