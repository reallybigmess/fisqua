/**
 * Places Admin — List
 *
 * This page is the index for the place authority records. Places are modelled
 * after the Linked Places Format with fields for coordinates,
 * historical administrative divisions (gobernación / partido /
 * region), and external authority links (Wikidata, Getty TGN, WHG,
 * HGIS). The list view is a searchable data table backed by FTS5 so
 * `cordoba` matches both `Córdoba` and `Córdova` variants, with
 * columns for label, place type, country, and parent place. The "New
 * place" button jumps to the create form.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`; every read of `places` is filtered by
 * `tenant.id` (browse, search, advanced search, and FTS5 fast
 * path).
 *
 * @version v0.4.0
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, Plus, Check } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DataTable } from "~/components/data-table/data-table";
import { ColumnToggle } from "~/components/data-table/column-toggle";
import { CursorPagination } from "~/components/data-table/cursor-pagination";
import {
  AdvancedSearchPanel,
  isAdvancedActive,
} from "~/components/data-table/advanced-search";
import { PLACE_TYPES } from "~/lib/validation/enums";
import type {
  ColumnDef,
  Table,
} from "~/components/data-table/data-table";
import type { Route } from "./+types/_auth.admin.places";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Place {
  id: string;
  placeCode: string | null;
  label: string;
  displayName: string;
  placeType: (typeof PLACE_TYPES)[number] | null;
  nameVariants: string | null;
  parentId: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatePrecision: string | null;
  // historicalGobernacion, historicalPartido, historicalRegion,
  // countryCode, adminLevel1, adminLevel2, wikidataId all dropped in
  // 0036 (0% populated in production audit).
  fclass: "P" | "H" | "A" | "T" | "S" | null;
  mergedInto: string | null;
  tgnId: string | null;
  hgisId: string | null;
  whgId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, like, or, gt, lt, asc, isNull, sql } = await import(
    "drizzle-orm"
  );
  const { places } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);
  const sp = url.searchParams;

  // Lightweight JSON search API for merge dialog
  if (sp.get("_search") === "true") {
    const searchQ = sp.get("q")?.trim() || "";
    const excludeId = sp.get("exclude") || "";
    const likePattern = `%${searchQ}%`;
    const conditions = [
      eq(places.tenantId, tenant.id),
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

  const q = sp.get("q")?.trim() || null;
  const cursor = sp.get("cursor") || null;
  const dir = sp.get("dir") || "next";
  const rawPlaceType = sp.get("placeType");
  const placeType =
    rawPlaceType && (PLACE_TYPES as readonly string[]).includes(rawPlaceType)
      ? (rawPlaceType as (typeof PLACE_TYPES)[number])
      : null;
  const showMerged = sp.get("showMerged") === "true";
  const PAGE_SIZE = 50;

  // Advanced search fields
  const advLabel = sp.get("label")?.trim() || null;
  const advDisplayName = sp.get("displayName")?.trim() || null;
  const advPlaceCode = sp.get("placeCode")?.trim() || null;
  // Historical search fields and wikidataId removed in 0036 (columns dropped).
  const advTgn = sp.get("tgnId")?.trim() || null;
  const advHgis = sp.get("hgisId")?.trim() || null;
  const advWhg = sp.get("whgId")?.trim() || null;

  const isAdvanced =
    advLabel || advDisplayName || advPlaceCode ||
    advTgn || advHgis || advWhg;

  // Shared filters. Tenant predicate is always present.
  function baseConditions() {
    const conditions: any[] = [eq(places.tenantId, tenant.id)];
    if (placeType) conditions.push(eq(places.placeType, placeType));
    if (!showMerged) conditions.push(sql`${places.mergedInto} IS NULL`);
    return conditions;
  }

  let results: Place[];
  let nextCursor: string | null = null;
  let prevCursor: string | null = null;

  if (q) {
    // -----------------------------------------------------------------------
    // Full-text search mode
    // -----------------------------------------------------------------------
    const baseConds = baseConditions();
    let rows: Place[];

    try {
      // Detect exact phrase (quoted)
      const isExact = q.startsWith('"') && q.endsWith('"');
      let matchExpr: string;
      if (isExact) {
        matchExpr = q; // Keep the quotes for exact phrase match
      } else {
        // Prefix matching: append * to each token
        matchExpr = q
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `${t}*`)
          .join(" ");
      }

      const ftsQuery = sql`
        SELECT p.* FROM places p
        INNER JOIN places_fts fts ON fts.rowid = p.rowid
        WHERE places_fts MATCH ${matchExpr}
        AND p.tenant_id = ${tenant.id}
        ORDER BY rank
        LIMIT ${PAGE_SIZE + 1}
      `;
      const ftsRows = await db.all(ftsQuery) as Place[];
      rows = ftsRows;
    } catch {
      // FTS5 fallback: LIKE search
      const likePattern = `%${q}%`;
      rows = await db
        .select()
        .from(places)
        .where(
          and(
            like(places.label, likePattern),
            ...baseConds,
          )
        )
        .limit(PAGE_SIZE + 1)
        .all();
    }

    // Apply additional filters (type / merged) that FTS doesn't handle
    if (baseConds.length > 0) {
      rows = rows.filter((r) => {
        if (placeType && r.placeType !== placeType) return false;
        if (!showMerged && r.mergedInto) return false;
        return true;
      });
    }

    results = rows.slice(0, PAGE_SIZE);
    if (rows.length > PAGE_SIZE) {
      const last = results[results.length - 1];
      nextCursor = `${last.label}|${last.id}`;
    }
  } else if (isAdvanced) {
    // -----------------------------------------------------------------------
    // Advanced search mode
    // -----------------------------------------------------------------------
    const conditions = [...baseConditions()];

    // Text fields: LIKE
    if (advLabel) conditions.push(like(places.label, `%${advLabel}%`));
    if (advDisplayName) conditions.push(like(places.displayName, `%${advDisplayName}%`));

    // Exact match fields
    if (advPlaceCode) conditions.push(eq(places.placeCode, advPlaceCode));
    if (advTgn) conditions.push(eq(places.tgnId, advTgn));
    if (advHgis) conditions.push(eq(places.hgisId, advHgis));
    if (advWhg) conditions.push(eq(places.whgId, advWhg));

    // Cursor pagination (sort by label, id)
    if (cursor) {
      const [cursorLabel, cursorId] = cursor.split("|");
      if (dir === "next") {
        conditions.push(
          or(
            gt(places.label, cursorLabel),
            and(eq(places.label, cursorLabel), gt(places.id, cursorId))
          )!
        );
      } else {
        conditions.push(
          or(
            lt(places.label, cursorLabel),
            and(eq(places.label, cursorLabel), lt(places.id, cursorId))
          )!
        );
      }
    }

    const orderDir = dir === "prev" ? sql`DESC` : sql`ASC`;
    const rows = await db
      .select()
      .from(places)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`${places.label} ${orderDir}, ${places.id} ${orderDir}`)
      .limit(PAGE_SIZE + 1)
      .all();

    // Reverse if paginating backward
    if (dir === "prev") rows.reverse();

    results = rows.slice(0, PAGE_SIZE);

    if (rows.length > PAGE_SIZE) {
      const last = results[results.length - 1];
      nextCursor = `${last.label}|${last.id}`;
    }
    if (cursor) {
      const first = results[0];
      if (first) prevCursor = `${first.label}|${first.id}`;
    }
  } else {
    // -----------------------------------------------------------------------
    // Browse mode (default) with keyset cursor pagination
    // -----------------------------------------------------------------------
    const conditions = [...baseConditions()];

    if (cursor) {
      const [cursorLabel, cursorId] = cursor.split("|");
      if (dir === "next") {
        conditions.push(
          or(
            gt(places.label, cursorLabel),
            and(eq(places.label, cursorLabel), gt(places.id, cursorId))
          )!
        );
      } else {
        conditions.push(
          or(
            lt(places.label, cursorLabel),
            and(eq(places.label, cursorLabel), lt(places.id, cursorId))
          )!
        );
      }
    }

    const orderDir = dir === "prev" ? sql`DESC` : sql`ASC`;
    const rows = await db
      .select()
      .from(places)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`${places.label} ${orderDir}, ${places.id} ${orderDir}`)
      .limit(PAGE_SIZE + 1)
      .all();

    // Reverse if paginating backward
    if (dir === "prev") rows.reverse();

    results = rows.slice(0, PAGE_SIZE);

    if (rows.length > PAGE_SIZE) {
      const last = results[results.length - 1];
      nextCursor = `${last.label}|${last.id}`;
    }
    if (cursor) {
      const first = results[0];
      if (first) prevCursor = `${first.label}|${first.id}`;
    }
  }

  return { places: results, nextCursor, prevCursor };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminPlacesPage({
  loaderData,
}: Route.ComponentProps) {
  const { places, nextCursor, prevCursor } = loaderData;
  const { t } = useTranslation("places");
  const [searchParams, setSearchParams] = useSearchParams();

  // Table ref for accessing the TanStack Table instance
  const tableRef = useRef<Table<Place> | null>(null);

  // Force re-render after table is available for toolbar controls
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    forceUpdate((n) => n + 1);
  }, []);

  // Search state
  const currentSearch = searchParams.get("q") || "";
  const [searchInput, setSearchInput] = useState(currentSearch);

  // Submit search on Enter or after debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      if (searchInput) {
        params.set("q", searchInput);
      } else {
        params.delete("q");
      }
      // Reset pagination on new search
      params.delete("cursor");
      params.delete("dir");
      setSearchParams(params, { replace: true });
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Place type filter
  const currentType = searchParams.get("placeType") || "";
  const currentShowMerged = searchParams.get("showMerged") === "true";

  // Advanced search fields with translated labels
  const advancedFields = useMemo(
    () => [
      { name: "label", label: t("field.label") },
      { name: "displayName", label: t("field.displayName") },
      { name: "placeCode", label: t("field.placeCode") },
      // Historical search fields and wikidataId removed in 0036.
      { name: "tgnId", label: t("field.tgnId") },
      { name: "hgisId", label: t("field.hgisId") },
      { name: "whgId", label: t("field.whgId") },
    ],
    [t]
  );

  // Column definitions
  const columns = useMemo<ColumnDef<Place, unknown>[]>(
    () => [
      {
        accessorKey: "label",
        header: t("field.label"),
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) => {
          const label = row.getValue("label") as string;
          const isMerged = !!row.original.mergedInto;
          return (
            <span className={isMerged ? "opacity-60" : ""}>
              {label}
              {isMerged && (
                <span className="ml-1 text-xs text-stone-500">
                  {t("mergedSuffix")}
                </span>
              )}
            </span>
          );
        },
      },
      {
        accessorKey: "placeType",
        header: t("field.placeType"),
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) => {
          const type = row.getValue("placeType") as string | null;
          if (!type) return "\u2014";
          return (
            <span className="inline-block rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
              {t(type)}
            </span>
          );
        },
      },
      {
        accessorKey: "placeCode",
        header: t("field.placeCode"),
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) => {
          const code = row.getValue("placeCode") as string | null;
          if (!code) return "\u2014";
          return (
            <Link
              to={`/admin/places/${row.original.id}`}
              className="font-semibold text-indigo-deep hover:underline"
            >
              {code}
            </Link>
          );
        },
      },
      // historicalGobernacion, historicalPartido, historicalRegion,
      // adminLevel1, adminLevel2, wikidataId columns dropped in 0036.
      {
        accessorKey: "tgnId",
        header: t("field.tgnId"),
        enableSorting: false,
        cell: ({ row }) =>
          row.getValue("tgnId") ? (
            <Check className="h-4 w-4 text-verdigris" />
          ) : (
            "\u2014"
          ),
      },
      {
        accessorKey: "hgisId",
        header: t("field.hgisId"),
        enableSorting: false,
        cell: ({ row }) =>
          row.getValue("hgisId") ? (
            <Check className="h-4 w-4 text-verdigris" />
          ) : (
            "\u2014"
          ),
      },
      {
        accessorKey: "whgId",
        header: t("field.whgId"),
        enableSorting: false,
        cell: ({ row }) =>
          row.getValue("whgId") ? (
            <Check className="h-4 w-4 text-verdigris" />
          ) : (
            "\u2014"
          ),
      },
      {
        id: "coordinates",
        header: t("field.latitude"),
        enableSorting: false,
        cell: ({ row }) =>
          row.original.latitude != null && row.original.longitude != null ? (
            <Check className="h-4 w-4 text-verdigris" />
          ) : (
            "\u2014"
          ),
      },
      // Hidden by default
      {
        accessorKey: "displayName",
        header: t("field.displayName"),
        enableSorting: false,
        cell: ({ row }) =>
          (row.getValue("displayName") as string) || "\u2014",
      },
    ],
    [t]
  );

  // Default column visibility: hide optional columns
  const defaultColumnVisibility = useMemo(
    () => ({
      displayName: false,
    }),
    []
  );

  const table = tableRef.current;

  // Empty state when no places at all and no search active
  if (
    places.length === 0 &&
    !currentSearch &&
    !currentType &&
    !isAdvancedActive(searchParams, advancedFields)
  ) {
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

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Page header */}
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

      {/* Toolbar */}
      <div className="mb-4 mt-6 rounded-lg border border-stone-200 p-4">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>

          {/* Place type filter */}
          <select
            value={currentType}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              if (e.target.value) {
                params.set("placeType", e.target.value);
              } else {
                params.delete("placeType");
              }
              params.delete("cursor");
              params.delete("dir");
              setSearchParams(params, { replace: true });
            }}
            className="rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{t("allTypes")}</option>
            {PLACE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(type)}
              </option>
            ))}
          </select>

          {/* Show merged checkbox */}
          <label className="flex items-center gap-2 text-sm font-medium text-indigo">
            <input
              type="checkbox"
              checked={currentShowMerged}
              onChange={(e) => {
                const params = new URLSearchParams(searchParams);
                if (e.target.checked) {
                  params.set("showMerged", "true");
                } else {
                  params.delete("showMerged");
                }
                params.delete("cursor");
                params.delete("dir");
                setSearchParams(params, { replace: true });
              }}
              className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
            />
            {t("showMerged")}
          </label>

          {/* Column toggle */}
          {table && (
            <ColumnToggle table={table} label={t("columnToggle")} />
          )}
        </div>

        {/* Advanced search */}
        <div className="mt-2">
          <AdvancedSearchPanel
            fields={advancedFields}
            searchParams={searchParams}
            toggleLabel={t("advancedToggle")}
            hideLabel={t("advancedHide")}
            clearLabel={t("advancedClear")}
            searchLabel={t("advancedSearch")}
            activeLabel={t("advancedActive")}
          />
        </div>
      </div>

      {/* Data table */}
      <DataTable
        data={places}
        columns={columns}
        defaultColumnVisibility={defaultColumnVisibility}
        emptyMessage={t("emptyHeading")}
        tableRef={tableRef}
      />

      {/* Cursor pagination */}
      <CursorPagination
        nextCursor={nextCursor}
        prevCursor={prevCursor}
        count={places.length}
        entityLabel={t("title").toLowerCase()}
      />
    </div>
  );
}
