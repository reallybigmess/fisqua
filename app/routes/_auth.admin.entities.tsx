/**
 * Entities Admin — List
 *
 * This page is the index for the entity authority records (people,
 * families, and corporate bodies). It renders a searchable data table
 * across the entire authority set, backed by SQLite FTS5 so an
 * accent-insensitive search like `gonzalez` matches both `González`
 * and `Gonzaléz` variants.
 *
 * The filter bar composes several server-side predicates that all read
 * against the same condition builder (`filterConditions`): the FTS/LIKE
 * search, three entity-type pills whose live counts recompute under the
 * other active filters, an attested-year range filtered by interval
 * overlap (`date_start <= to AND date_end >= from`, a missing bound
 * open-ended, fully undated rows excluded), and a primary-function
 * combobox resolved accent-insensitively to exact stored values. The
 * Links column carries each row's real linked-description count and
 * sorts server-side through a correlated subquery. Every count the page
 * renders derives from the same population as the rows it shows — the
 * pure-search fast path counts through its own MATCH predicate.
 *
 * Authority scope is the federation (migrations 0045-0048): every read of
 * `entities` is filtered by `tenant.federationId` (including the FTS5
 * fast path and every COUNT), resolved from the session tenant's
 * federation.
 *
 * @version v0.4.3
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, Plus, Check, GitMerge, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { BulkMergeToolbar } from "~/components/admin/bulk-merge-toolbar";
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
  dateStart: string | null;
  dateEnd: string | null;
  mergedInto: string | null;
  wikidataId: string | null;
  viafId: string | null;
  dbeId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Real count of linked descriptions for this row (per-page subquery). */
  linkCount: number;
  /** Survivor's display name, attached when showMerged is on. */
  survivorName?: string | null;
}

interface TypeCounts {
  person: number;
  corporate: number;
  family: number;
}

interface FunctionOption {
  value: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, gt, asc, desc, isNull, eq, like, or, inArray, sql } =
    await import("drizzle-orm");
  const { entities, descriptionEntities } = await import("~/db/schema");
  const { normaliseName } = await import("~/lib/authority-duplicates.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);
  const sp = url.searchParams;

  // Lightweight JSON search API for merge dialog (unchanged fast path).
  if (sp.get("_search") === "true") {
    const q = sp.get("q")?.trim() || "";
    const excludeId = sp.get("exclude") || "";
    const likePattern = `%${q}%`;
    const conditions = [
      eq(entities.federationId, tenant.federationId),
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
  const cursor = sp.get("cursor");
  const dir = sp.get("dir") || "next";
  const search = sp.get("q")?.trim() || null;

  // Type filter with the legacy `entityType=` param shim: old bookmarks
  // keep working, the new UI writes `type=`, and `type` wins when both
  // arrive. Validated against the enum; an off-vocabulary value falls
  // through to null (no filter) rather than erroring.
  const rawTypeFilter = sp.get("type") ?? sp.get("entityType");
  const typeFilter =
    rawTypeFilter && (ENTITY_TYPES as readonly string[]).includes(rawTypeFilter)
      ? (rawTypeFilter as (typeof ENTITY_TYPES)[number])
      : null;

  const showMerged = sp.get("showMerged") === "true";

  // Attested-year range. Interval overlap over ISO date strings:
  // `date_start <= to-12-31 AND date_end >= from-01-01`, with a missing
  // bound treated as open-ended (no date_end extends forward, no
  // date_start extends backward — the `datesOverlap` idiom). Only rows
  // with no dates at all are excluded while the filter is active (the
  // count line says so).
  function parseYear(raw: string | null): number | null {
    if (!raw) return null;
    const m = raw.trim().match(/^(\d{1,4})$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 9999 ? n : null;
  }
  const pad4 = (n: number) => String(n).padStart(4, "0");
  const yearFrom = parseYear(sp.get("yearFrom"));
  const yearTo = parseYear(sp.get("yearTo"));
  const fromStr = yearFrom != null ? `${pad4(yearFrom)}-01-01` : null;
  const toStr = yearTo != null ? `${pad4(yearTo)}-12-31` : null;

  // Sort: only the Links column sorts server-side (correlated subquery).
  // Everything else keeps the default sort-name browse order.
  const sortKey = sp.get("sort");
  const linksSort = sortKey === "links";
  const sortDir = sp.get("sortDir") === "asc" ? "asc" : "desc";

  // Advanced search fields (AND'd; when active the simple search is off).
  const advDisplayName = sp.get("displayName");
  const advSortName = sp.get("sortName");
  const advSurname = sp.get("surname");
  const advGivenName = sp.get("givenName");
  const advEntityCode = sp.get("entityCode");
  const advWikidataId = sp.get("wikidataId");
  const advViafId = sp.get("viafId");
  const hasAdvanced = !!(
    advDisplayName ||
    advSortName ||
    advSurname ||
    advGivenName ||
    advEntityCode ||
    advWikidataId ||
    advViafId
  );

  // Function combobox datalist: the distinct live primary_function values
  // with their real counts, computed once and shipped to the client (the
  // datalist never recomputes per keystroke). Global over the federation
  // — a reference list, not a filtered facet.
  const fnRows = await db
    .select({ value: entities.primaryFunction, count: sql<number>`count(*)` })
    .from(entities)
    .where(
      and(
        eq(entities.federationId, tenant.federationId),
        isNull(entities.mergedInto),
        sql`${entities.primaryFunction} IS NOT NULL AND ${entities.primaryFunction} != ''`,
      ),
    )
    .groupBy(entities.primaryFunction)
    .orderBy(desc(sql`count(*)`), asc(entities.primaryFunction))
    .all();
  const functionOptions: FunctionOption[] = fnRows.map((r) => ({
    value: r.value as string,
    count: r.count,
  }));

  // Resolve the function filter accent-insensitively to exact stored
  // values via the shared `normaliseName` idiom: normalise the input,
  // then keep every canonical value whose normalised form matches. A
  // datalist pick resolves to itself; a typed accentless query resolves
  // to its accented siblings. A present-but-unresolvable value filters
  // to zero rows (honest empty), never silently to everything.
  const fnRaw = sp.get("fn")?.trim() || null;
  let fnValues: string[] = [];
  if (fnRaw) {
    const norm = normaliseName(fnRaw);
    fnValues = functionOptions
      .filter((o) => normaliseName(o.value) === norm)
      .map((o) => o.value);
  }

  // FTS probe: the accent-insensitive fast path (display_name, sort_name;
  // unicode61 folds diacritics). FTS5 MATCH throws on inputs like an
  // unbalanced quote or a bare `*`; the expression is probed once, and
  // when it throws the FTS arm is dropped so the LIKE arms stand alone.
  let ftsMatch: string | null = null;
  if (search && !hasAdvanced) {
    const expr = search.startsWith('"')
      ? search
      : search
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `${t}*`)
          .join(" ");
    if (expr) {
      try {
        await db.all(
          sql`SELECT rowid FROM entities_fts WHERE entities_fts MATCH ${expr} LIMIT 1`,
        );
        ftsMatch = expr;
      } catch {
        ftsMatch = null;
      }
    }
  }

  // The shared predicate set. Every list, count, and facet query reads
  // from here so the numbers the UI renders match the rows it shows.
  // `includeType` lets the type-pill facet count sibling types without
  // its own filter. The federation predicate is spelt out inline so the
  // tenant-isolation static guard sees it at every site.
  function filterConditions(includeType: boolean): any[] {
    const c: any[] = [eq(entities.federationId, tenant.federationId)];
    if (!showMerged) c.push(isNull(entities.mergedInto));
    if (includeType && typeFilter) c.push(eq(entities.entityType, typeFilter));
    // Year overlap with open-ended bounds: a missing date_end means the
    // range extends forward (satisfies any `from`), a missing date_start
    // extends backward (satisfies any `to`); rows carrying no dates at
    // all are excluded whenever the filter is active.
    if (fromStr || toStr) {
      c.push(
        sql`((${entities.dateStart} IS NOT NULL AND ${entities.dateStart} != '') OR (${entities.dateEnd} IS NOT NULL AND ${entities.dateEnd} != ''))`,
      );
    }
    if (fromStr) {
      c.push(
        sql`(${entities.dateEnd} >= ${fromStr} OR ${entities.dateEnd} IS NULL OR ${entities.dateEnd} = '')`,
      );
    }
    if (toStr) {
      c.push(
        sql`(${entities.dateStart} <= ${toStr} OR ${entities.dateStart} IS NULL OR ${entities.dateStart} = '')`,
      );
    }
    if (fnRaw) {
      if (fnValues.length > 0) {
        c.push(inArray(entities.primaryFunction, fnValues));
      } else {
        c.push(sql`1 = 0`);
      }
    }
    if (hasAdvanced) {
      if (advDisplayName)
        c.push(like(entities.displayName, `%${advDisplayName}%`));
      if (advSortName) c.push(like(entities.sortName, `%${advSortName}%`));
      if (advSurname) c.push(like(entities.surname, `%${advSurname}%`));
      if (advGivenName) c.push(like(entities.givenName, `%${advGivenName}%`));
      if (advEntityCode) c.push(eq(entities.entityCode, advEntityCode));
      if (advWikidataId) c.push(eq(entities.wikidataId, advWikidataId));
      if (advViafId) c.push(eq(entities.viafId, advViafId));
    } else if (search) {
      const pat = `%${search}%`;
      const arms: any[] = [
        like(entities.displayName, pat),
        like(entities.sortName, pat),
      ];
      if (ftsMatch) {
        arms.push(
          sql`${entities.id} IN (SELECT e2.id FROM entities e2 INNER JOIN entities_fts fts ON fts.rowid = e2.rowid WHERE entities_fts MATCH ${ftsMatch})`,
        );
      }
      c.push(or(...arms)!);
    }
    return c;
  }

  // Normalise a page row (drizzle camelCase OR raw-FTS snake_case) into
  // the Entity shape the table renders. The FTS fast path returns
  // `SELECT e.*`, whose keys are snake_case; every other query is
  // drizzle-typed. Reading both spellings keeps rendering uniform.
  function mapRow(r: any): Entity {
    const pick = (camel: string, snake: string) =>
      r[camel] ?? r[snake] ?? null;
    return {
      id: r.id,
      entityCode: pick("entityCode", "entity_code"),
      displayName: pick("displayName", "display_name"),
      sortName: pick("sortName", "sort_name"),
      surname: pick("surname", "surname"),
      givenName: pick("givenName", "given_name"),
      entityType: pick("entityType", "entity_type"),
      honorific: pick("honorific", "honorific"),
      primaryFunction: pick("primaryFunction", "primary_function"),
      nameVariants: pick("nameVariants", "name_variants"),
      datesOfExistence: pick("datesOfExistence", "dates_of_existence"),
      dateStart: pick("dateStart", "date_start"),
      dateEnd: pick("dateEnd", "date_end"),
      mergedInto: pick("mergedInto", "merged_into"),
      wikidataId: pick("wikidataId", "wikidata_id"),
      viafId: pick("viafId", "viaf_id"),
      dbeId: pick("dbeId", "dbe_id"),
      createdAt: r.createdAt ?? r.created_at ?? 0,
      updatedAt: r.updatedAt ?? r.updated_at ?? 0,
      linkCount: 0,
    };
  }

  // Attach the real linked-description count to each visible row with a
  // single per-page grouped query over the page's ids (cheap — the page
  // is at most 50 rows). Federation-scoped through the entities join.
  async function attachLinkCounts(rows: Entity[]): Promise<Entity[]> {
    if (rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const linkRows = await db
      .select({
        entityId: descriptionEntities.entityId,
        count: sql<number>`count(*)`,
      })
      .from(descriptionEntities)
      .innerJoin(entities, eq(descriptionEntities.entityId, entities.id))
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          inArray(descriptionEntities.entityId, ids),
        ),
      )
      .groupBy(descriptionEntities.entityId)
      .all();
    const linkMap = new Map(linkRows.map((r) => [r.entityId, r.count]));
    return rows.map((r) => ({ ...r, linkCount: linkMap.get(r.id) ?? 0 }));
  }

  // Resolve each merged row's survivor name (one IN query) so the list
  // can render the "merged → survivor" indicator under showMerged.
  async function attachSurvivors(rows: Entity[]): Promise<Entity[]> {
    if (!showMerged) return rows;
    const mergedIds = Array.from(
      new Set(rows.map((r) => r.mergedInto).filter((v): v is string => v != null)),
    );
    if (mergedIds.length === 0) return rows;
    const survivors = await db
      .select({ id: entities.id, displayName: entities.displayName })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          inArray(entities.id, mergedIds),
        ),
      )
      .all();
    const names = new Map(survivors.map((r) => [r.id, r.displayName]));
    return rows.map((r) => ({
      ...r,
      survivorName: r.mergedInto ? (names.get(r.mergedInto) ?? null) : null,
    }));
  }

  async function finalize(rows: Entity[]): Promise<Entity[]> {
    return attachSurvivors(await attachLinkCounts(rows));
  }

  // Honest totals under every active filter: the count line's Y, and the
  // three type-pill counts computed with the type filter itself skipped
  // (cross-honest — the pills recompute under search, years, function).
  // Every number must derive from exactly the population the table
  // shows, so the pure-search FTS branch computes its own counts from
  // the same MATCH predicate its list uses; every other mode counts
  // through the shared predicate builder here.
  function foldTypeCounts(
    rows: { type: string | null; count: number }[],
  ): TypeCounts {
    const counts: TypeCounts = { person: 0, corporate: 0, family: 0 };
    for (const r of rows) {
      if (r.type != null && r.type in counts) {
        counts[r.type as keyof TypeCounts] = r.count;
      }
    }
    return counts;
  }
  async function standardCounts(): Promise<{
    total: number;
    typeCounts: TypeCounts;
  }> {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          ...filterConditions(true),
        ),
      )
      .all();
    const typeRows = await db
      .select({ type: entities.entityType, count: sql<number>`count(*)` })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          ...filterConditions(false),
        ),
      )
      .groupBy(entities.entityType)
      .all();
    return { total, typeCounts: foldTypeCounts(typeRows) };
  }

  const shared = {
    functionOptions,
    search,
    entityType: typeFilter,
    yearFrom: yearFrom != null ? String(yearFrom) : "",
    yearTo: yearTo != null ? String(yearTo) : "",
    fn: fnRaw ?? "",
    sort: linksSort ? "links" : null,
    sortDir,
    showMerged,
  };

  // --- Links-sort mode: correlated-subquery ORDER BY, offset paging ---
  // The keyset cursor (sortName, id) cannot page a computed sort, so this
  // sort — and only this sort — uses offset pagination. The GROUP-BY-join
  // form was measured at 2.2 s; the correlated subquery at ~160 ms.
  if (linksSort) {
    const { total, typeCounts } = await standardCounts();
    const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
    const linkCountSub = sql<number>`(SELECT COUNT(*) FROM description_entities de WHERE de.entity_id = ${entities.id})`;
    const raw = (await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          ...filterConditions(true),
        ),
      )
      .orderBy(
        sortDir === "asc" ? sql`${linkCountSub} ASC` : sql`${linkCountSub} DESC`,
        asc(entities.id),
      )
      .limit(pageSize + 1)
      .offset(offset)
      .all()) as any[];
    const hasMore = raw.length > pageSize;
    if (hasMore) raw.pop();
    const rows = await finalize(raw.map(mapRow));
    return {
      entities: rows,
      nextCursor: hasMore ? String(offset + pageSize) : null,
      prevCursor: offset > 0 ? String(Math.max(0, offset - pageSize)) : null,
      count: rows.length,
      totalCount: total,
      typeCounts,
      ...shared,
    };
  }

  // --- FTS search mode: the rank-ordered fast path, filters composed ---
  // The total and the type-pill counts come from the SAME MATCH predicate
  // the list uses (honest counts: every rendered number derives from
  // exactly the population the table shows); when MATCH rejects the
  // expression the whole mode — list and counts alike — falls back to
  // the LIKE arms through the shared predicate.
  if (search && !hasAdvanced) {
    let rows: Entity[];
    let total: number;
    let typeCounts: TypeCounts;
    try {
      const expr =
        ftsMatch ??
        search
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => `${t}*`)
          .join(" ");
      const mergedClause = showMerged
        ? sql``
        : sql` AND e.merged_into IS NULL`;
      const typeClause = typeFilter
        ? sql` AND e.entity_type = ${typeFilter}`
        : sql``;
      // Year overlap, mirrored from `filterConditions`: open-ended bounds
      // pass their side of the comparison; fully undated rows drop out.
      const datedClause =
        fromStr || toStr
          ? sql` AND ((e.date_start IS NOT NULL AND e.date_start != '') OR (e.date_end IS NOT NULL AND e.date_end != ''))`
          : sql``;
      const fromClause = fromStr
        ? sql` AND (e.date_end >= ${fromStr} OR e.date_end IS NULL OR e.date_end = '')`
        : sql``;
      const toClause = toStr
        ? sql` AND (e.date_start <= ${toStr} OR e.date_start IS NULL OR e.date_start = '')`
        : sql``;
      const fnClause = fnRaw
        ? fnValues.length > 0
          ? sql` AND e.primary_function IN (${sql.join(
              fnValues.map((v) => sql`${v}`),
              sql`, `,
            )})`
          : sql` AND 1 = 0`
        : sql``;
      const ftsResults = await db.all(sql`
        SELECT e.*
        FROM entities e
        INNER JOIN entities_fts fts ON fts.rowid = e.rowid
        WHERE entities_fts MATCH ${expr}
        AND e.federation_id = ${tenant.federationId}
        ${mergedClause}${typeClause}${datedClause}${fromClause}${toClause}${fnClause}
        ORDER BY rank
        LIMIT ${pageSize}
      `);
      rows = (ftsResults as any[]).map(mapRow);
      const totalRows = (await db.all(sql`
        SELECT count(*) AS total
        FROM entities e
        INNER JOIN entities_fts fts ON fts.rowid = e.rowid
        WHERE entities_fts MATCH ${expr}
        AND e.federation_id = ${tenant.federationId}
        ${mergedClause}${typeClause}${datedClause}${fromClause}${toClause}${fnClause}
      `)) as { total: number }[];
      total = totalRows[0]?.total ?? 0;
      // Pills skip the type clause (cross-honest), keep everything else.
      const pillRows = (await db.all(sql`
        SELECT e.entity_type AS type, count(*) AS count
        FROM entities e
        INNER JOIN entities_fts fts ON fts.rowid = e.rowid
        WHERE entities_fts MATCH ${expr}
        AND e.federation_id = ${tenant.federationId}
        ${mergedClause}${datedClause}${fromClause}${toClause}${fnClause}
        GROUP BY e.entity_type
      `)) as { type: string | null; count: number }[];
      typeCounts = foldTypeCounts(pillRows);
    } catch {
      // FTS syntax rejected the expression: fall back to the LIKE arms
      // through the shared predicate (no rank, sort-name order) — list
      // and counts from the same population.
      const raw = (await db
        .select()
        .from(entities)
        .where(and(...filterConditions(true)))
        .orderBy(asc(entities.sortName))
        .limit(pageSize)
        .all()) as any[];
      rows = raw.map(mapRow);
      ({ total, typeCounts } = await standardCounts());
    }
    const finalRows = await finalize(rows);
    return {
      entities: finalRows,
      nextCursor: null,
      prevCursor: null,
      count: finalRows.length,
      totalCount: total,
      typeCounts,
      ...shared,
    };
  }

  // --- Keyset browse / advanced mode (default) ---
  const { total, typeCounts } = await standardCounts();
  const conditions = [...filterConditions(true)];
  if (cursor) {
    const sepIdx = cursor.lastIndexOf("|");
    const cursorName = cursor.substring(0, sepIdx);
    const cursorId = cursor.substring(sepIdx + 1);
    if (dir === "next") {
      conditions.push(
        sql`(${entities.sortName} > ${cursorName} OR (${entities.sortName} = ${cursorName} AND ${entities.id} > ${cursorId}))`,
      );
    } else {
      conditions.push(
        sql`(${entities.sortName} < ${cursorName} OR (${entities.sortName} = ${cursorName} AND ${entities.id} < ${cursorId}))`,
      );
    }
  }

  const raw = (await db
    .select()
    .from(entities)
    .where(and(...conditions))
    .orderBy(
      dir === "prev" ? desc(entities.sortName) : asc(entities.sortName),
      dir === "prev" ? desc(entities.id) : asc(entities.id),
    )
    .limit(pageSize + 1)
    .all()) as any[];

  const hasMore = raw.length > pageSize;
  if (hasMore) raw.pop();
  if (dir === "prev") raw.reverse();

  const rows = await finalize(raw.map(mapRow));
  const makeCursor = (row: Entity) => `${row.sortName}|${row.id}`;

  return {
    entities: rows,
    nextCursor: hasMore ? makeCursor(rows[rows.length - 1]) : null,
    prevCursor: cursor && rows.length > 0 ? makeCursor(rows[0]) : null,
    count: rows.length,
    totalCount: total,
    typeCounts,
    ...shared,
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
  const { t: ta } = useTranslation("authorities");
  const [searchParams] = useSearchParams();

  // Row selection for the two-record bulk-merge entry point.
  const [selIds, setSelIds] = useState<Set<string>>(() => new Set());
  const toggleSel = (id: string) =>
    setSelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Table ref for ColumnToggle and the honorific-suffix visibility read.
  const tableRef = useRef<Table<Entity> | null>(null);
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    forceUpdate((n) => n + 1);
  }, []);

  // Navigate with the current params, mutated, resetting pagination.
  function navigateWith(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams);
    mutate(params);
    params.delete("cursor");
    params.delete("dir");
    window.location.search = params.toString();
  }

  // Search state with debounce.
  const [searchInput, setSearchInput] = useState(data.search || "");
  const [debouncedSearch, setDebouncedSearch] = useState(data.search || "");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    if (debouncedSearch !== (data.search || "")) {
      navigateWith((p) => {
        if (debouncedSearch) p.set("q", debouncedSearch);
        else p.delete("q");
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  // Year-range local state, committed on blur/Enter.
  const [yearFrom, setYearFrom] = useState(data.yearFrom || "");
  const [yearTo, setYearTo] = useState(data.yearTo || "");
  const commitYear = (key: "yearFrom" | "yearTo", value: string) => {
    const clean = value.trim();
    if (clean === (key === "yearFrom" ? data.yearFrom : data.yearTo)) return;
    navigateWith((p) => {
      if (clean) p.set(key, clean);
      else p.delete(key);
    });
  };

  // Function combobox local state, committed on change/blur/Enter.
  const [fnInput, setFnInput] = useState(data.fn || "");
  const commitFn = (value: string) => {
    const clean = value.trim();
    if (clean === (data.fn || "")) return;
    navigateWith((p) => {
      if (clean) p.set("fn", clean);
      else p.delete("fn");
    });
  };

  // Type pills: click a type to set it, click the active one to clear.
  const activeType = data.entityType;
  const toggleType = (ty: string) => {
    navigateWith((p) => {
      if (activeType === ty) p.delete("type");
      else p.set("type", ty);
      p.delete("entityType");
      p.delete("sort");
      p.delete("sortDir");
    });
  };

  // Links column server sort: cycles descending → ascending → off.
  const sortByLinks = () => {
    navigateWith((p) => {
      const cur = p.get("sort") === "links" ? p.get("sortDir") : null;
      if (cur == null) {
        p.set("sort", "links");
        p.set("sortDir", "desc");
      } else if (cur === "desc") {
        p.set("sort", "links");
        p.set("sortDir", "asc");
      } else {
        p.delete("sort");
        p.delete("sortDir");
      }
    });
  };
  const linksActive = data.sort === "links";
  const linksDesc = data.sortDir === "desc";

  const anyFilter =
    !!data.search ||
    !!activeType ||
    !!data.yearFrom ||
    !!data.yearTo ||
    !!data.fn ||
    data.sort === "links";

  const resetAll = () => {
    window.location.search = "";
  };

  // Advanced search fields.
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
    [t],
  );
  const advancedActive = isAdvancedActive(searchParams, advancedFields);

  // Column definitions.
  const columns = useMemo<ColumnDef<Entity, unknown>[]>(
    () => [
      {
        id: "_select",
        header: () => null,
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={ta("bulkMerge")}
            checked={selIds.has(row.original.id)}
            onChange={() => toggleSel(row.original.id)}
            className="h-4 w-4 accent-indigo"
          />
        ),
      },
      {
        accessorKey: "displayName",
        header: t("field.displayName"),
        enableHiding: false,
        cell: ({ row }) => {
          const entity = row.original;
          const honVisible =
            tableRef.current?.getColumn("honorific")?.getIsVisible() ?? false;
          const suffix =
            !honVisible && entity.honorific ? (
              <span className="ml-1.5 text-11 text-stone-500">
                {entity.honorific}
              </span>
            ) : null;
          if (entity.mergedInto) {
            return (
              <span className="inline-flex items-center gap-2 opacity-55">
                {entity.displayName}
                {suffix}
                <span className="inline-flex items-center gap-1 rounded-full bg-madder-tint px-2 py-0.5 text-11 font-semibold text-madder-deep">
                  <GitMerge className="h-3 w-3" strokeWidth={1.5} />
                  {ta("mergedPill")}
                </span>
                {entity.survivorName && (
                  <span className="text-11 text-stone-500">
                    {ta("mergedArrow", { survivor: entity.survivorName })}
                  </span>
                )}
              </span>
            );
          }
          return (
            <span>
              {entity.displayName}
              {suffix}
            </span>
          );
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
        header: t("col_attested"),
        cell: ({ row }) =>
          (row.getValue("datesOfExistence") as string) || "—",
      },
      {
        accessorKey: "primaryFunction",
        header: t("field.primaryFunction"),
        cell: ({ row }) => {
          const val = row.getValue("primaryFunction") as string | null;
          if (!val) return "—";
          return val.length > 60 ? `${val.slice(0, 60)}...` : val;
        },
      },
      {
        id: "links",
        accessorKey: "linkCount",
        enableHiding: true,
        enableSorting: false,
        header: () => (
          <button
            type="button"
            onClick={sortByLinks}
            aria-label={t("sortByLinksAria")}
            className="inline-flex w-full items-center justify-end gap-1"
          >
            {t("field.links")}
            {linksActive ? (
              linksDesc ? (
                <ArrowDown className="h-4 w-4 text-indigo" />
              ) : (
                <ArrowUp className="h-4 w-4 text-indigo" />
              )
            ) : (
              <ArrowUpDown className="h-4 w-4 text-stone-500" />
            )}
          </button>
        ),
        cell: ({ row }) => (
          <div className="text-right font-mono text-13 tabular-nums text-indigo">
            {row.original.linkCount}
          </div>
        ),
      },
      // Optional column: while hidden, honorific renders as a name suffix.
      {
        accessorKey: "honorific",
        id: "honorific",
        header: t("field.honorific"),
        enableHiding: true,
        cell: ({ row }) => (row.getValue("honorific") as string) || "—",
      },
      // Identifier columns — off by default (near-empty coverage).
      {
        accessorKey: "wikidataId",
        header: t("field.wikidataId"),
        enableHiding: true,
        cell: ({ row }) => {
          const val = row.getValue("wikidataId") as string | null;
          return val ? (
            <Check className="h-3.5 w-3.5 text-verdigris" />
          ) : (
            <span className="text-stone-400">{"—"}</span>
          );
        },
      },
      {
        accessorKey: "viafId",
        header: t("field.viafId"),
        enableHiding: true,
        cell: ({ row }) => {
          const val = row.getValue("viafId") as string | null;
          return val ? (
            <Check className="h-3.5 w-3.5 text-verdigris" />
          ) : (
            <span className="text-stone-400">{"—"}</span>
          );
        },
      },
      {
        accessorKey: "dbeId",
        header: t("field.dbeId"),
        enableHiding: true,
        cell: ({ row }) => {
          const val = row.getValue("dbeId") as string | null;
          return val ? (
            <Check className="h-3.5 w-3.5 text-verdigris" />
          ) : (
            <span className="text-stone-400">{"—"}</span>
          );
        },
      },
      // Hidden-by-default detail columns (unchanged).
      {
        accessorKey: "surname",
        header: t("field.surname"),
        enableHiding: true,
        cell: ({ row }) => (row.getValue("surname") as string) || "—",
      },
      {
        accessorKey: "givenName",
        header: t("field.givenName"),
        enableHiding: true,
        cell: ({ row }) => (row.getValue("givenName") as string) || "—",
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
            if (!Array.isArray(arr) || arr.length === 0) return "—";
            return (
              <span className="inline-block rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                {arr.length}
              </span>
            );
          } catch {
            return "—";
          }
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, ta, selIds, linksActive, linksDesc],
  );

  // Default column visibility. The redesign changes DEFAULTS ONLY — the
  // Columns toggle behaviour is unchanged; a fresh user gets Links on and
  // the near-empty identifier columns (plus honorific) off.
  const defaultColumnVisibility = useMemo(
    () => ({
      links: true,
      honorific: false,
      wikidataId: false,
      viafId: false,
      dbeId: false,
      surname: false,
      givenName: false,
      sortName: false,
      nameVariants: false,
    }),
    [],
  );

  const table = tableRef.current;

  // Empty state.
  if (data.entities.length === 0 && !anyFilter && !advancedActive) {
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

  const pill = (ty: "person" | "corporate" | "family") => {
    const isActive = activeType === ty;
    return (
      <button
        key={ty}
        type="button"
        onClick={() => toggleType(ty)}
        aria-pressed={isActive}
        aria-label={t("typeFilterAria", { type: t(ty) })}
        className={`inline-flex h-[26px] items-center gap-1.5 rounded-full border px-3 text-12 font-semibold ${
          isActive
            ? "border-indigo bg-indigo text-white"
            : "border-stone-200 bg-white text-stone-600 hover:border-indigo-soft"
        }`}
      >
        {t(ty)}
        <span
          className={`font-mono text-11 ${isActive ? "text-indigo-tint" : "text-stone-400"}`}
        >
          {data.typeCounts[ty].toLocaleString()}
        </span>
      </button>
    );
  };

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

      {/* Filter bar */}
      <div className="mb-4 mt-6 rounded-lg border border-stone-200 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative min-w-[180px] flex-1 basis-[220px] sm:max-w-[320px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              disabled={advancedActive}
              className="h-[30px] w-full rounded-lg border border-stone-200 pl-9 pr-3 font-sans text-13 shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Type pills */}
          <span className="whitespace-nowrap text-11 text-stone-500">
            {t("filterByType")}
          </span>
          {pill("person")}
          {pill("corporate")}
          {pill("family")}

          <span className="mx-1 h-[18px] w-px bg-stone-200" />

          {/* Attested-year range */}
          <span className="whitespace-nowrap text-11 text-stone-500">
            {t("attested")}
          </span>
          <input
            inputMode="numeric"
            value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value)}
            onBlur={() => commitYear("yearFrom", yearFrom)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitYear("yearFrom", yearFrom);
            }}
            placeholder={t("yearFromPlaceholder")}
            aria-label={t("yearFromAria")}
            className="h-[30px] w-14 rounded-lg border border-stone-200 text-center font-mono text-12 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <span className="text-stone-400">{"–"}</span>
          <input
            inputMode="numeric"
            value={yearTo}
            onChange={(e) => setYearTo(e.target.value)}
            onBlur={() => commitYear("yearTo", yearTo)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitYear("yearTo", yearTo);
            }}
            placeholder={t("yearToPlaceholder")}
            aria-label={t("yearToAria")}
            className="h-[30px] w-14 rounded-lg border border-stone-200 text-center font-mono text-12 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />

          <span className="mx-1 h-[18px] w-px bg-stone-200" />

          {/* Function combobox */}
          <input
            list="entity-functions"
            value={fnInput}
            onChange={(e) => {
              setFnInput(e.target.value);
              // A datalist pick fires change with the full value.
              const picked = data.functionOptions.some(
                (o) => o.value === e.target.value,
              );
              if (picked) commitFn(e.target.value);
            }}
            onBlur={() => commitFn(fnInput)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitFn(fnInput);
            }}
            placeholder={t("functionFilterPlaceholder")}
            aria-label={t("functionFilterAria")}
            className="h-[30px] w-[170px] rounded-lg border border-stone-200 px-3 font-sans text-12 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <datalist id="entity-functions">
            {data.functionOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {`${o.value} (${o.count})`}
              </option>
            ))}
          </datalist>

          {/* Show merged — styled switch (unchanged semantics) */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={data.showMerged}
              aria-label={ta("showMerged")}
              onClick={() =>
                navigateWith((p) => {
                  if (data.showMerged) p.delete("showMerged");
                  else p.set("showMerged", "true");
                })
              }
              className={`relative h-5 w-[38px] flex-shrink-0 rounded-full transition-colors ${
                data.showMerged ? "bg-verdigris" : "bg-stone-300"
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                  data.showMerged ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
            <span className="text-13 text-stone-700">{ta("showMerged")}</span>
          </div>

          {/* Reset */}
          {anyFilter && (
            <button
              type="button"
              onClick={resetAll}
              aria-label={t("resetAria")}
              className="px-1.5 py-1 text-12 font-semibold text-verdigris hover:underline"
            >
              {t("reset")}
            </button>
          )}

          {/* Column toggle (kept exactly — defaults changed in the loader) */}
          {table && <ColumnToggle table={table} label={t("columnToggle")} />}
        </div>

        {/* Advanced search panel (unchanged) */}
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

      {/* Count line */}
      <p className="mb-3 text-12 text-stone-500">
        {t("countLine", {
          shown: data.entities.length,
          total: data.totalCount.toLocaleString(),
        })}
        {(data.yearFrom || data.yearTo) && ` · ${t("undatedExcluded")}`}
      </p>

      {/* Bulk-merge toolbar (appears at ≥1 selected) */}
      <BulkMergeToolbar
        selectedIds={Array.from(selIds)}
        onClear={() => setSelIds(new Set())}
        basePath="/admin/entities"
        t={ta}
      />

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
