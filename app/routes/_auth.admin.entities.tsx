/**
 * Entities Admin — List
 *
 * This page is the index for the entity authority records (people and
 * corporate bodies). It renders a searchable data table across the entire
 * authority set, backed by SQLite FTS5 so an accent-insensitive search
 * like `gonzalez` matches both `González` and `Gonzaléz` variants.
 * Columns cover display name, sort name, entity type, primary
 * function, honorifics, and Wikidata/VIAF links where present. The
 * "New entity" button jumps to the create form, and each row deep-links
 * into the edit page.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`; every read of `entities` is filtered by
 * `tenant.id` (including the FTS5 fast path).
 *
 * @version v0.4.0
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, Plus, Check } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { ENTITY_TYPES } from "~/lib/validation/enums";
import { DataTable } from "~/components/data-table/data-table";
import { ColumnToggle } from "~/components/data-table/column-toggle";
import { CursorPagination } from "~/components/data-table/cursor-pagination";
import {
  AdvancedSearchPanel,
  isAdvancedActive,
} from "~/components/data-table/advanced-search";
import type {
  ColumnDef,
  Table,
} from "~/components/data-table/data-table";
import type { Route } from "./+types/_auth.admin.entities";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Entity {
  id: string;
  entityCode: string | null;
  displayName: string;
  sortName: string;
  surname: string | null;
  givenName: string | null;
  entityType: string;
  honorific: string | null;
  primaryFunction: string | null;
  nameVariants: string | null;
  datesOfExistence: string | null;
  mergedInto: string | null;
  wikidataId: string | null;
  viafId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, gt, lt, asc, desc, isNull, eq, like, sql } = await import(
    "drizzle-orm"
  );
  const { entities } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);

  // Lightweight JSON search API for merge dialog
  if (url.searchParams.get("_search") === "true") {
    const q = url.searchParams.get("q")?.trim() || "";
    const excludeId = url.searchParams.get("exclude") || "";
    const likePattern = `%${q}%`;
    const conditions = [
      eq(entities.tenantId, tenant.id),
      like(entities.displayName, likePattern),
    ];
    if (excludeId) {
      conditions.push(sql`${entities.id} != ${excludeId}`);
    }
    conditions.push(isNull(entities.mergedInto));
    const results = await db
      .select({
        id: entities.id,
        displayName: entities.displayName,
        code: entities.entityCode,
      })
      .from(entities)
      .where(and(...conditions))
      .orderBy(asc(entities.sortName))
      .limit(10)
      .all();
    return Response.json(results);
  }

  const pageSize = 50;
  const cursor = url.searchParams.get("cursor");
  const dir = url.searchParams.get("dir") || "next";
  const search = url.searchParams.get("q");
  const rawTypeFilter = url.searchParams.get("entityType");
  const typeFilter =
    rawTypeFilter && (ENTITY_TYPES as readonly string[]).includes(rawTypeFilter)
      ? (rawTypeFilter as (typeof ENTITY_TYPES)[number])
      : null;
  const showMerged = url.searchParams.get("showMerged") === "true";

  // Advanced search fields
  const advDisplayName = url.searchParams.get("displayName");
  const advSortName = url.searchParams.get("sortName");
  const advSurname = url.searchParams.get("surname");
  const advGivenName = url.searchParams.get("givenName");
  const advEntityCode = url.searchParams.get("entityCode");
  const advWikidataId = url.searchParams.get("wikidataId");
  const advViafId = url.searchParams.get("viafId");

  const hasAdvanced =
    advDisplayName ||
    advSortName ||
    advSurname ||
    advGivenName ||
    advEntityCode ||
    advWikidataId ||
    advViafId;

  // Base conditions applied to all modes. Tenant predicate is always present.
  const baseConditions: any[] = [eq(entities.tenantId, tenant.id)];
  if (!showMerged) {
    baseConditions.push(isNull(entities.mergedInto));
  }
  if (typeFilter) {
    baseConditions.push(eq(entities.entityType, typeFilter));
  }

  // --- Search mode: FTS5 with LIKE fallback ---
  if (search && !hasAdvanced) {
    let rows: Entity[];
    try {
      // Build FTS5 query
      const ftsQuery = search.startsWith('"')
        ? search // exact phrase
        : search
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => `${t}*`)
            .join(" ");

      // Build dynamic filter conditions for raw SQL
      const filterParts: string[] = [];
      if (!showMerged) filterParts.push("e.merged_into IS NULL");
      if (typeFilter) filterParts.push(`e.entity_type = '${typeFilter}'`);
      const filterClause =
        filterParts.length > 0 ? `AND ${filterParts.join(" AND ")}` : "";

      const ftsResults = await db.all(sql`
        SELECT e.*
        FROM entities e
        INNER JOIN entities_fts fts ON fts.rowid = e.rowid
        WHERE entities_fts MATCH ${ftsQuery}
        AND e.tenant_id = ${tenant.id}
        ${sql.raw(filterClause)}
        ORDER BY rank
        LIMIT ${pageSize}
      `);

      rows = ftsResults as Entity[];
    } catch {
      // FTS5 fallback to LIKE
      const likePattern = `%${search}%`;
      const conditions = [
        ...baseConditions,
        like(entities.sortName, likePattern),
      ];
      rows = (await db
        .select()
        .from(entities)
        .where(and(...conditions))
        .orderBy(asc(entities.sortName))
        .limit(pageSize)
        .all()) as Entity[];
    }

    return {
      entities: rows,
      nextCursor: null,
      prevCursor: null,
      count: rows.length,
      search,
      entityType: typeFilter,
      showMerged,
    };
  }

  // --- Advanced search mode ---
  if (hasAdvanced) {
    const conditions = [...baseConditions];
    if (advDisplayName)
      conditions.push(like(entities.displayName, `%${advDisplayName}%`));
    if (advSortName)
      conditions.push(like(entities.sortName, `%${advSortName}%`));
    if (advSurname) conditions.push(like(entities.surname, `%${advSurname}%`));
    if (advGivenName)
      conditions.push(like(entities.givenName, `%${advGivenName}%`));
    if (advEntityCode) conditions.push(eq(entities.entityCode, advEntityCode));
    if (advWikidataId)
      conditions.push(eq(entities.wikidataId, advWikidataId));
    if (advViafId) conditions.push(eq(entities.viafId, advViafId));

    // Cursor pagination applies in advanced mode
    if (cursor) {
      const sepIdx = cursor.lastIndexOf("|");
      const cursorName = cursor.substring(0, sepIdx);
      const cursorId = cursor.substring(sepIdx + 1);
      if (dir === "next") {
        conditions.push(
          sql`(${entities.sortName} > ${cursorName} OR (${entities.sortName} = ${cursorName} AND ${entities.id} > ${cursorId}))`
        );
      } else {
        conditions.push(
          sql`(${entities.sortName} < ${cursorName} OR (${entities.sortName} = ${cursorName} AND ${entities.id} < ${cursorId}))`
        );
      }
    }

    const rows = (await db
      .select()
      .from(entities)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        dir === "prev" ? desc(entities.sortName) : asc(entities.sortName),
        dir === "prev" ? desc(entities.id) : asc(entities.id)
      )
      .limit(pageSize + 1)
      .all()) as Entity[];

    const hasMore = rows.length > pageSize;
    if (hasMore) rows.pop();
    if (dir === "prev") rows.reverse();

    const makeCursor = (row: Entity) => `${row.sortName}|${row.id}`;

    return {
      entities: rows,
      nextCursor: hasMore ? makeCursor(rows[rows.length - 1]) : null,
      prevCursor: cursor && rows.length > 0 ? makeCursor(rows[0]) : null,
      count: rows.length,
      search: null,
      entityType: typeFilter,
      showMerged,
    };
  }

  // --- Browse mode (default) ---
  const conditions = [...baseConditions];

  if (cursor) {
    const sepIdx = cursor.lastIndexOf("|");
    const cursorName = cursor.substring(0, sepIdx);
    const cursorId = cursor.substring(sepIdx + 1);
    if (dir === "next") {
      conditions.push(
        sql`(${entities.sortName} > ${cursorName} OR (${entities.sortName} = ${cursorName} AND ${entities.id} > ${cursorId}))`
      );
    } else {
      conditions.push(
        sql`(${entities.sortName} < ${cursorName} OR (${entities.sortName} = ${cursorName} AND ${entities.id} < ${cursorId}))`
      );
    }
  }

  const rows = (await db
    .select()
    .from(entities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      dir === "prev" ? desc(entities.sortName) : asc(entities.sortName),
      dir === "prev" ? desc(entities.id) : asc(entities.id)
    )
    .limit(pageSize + 1)
    .all()) as Entity[];

  const hasMore = rows.length > pageSize;
  if (hasMore) rows.pop();
  if (dir === "prev") rows.reverse();

  const makeCursor = (row: Entity) => `${row.sortName}|${row.id}`;

  return {
    entities: rows,
    nextCursor: hasMore ? makeCursor(rows[rows.length - 1]) : null,
    prevCursor: cursor && rows.length > 0 ? makeCursor(rows[0]) : null,
    count: rows.length,
    search: null,
    entityType: typeFilter,
    showMerged,
  };
}

// ---------------------------------------------------------------------------
// Entity type badge colours
// ---------------------------------------------------------------------------

const TYPE_BADGE_STYLES: Record<string, string> = {
  person: "bg-indigo-tint text-indigo",
  family: "bg-verdigris-tint text-verdigris",
  corporate: "bg-indigo-tint text-indigo",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminEntitiesPage({
  loaderData,
}: Route.ComponentProps) {
  const data = loaderData;
  const { t } = useTranslation("entities");
  const [searchParams] = useSearchParams();

  // Table ref for ColumnToggle
  const tableRef = useRef<Table<Entity> | null>(null);
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    forceUpdate((n) => n + 1);
  }, []);

  // Search state with debounce
  const [searchInput, setSearchInput] = useState(data.search || "");
  const [debouncedSearch, setDebouncedSearch] = useState(data.search || "");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Navigate on debounced search change
  useEffect(() => {
    if (debouncedSearch !== (data.search || "")) {
      const params = new URLSearchParams(searchParams);
      if (debouncedSearch) {
        params.set("q", debouncedSearch);
      } else {
        params.delete("q");
      }
      params.delete("cursor");
      params.delete("dir");
      window.location.search = params.toString();
    }
  }, [debouncedSearch]);

  // Advanced search fields
  const advancedFields = useMemo(
    () => [
      { name: "displayName", label: t("field.displayName") },
      { name: "sortName", label: t("field.sortName") },
      { name: "surname", label: t("field.surname") },
      { name: "givenName", label: t("field.givenName") },
      { name: "entityCode", label: t("field.entityCode") },
      { name: "wikidataId", label: t("field.wikidataId") },
      { name: "viafId", label: t("field.viafId") },
    ],
    [t]
  );

  const advancedActive = isAdvancedActive(searchParams, advancedFields);

  // Column definitions
  const columns = useMemo<ColumnDef<Entity, unknown>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: t("field.displayName"),
        enableHiding: false,
        cell: ({ row }) => {
          const entity = row.original;
          const name = entity.displayName;
          if (entity.mergedInto) {
            return (
              <span className="opacity-60">
                {name}{" "}
                <span className="italic text-stone-400">
                  {t("mergedSuffix")}
                </span>
              </span>
            );
          }
          return name;
        },
      },
      {
        accessorKey: "entityType",
        header: t("field.entityType"),
        enableHiding: false,
        cell: ({ row }) => {
          const type = row.getValue("entityType") as string;
          const style = TYPE_BADGE_STYLES[type] || "";
          const label =
            type === "person"
              ? t("person")
              : type === "family"
                ? t("family")
                : t("corporate");
          return (
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style}`}
            >
              {label}
            </span>
          );
        },
      },
      {
        accessorKey: "entityCode",
        header: t("field.entityCode"),
        enableHiding: false,
        cell: ({ row }) => (
          <Link
            to={`/admin/entities/${row.original.id}`}
            className="font-semibold text-indigo-deep hover:underline"
          >
            {row.getValue("entityCode") as string}
          </Link>
        ),
      },
      {
        accessorKey: "datesOfExistence",
        header: t("field.datesOfExistence"),
        cell: ({ row }) =>
          (row.getValue("datesOfExistence") as string) || "\u2014",
      },
      {
        accessorKey: "primaryFunction",
        header: t("field.primaryFunction"),
        cell: ({ row }) => {
          const val = row.getValue("primaryFunction") as string | null;
          if (!val) return "\u2014";
          return val.length > 60 ? `${val.slice(0, 60)}...` : val;
        },
      },
      {
        accessorKey: "wikidataId",
        header: t("field.wikidataId"),
        cell: ({ row }) => {
          const val = row.getValue("wikidataId") as string | null;
          return val ? (
            <Check className="h-3.5 w-3.5 text-verdigris" />
          ) : (
            <span className="text-stone-400">{"\u2014"}</span>
          );
        },
      },
      {
        accessorKey: "viafId",
        header: t("field.viafId"),
        cell: ({ row }) => {
          const val = row.getValue("viafId") as string | null;
          return val ? (
            <Check className="h-3.5 w-3.5 text-verdigris" />
          ) : (
            <span className="text-stone-400">{"\u2014"}</span>
          );
        },
      },
      // Hidden by default columns
      {
        accessorKey: "surname",
        header: t("field.surname"),
        enableHiding: true,
        cell: ({ row }) =>
          (row.getValue("surname") as string) || "\u2014",
      },
      {
        accessorKey: "givenName",
        header: t("field.givenName"),
        enableHiding: true,
        cell: ({ row }) =>
          (row.getValue("givenName") as string) || "\u2014",
      },
      {
        accessorKey: "sortName",
        header: t("field.sortName"),
        enableHiding: true,
        cell: ({ row }) => row.getValue("sortName") as string,
      },
      {
        accessorKey: "nameVariants",
        header: t("field.nameVariants"),
        enableHiding: true,
        enableSorting: false,
        cell: ({ row }) => {
          const raw = row.getValue("nameVariants") as string | null;
          try {
            const arr = JSON.parse(raw || "[]");
            if (!Array.isArray(arr) || arr.length === 0) return "\u2014";
            return (
              <span className="inline-block rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                {arr.length}
              </span>
            );
          } catch {
            return "\u2014";
          }
        },
      },
    ],
    [t]
  );

  // Default column visibility: hide optional columns
  const defaultColumnVisibility = useMemo(
    () => ({
      surname: false,
      givenName: false,
      sortName: false,
      nameVariants: false,
    }),
    []
  );

  const table = tableRef.current;

  // Empty state
  if (data.entities.length === 0 && !data.search && !advancedActive) {
    return (
      <div className="mx-auto max-w-7xl px-8 py-12">
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-4xl font-semibold text-stone-700">
            {t("title")}
          </h1>
          <Link
            to="/admin/entities/new"
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
            to="/admin/entities/new"
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
          to="/admin/entities/new"
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
              disabled={advancedActive}
              className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Type filter */}
          <select
            value={searchParams.get("entityType") || ""}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              if (e.target.value) {
                params.set("entityType", e.target.value);
              } else {
                params.delete("entityType");
              }
              params.delete("cursor");
              params.delete("dir");
              window.location.search = params.toString();
            }}
            className="rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{t("allTypes")}</option>
            <option value="person">{t("person")}</option>
            <option value="family">{t("family")}</option>
            <option value="corporate">{t("corporate")}</option>
          </select>

          {/* Show merged */}
          <label className="flex items-center gap-2 text-sm font-medium text-indigo">
            <input
              type="checkbox"
              checked={data.showMerged}
              onChange={(e) => {
                const params = new URLSearchParams(searchParams);
                if (e.target.checked) {
                  params.set("showMerged", "true");
                } else {
                  params.delete("showMerged");
                }
                params.delete("cursor");
                params.delete("dir");
                window.location.search = params.toString();
              }}
              className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
            />
            {t("showMerged")}
          </label>

          {/* Column toggle */}
          {table && <ColumnToggle table={table} label={t("columnToggle")} />}
        </div>

        {/* Advanced search panel */}
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
        data={data.entities}
        columns={columns}
        defaultColumnVisibility={defaultColumnVisibility}
        defaultSorting={[{ id: "displayName", desc: false }]}
        emptyMessage={t("emptyHeading")}
        tableRef={tableRef}
      />

      {/* Cursor pagination */}
      <CursorPagination
        nextCursor={data.nextCursor}
        prevCursor={data.prevCursor}
        count={data.count}
        entityLabel={t("title").toLowerCase()}
      />
    </div>
  );
}
