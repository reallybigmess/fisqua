/**
 * Descriptions Admin — Tree and Column Views
 *
 * This page is the archival descriptions explorer. It renders the hierarchy of
 * fonds-to-item records either as a lazy-loaded tree or as a Miller
 * column view for deeper browsing, backed by the FTS5 search index
 * for accent-insensitive find-as-you-type across reference codes and
 * titles. Supports inline edit of a handful of frequently-touched
 * fields, drag-to-reorder within a parent, and cross-subtree moves
 * through the move dialog. The "New description" button opens the
 * create form; each row deep-links into the edit page.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `descriptions` and
 * `repositories` is filtered by `tenant.id`.
 *
 * Standard-aware label routing: this route renders no section labels
 * (those live in the form's collapsible sections), no hardcoded
 * standard names ("ISAD"/"ISAD(G)"/etc.) anywhere in page chrome,
 * and only level labels and column-header labels in the column view.
 * Description-level labels (fonds / series / file / item / etc.) are
 * universal across ISAD(G) / DACS / RAD and STAY FLAT as
 * `t("level_" + level)` — the convention is shared across at least
 * three files (this one, the description form, the breadcrumbs in
 * the cataloguing surface) and changing it here without updating the
 * others would create lockstep drift. No `tStd` routing is needed
 * here because no section / per-standard-divergent labels are
 * rendered in this file. The route is therefore standard-neutral by
 * construction.
 *
 * Trust-boundary note: any future addition of breadcrumb chains or
 * page-chrome sub-labels that mention archival sections (e.g.
 * "Identity statement" / "Context") MUST route through `tStd(t,
 * "sections.<id>", standard)` with `standard =
 * tenant.descriptiveStandard` read from `tenantContext`. Level
 * labels — even in a future breadcrumb — stay flat.
 *
 * @version v0.4.0
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link, useSearchParams, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Plus, Search, Check } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { MillerColumns } from "~/components/descriptions/miller-columns";
import { MetadataPreview } from "~/components/descriptions/metadata-preview";
import { DataTable } from "~/components/data-table/data-table";
import { ColumnToggle } from "~/components/data-table/column-toggle";
import { CursorPagination } from "~/components/data-table/cursor-pagination";
import { DESCRIPTION_LEVELS } from "~/lib/validation/enums";
import type { TreeItem } from "~/components/descriptions/miller-columns";
import type {
  ColumnDef,
  Table,
} from "~/components/data-table/data-table";
import type { Route } from "./+types/_auth.admin.descriptions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DescriptionRow {
  id: string;
  referenceCode: string;
  title: string;
  descriptionLevel: string;
  repositoryName: string | null;
  hasDigital: boolean;
  parentReferenceCode: string | null;
}

interface Repository {
  id: string;
  name: string;
  code: string;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, gt, lt, asc, desc, eq, like, isNotNull, sql } = await import(
    "drizzle-orm"
  );
  const { descriptions, repositories } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "tree";

  // Tree view — MillerColumns handles its own data loading
  if (view !== "columns") {
    return { view: "tree" as const };
  }

  // -------------------------------------------------------------------
  // Column view — FTS5 search with DataTable + cursor pagination
  // -------------------------------------------------------------------

  const pageSize = 50;
  const cursor = url.searchParams.get("cursor");
  const dir = url.searchParams.get("dir") || "next";
  const search = url.searchParams.get("q")?.trim() || null;
  const levelFilter = url.searchParams.get("level");
  const repoFilter = url.searchParams.get("repoId");
  const hasDigitalFilter = url.searchParams.get("hasDigital");

  // Validate filters against the closed enum.
  const validLevel =
    levelFilter &&
    (DESCRIPTION_LEVELS as readonly string[]).includes(levelFilter)
      ? (levelFilter as (typeof DESCRIPTION_LEVELS)[number])
      : null;
  const validRepoId = repoFilter || null;

  // Lightweight search API for typeahead
  if (url.searchParams.get("_search") === "true") {
    const q = search || "";
    const likePattern = `%${q}%`;
    const rows = await db
      .select({
        id: descriptions.id,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        descriptionLevel: descriptions.descriptionLevel,
      })
      .from(descriptions)
      .where(
        q
          ? and(
              eq(descriptions.tenantId, tenant.id),
              sql`(${descriptions.title} LIKE ${likePattern} OR ${descriptions.referenceCode} LIKE ${likePattern})`
            )
          : eq(descriptions.tenantId, tenant.id)
      )
      .orderBy(asc(descriptions.referenceCode))
      .limit(20)
      .all();
    return Response.json(rows);
  }

  // Load repositories for filter dropdown
  const allRepos = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      code: repositories.code,
    })
    .from(repositories)
    .where(eq(repositories.tenantId, tenant.id))
    .orderBy(asc(repositories.name))
    .all();

  // Build base conditions. Tenant predicate is always present.
  const baseConditions: any[] = [eq(descriptions.tenantId, tenant.id)];
  if (validLevel) {
    baseConditions.push(eq(descriptions.descriptionLevel, validLevel));
  }
  if (validRepoId) {
    baseConditions.push(eq(descriptions.repositoryId, validRepoId));
  }
  if (hasDigitalFilter === "true") {
    baseConditions.push(eq(descriptions.hasDigital, true));
  }

  // --- Search mode: FTS5 with LIKE fallback ---
  if (search) {
    let searchIds: string[] | null = null;
    try {
      // Build FTS5 query (parameterised).
      const ftsQuery = search.startsWith('"')
        ? search
        : search
            .split(/\s+/)
            .filter(Boolean)
            .map((t) => `${t}*`)
            .join(" ");

      const ftsResults = await db.all(sql`
        SELECT rowid FROM descriptions_fts WHERE descriptions_fts MATCH ${ftsQuery}
        LIMIT 200
      `);
      searchIds = (ftsResults as any[]).map((r) => String(r.rowid));
    } catch {
      // FTS5 not available — fallback to LIKE
    }

    if (searchIds !== null && searchIds.length > 0) {
      // Use rowid IN (...)
      baseConditions.push(
        sql`${descriptions}.rowid IN (${sql.join(
          searchIds.map((id) => sql`${parseInt(id, 10)}`),
          sql`, `
        )})`
      );
    } else if (searchIds === null) {
      // LIKE fallback (parameterised).
      const likePattern = `%${search}%`;
      baseConditions.push(
        sql`(${descriptions.title} LIKE ${likePattern} OR ${descriptions.referenceCode} LIKE ${likePattern})`
      );
    } else {
      // FTS returned 0 results
      return {
        view: "columns" as const,
        items: [] as DescriptionRow[],
        nextCursor: null,
        prevCursor: null,
        total: 0,
        query: search,
        filters: { level: validLevel, repoId: validRepoId, hasDigital: hasDigitalFilter },
        repositories: allRepos,
      };
    }
  }

  // Cursor pagination
  if (cursor) {
    const sepIdx = cursor.lastIndexOf("|");
    const cursorCode = cursor.substring(0, sepIdx);
    const cursorId = cursor.substring(sepIdx + 1);
    if (dir === "next") {
      baseConditions.push(
        sql`(${descriptions.referenceCode} > ${cursorCode} OR (${descriptions.referenceCode} = ${cursorCode} AND ${descriptions.id} > ${cursorId}))`
      );
    } else {
      baseConditions.push(
        sql`(${descriptions.referenceCode} < ${cursorCode} OR (${descriptions.referenceCode} = ${cursorCode} AND ${descriptions.id} < ${cursorId}))`
      );
    }
  }

  // Parent subquery for parent reference code
  const parentDesc = sql`(SELECT d2.reference_code FROM descriptions d2 WHERE d2.id = ${descriptions.parentId})`.as(
    "parent_reference_code"
  );

  const rows = await db
    .select({
      id: descriptions.id,
      referenceCode: descriptions.referenceCode,
      title: descriptions.title,
      descriptionLevel: descriptions.descriptionLevel,
      repositoryName: repositories.name,
      hasDigital: descriptions.hasDigital,
      parentReferenceCode: parentDesc,
    })
    .from(descriptions)
    .leftJoin(repositories, eq(descriptions.repositoryId, repositories.id))
    .where(baseConditions.length > 0 ? and(...baseConditions) : undefined)
    .orderBy(
      dir === "prev"
        ? desc(descriptions.referenceCode)
        : asc(descriptions.referenceCode),
      dir === "prev" ? desc(descriptions.id) : asc(descriptions.id)
    )
    .limit(pageSize + 1)
    .all();

  const hasMore = rows.length > pageSize;
  if (hasMore) rows.pop();
  if (dir === "prev") rows.reverse();

  const makeCursor = (row: (typeof rows)[0]) =>
    `${row.referenceCode}|${row.id}`;

  return {
    view: "columns" as const,
    items: rows as DescriptionRow[],
    nextCursor: hasMore ? makeCursor(rows[rows.length - 1]) : null,
    prevCursor: cursor && rows.length > 0 ? makeCursor(rows[0]) : null,
    total: rows.length,
    query: search,
    filters: { level: validLevel, repoId: validRepoId, hasDigital: hasDigitalFilter },
    repositories: allRepos,
  };
}

// ---------------------------------------------------------------------------
// Description level badge styles
// ---------------------------------------------------------------------------

const LEVEL_BADGE_STYLES: Record<string, string> = {
  fonds: "bg-indigo-tint text-indigo",
  subfonds: "bg-verdigris-tint text-verdigris",
  collection: "bg-verdigris-tint text-verdigris",
  series: "bg-indigo-tint text-indigo",
  subseries: "bg-indigo-tint text-indigo",
  section: "bg-saffron-tint text-saffron-deep",
  volume: "bg-saffron-tint text-saffron-deep",
  file: "bg-stone-200 text-stone-700",
  item: "bg-stone-200 text-stone-700",
};

// ---------------------------------------------------------------------------
// Action — tree actions (reorder, move, delete)
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, asc, sql } = await import("drizzle-orm");
  const { descriptions } = await import("~/db/schema");
  const { isValidChildLevel } = await import("~/lib/description-levels");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    // -----------------------------------------------------------------
    // Reorder siblings
    // -----------------------------------------------------------------
    case "reorder": {
      const descriptionId = formData.get("descriptionId") as string;
      const direction = formData.get("direction") as string;

      if (!descriptionId || !["up", "down"].includes(direction)) {
        return Response.json({ ok: false, error: "invalid_direction" });
      }

      const desc = await db
        .select({
          id: descriptions.id,
          parentId: descriptions.parentId,
          position: descriptions.position,
          depth: descriptions.depth,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, descriptionId)
          )
        )
        .get();

      if (!desc) {
        return Response.json({ ok: false, error: "not_found" });
      }

      // Fetch siblings ordered by position
      const siblings = desc.parentId
        ? await db
            .select({ id: descriptions.id, position: descriptions.position })
            .from(descriptions)
            .where(
              and(
                eq(descriptions.tenantId, tenant.id),
                eq(descriptions.parentId, desc.parentId)
              )
            )
            .orderBy(asc(descriptions.position))
            .all()
        : await db
            .select({ id: descriptions.id, position: descriptions.position })
            .from(descriptions)
            .where(
              and(
                eq(descriptions.tenantId, tenant.id),
                eq(descriptions.depth, 0)
              )
            )
            .orderBy(asc(descriptions.position))
            .all();

      const currentIdx = siblings.findIndex((s) => s.id === descriptionId);
      const targetIdx =
        direction === "up" ? currentIdx - 1 : currentIdx + 1;

      if (targetIdx < 0 || targetIdx >= siblings.length) {
        return Response.json({ ok: false, error: "no_sibling" });
      }

      const current = siblings[currentIdx];
      const target = siblings[targetIdx];

      // Swap position values
      await db
        .update(descriptions)
        .set({ position: target.position })
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, current.id)
          )
        );
      await db
        .update(descriptions)
        .set({ position: current.position })
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, target.id)
          )
        );

      return Response.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // Move to new parent
    // -----------------------------------------------------------------
    case "move": {
      const descriptionId = formData.get("descriptionId") as string;
      const newParentId = formData.get("newParentId") as string;

      if (!descriptionId || !newParentId) {
        return Response.json({ ok: false, error: "missing_fields" });
      }

      // Cannot move to self
      if (descriptionId === newParentId) {
        return Response.json({ ok: false, error: "self_move" });
      }

      const desc = await db
        .select()
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, descriptionId)
          )
        )
        .get();
      if (!desc) {
        return Response.json({ ok: false, error: "not_found" });
      }

      const newParent = await db
        .select()
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, newParentId)
          )
        )
        .get();
      if (!newParent) {
        return Response.json({ ok: false, error: "parent_not_found" });
      }

      // Validate not moving to a descendant (walk up from newParent)
      let checkId: string | null = newParent.parentId;
      let depth = 0;
      while (checkId && depth < 20) {
        if (checkId === descriptionId) {
          return Response.json({ ok: false, error: "descendant_move" });
        }
        const ancestor = await db
          .select({ parentId: descriptions.parentId })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, checkId)
            )
          )
          .get();
        checkId = ancestor?.parentId ?? null;
        depth++;
      }

      // Validate level constraint
      if (!isValidChildLevel(newParent.descriptionLevel, desc.descriptionLevel)) {
        return Response.json({ ok: false, error: "invalid_level" });
      }

      const oldParentId = desc.parentId;
      const newDepth = newParent.depth + 1;
      const depthShift = newDepth - desc.depth;
      const newRootId = newParent.rootDescriptionId || newParent.id;

      // Count new parent's current children to get position
      const newSiblings = await db
        .select({ id: descriptions.id })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.parentId, newParentId)
          )
        )
        .all();
      const newPosition = newSiblings.length;

      // Update the moved description
      await db
        .update(descriptions)
        .set({
          parentId: newParentId,
          rootDescriptionId: newRootId,
          depth: newDepth,
          position: newPosition,
          pathCache: newParent.pathCache
            ? `${newParent.pathCache}/${desc.id}`
            : desc.id,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, descriptionId)
          )
        );

      // Update descendants: rootDescriptionId and depth via recursive CTE
      if (desc.childCount > 0) {
        await db.run(sql`
          WITH RECURSIVE subtree AS (
            SELECT id, depth FROM descriptions WHERE parent_id = ${descriptionId}
            UNION ALL
            SELECT d.id, d.depth FROM descriptions d JOIN subtree s ON d.parent_id = s.id
          )
          UPDATE descriptions SET
            root_description_id = ${newRootId},
            depth = depth + ${depthShift}
          WHERE id IN (SELECT id FROM subtree)
        `);
      }

      // Decrement old parent's childCount
      if (oldParentId) {
        const oldParent = await db
          .select({ childCount: descriptions.childCount })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, oldParentId)
            )
          )
          .get();
        if (oldParent) {
          await db
            .update(descriptions)
            .set({ childCount: Math.max(0, oldParent.childCount - 1) })
            .where(
              and(
                eq(descriptions.tenantId, tenant.id),
                eq(descriptions.id, oldParentId)
              )
            );
        }
      }

      // Increment new parent's childCount
      await db
        .update(descriptions)
        .set({ childCount: newParent.childCount + 1 })
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, newParentId)
          )
        );

      return Response.json({ ok: true });
    }

    // -----------------------------------------------------------------
    // Delete from tree
    // -----------------------------------------------------------------
    case "delete": {
      const descriptionId = formData.get("descriptionId") as string;
      if (!descriptionId) {
        return Response.json({ ok: false, error: "missing_fields" });
      }

      const desc = await db
        .select({
          childCount: descriptions.childCount,
          parentId: descriptions.parentId,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, descriptionId)
          )
        )
        .get();

      if (!desc) {
        return Response.json({ ok: false, error: "not_found" });
      }

      if (desc.childCount > 0) {
        return Response.json({
          ok: false,
          error: "delete_blocked",
          count: desc.childCount,
        });
      }

      // Delete (entity/place links cascade per schema)
      await db
        .delete(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, descriptionId)
          )
        );

      // Decrement parent's childCount
      if (desc.parentId) {
        const parent = await db
          .select({ childCount: descriptions.childCount })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, desc.parentId)
            )
          )
          .get();
        if (parent) {
          await db
            .update(descriptions)
            .set({ childCount: Math.max(0, parent.childCount - 1) })
            .where(
              and(
                eq(descriptions.tenantId, tenant.id),
                eq(descriptions.id, desc.parentId)
              )
            );
        }
      }

      return Response.json({ ok: true });
    }

    default:
      return Response.json({ ok: false, error: "unknown_action" });
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminDescriptionsPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("descriptions_admin");
  const [selectedItem, setSelectedItem] = useState<TreeItem | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const activeView = (loaderData as any).view || "tree";

  const handleSelectItem = useCallback((item: TreeItem | null) => {
    setSelectedItem(item);
  }, []);

  const switchView = useCallback(
    (view: string) => {
      const params = new URLSearchParams();
      if (view !== "tree") {
        params.set("view", view);
      }
      setSearchParams(params);
    },
    [setSearchParams]
  );

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-semibold text-stone-700">
          {t("page_title")}
        </h1>
        <Link
          to="/admin/descriptions/new"
          className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          <Plus className="h-4 w-4" />
          {t("new_description")}
        </Link>
      </div>

      {/* View toggle tabs */}
      <div className="mt-6 flex gap-6 border-b border-stone-200">
        <button
          type="button"
          onClick={() => switchView("tree")}
          className={`pb-3 text-sm font-semibold ${
            activeView === "tree"
              ? "border-b-2 border-indigo-deep text-indigo-deep"
              : "text-stone-500 hover:text-stone-700"
          }`}
        >
          {t("view_tree")}
        </button>
        <button
          type="button"
          onClick={() => switchView("columns")}
          className={`pb-3 text-sm font-semibold ${
            activeView === "columns"
              ? "border-b-2 border-indigo-deep text-indigo-deep"
              : "text-stone-500 hover:text-stone-700"
          }`}
        >
          {t("view_columns")}
        </button>
      </div>

      {/* View content */}
      {activeView === "tree" ? (
        <TreeView
          selectedItem={selectedItem}
          onSelectItem={handleSelectItem}
        />
      ) : (
        <ColumnView loaderData={loaderData as any} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree View (existing MillerColumns)
// ---------------------------------------------------------------------------

function TreeView({
  selectedItem,
  onSelectItem,
}: {
  selectedItem: TreeItem | null;
  onSelectItem: (item: TreeItem | null) => void;
}) {
  const fetcher = useFetcher();

  return (
    <>
      <div className="mt-6">
        <MillerColumns onSelectItem={onSelectItem} />
      </div>
      <MetadataPreview
        item={selectedItem}
        fetcher={fetcher}
        onItemDeleted={() => onSelectItem(null)}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Column View (DataTable with FTS5 search)
// ---------------------------------------------------------------------------

function ColumnView({ loaderData }: { loaderData: any }) {
  const { t } = useTranslation("descriptions_admin");
  const [searchParams] = useSearchParams();

  // Table ref for ColumnToggle
  const tableRef = useRef<Table<DescriptionRow> | null>(null);
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    forceUpdate((n) => n + 1);
  }, []);

  // Search state with debounce
  const [searchInput, setSearchInput] = useState(loaderData.query || "");
  const [debouncedSearch, setDebouncedSearch] = useState(loaderData.query || "");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Navigate on debounced search change
  useEffect(() => {
    if (debouncedSearch !== (loaderData.query || "")) {
      const params = new URLSearchParams(searchParams);
      params.set("view", "columns");
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

  // Column definitions
  const columns = useMemo<ColumnDef<DescriptionRow, unknown>[]>(
    () => [
      {
        accessorKey: "referenceCode",
        header: t("col_reference_code"),
        enableHiding: false,
        cell: ({ row }) => (
          <Link
            to={`/admin/descriptions/${row.original.id}`}
            className="font-mono text-sm font-semibold text-indigo-deep hover:underline"
          >
            {row.original.referenceCode}
          </Link>
        ),
      },
      {
        accessorKey: "title",
        header: t("col_title"),
        enableHiding: false,
        cell: ({ row }) => {
          const title = row.original.title;
          return title.length > 80 ? `${title.slice(0, 80)}...` : title;
        },
      },
      {
        accessorKey: "descriptionLevel",
        header: t("col_level"),
        cell: ({ row }) => {
          const level = row.original.descriptionLevel;
          const style = LEVEL_BADGE_STYLES[level] || "bg-stone-100 text-stone-600";
          const label = t(`level_${level}`, { defaultValue: level });
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
        accessorKey: "repositoryName",
        header: t("col_repository"),
        cell: ({ row }) => row.original.repositoryName || "\u2014",
      },
      {
        accessorKey: "hasDigital",
        header: t("col_has_digital"),
        cell: ({ row }) =>
          row.original.hasDigital ? (
            <Check className="h-3.5 w-3.5 text-verdigris" />
          ) : (
            <span className="text-stone-400">{"\u2014"}</span>
          ),
      },
      {
        accessorKey: "parentReferenceCode",
        header: t("col_parent_code"),
        enableHiding: true,
        cell: ({ row }) =>
          row.original.parentReferenceCode ? (
            <span className="font-mono text-xs text-stone-500">
              {row.original.parentReferenceCode}
            </span>
          ) : (
            <span className="text-stone-400">{"\u2014"}</span>
          ),
      },
    ],
    [t]
  );

  const defaultColumnVisibility = useMemo(
    () => ({
      parentReferenceCode: false,
    }),
    []
  );

  const table = tableRef.current;

  return (
    <div className="mt-6">
      {/* Toolbar */}
      <div className="mb-4 rounded-lg border border-stone-200 p-4">
        {/* Row 1: Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("search_descriptions")}
            aria-label={t("search_descriptions")}
            className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
        </div>

        {/* Row 2: Filters */}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {/* Level filter */}
          <select
            value={searchParams.get("level") || ""}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              params.set("view", "columns");
              if (e.target.value) {
                params.set("level", e.target.value);
              } else {
                params.delete("level");
              }
              params.delete("cursor");
              params.delete("dir");
              window.location.search = params.toString();
            }}
            className="rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{t("filter_level")}</option>
            {DESCRIPTION_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(`level_${level}`, { defaultValue: level })}
              </option>
            ))}
          </select>

          {/* Repository filter */}
          <select
            value={searchParams.get("repoId") || ""}
            onChange={(e) => {
              const params = new URLSearchParams(searchParams);
              params.set("view", "columns");
              if (e.target.value) {
                params.set("repoId", e.target.value);
              } else {
                params.delete("repoId");
              }
              params.delete("cursor");
              params.delete("dir");
              window.location.search = params.toString();
            }}
            className="max-w-xs rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{t("filter_repository")}</option>
            {(loaderData.repositories || []).map((repo: Repository) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>

          {/* Has digital object checkbox */}
          <label className="flex items-center gap-2 whitespace-nowrap text-sm font-medium text-indigo">
            <input
              type="checkbox"
              checked={searchParams.get("hasDigital") === "true"}
              onChange={(e) => {
                const params = new URLSearchParams(searchParams);
                params.set("view", "columns");
                if (e.target.checked) {
                  params.set("hasDigital", "true");
                } else {
                  params.delete("hasDigital");
                }
                params.delete("cursor");
                params.delete("dir");
                window.location.search = params.toString();
              }}
              className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
            />
            {t("filter_has_digital")}
          </label>

          {/* Spacer + Column toggle */}
          <div className="ml-auto">
            {table && <ColumnToggle table={table} label={t("col_toggle")} />}
          </div>
        </div>
      </div>

      {/* Data table */}
      {loaderData.items.length === 0 ? (
        <div className="rounded-lg border border-stone-200 py-12 text-center">
          <p className="font-sans text-sm text-stone-500">
            {t("no_results")}
          </p>
        </div>
      ) : (
        <>
          <DataTable
            data={loaderData.items}
            columns={columns}
            defaultColumnVisibility={defaultColumnVisibility}
            defaultSorting={[{ id: "referenceCode", desc: false }]}
            emptyMessage={t("no_results")}
            tableRef={tableRef}
          />
          <CursorPagination
            nextCursor={loaderData.nextCursor}
            prevCursor={loaderData.prevCursor}
            count={loaderData.total}
            entityLabel={t("page_title").toLowerCase()}
          />
        </>
      )}
    </div>
  );
}
