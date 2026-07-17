/**
 * Repositories Admin — List
 *
 * This page is the index for the repositories admin surface. It renders a searchable
 * data table of every archival institution the app holds records for --
 * short code, full name, city, country, and enabled flag -- with a "New
 * repository" button that jumps to the create form. The data table
 * component handles column toggles, client-side filtering, and sort so
 * that curators working with a few dozen repositories can find a
 * specific one quickly without a round-trip.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`; the loader filters `repositories` by
 * `tenant.id`.
 *
 * Creating a repository is gated by capability, not visibility: allowed
 * when the tenant has `multiRepositoryEnabled` OR currently has ZERO
 * repositories (the first-repository case). Otherwise the "add" button
 * gives way to a teaching note — the /new route refuses server-side too,
 * so a direct URL cannot bypass.
 *
 * @version v0.6.0
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, Plus } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DataTable } from "~/components/data-table/data-table";
import { ColumnToggle } from "~/components/data-table/column-toggle";
import type {
  ColumnDef,
  Table,
  ColumnFiltersState,
} from "~/components/data-table/data-table";
import type { Route } from "./+types/_auth.admin.repositories";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Repository {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  countryCode: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  notes: string | null;
  enabled: boolean | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { repositories } = await import("~/db/schema");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const allRepos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.tenantId, tenant.id))
    .orderBy(repositories.name)
    .all();

  // Create is capability-gated at the OPERATION: multi-repository tenants
  // always may; a single-repository tenant only while it has none (the
  // first-repository case). The /new route enforces the same rule.
  const canCreate = tenant.multiRepositoryEnabled || allRepos.length === 0;

  return { repositories: allRepos, canCreate };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminRepositoriesPage({
  loaderData,
}: Route.ComponentProps) {
  const { repositories, canCreate } = loaderData;
  const { t } = useTranslation("repositories");

  // Table ref for accessing the TanStack Table instance
  const tableRef = useRef<Table<Repository> | null>(null);

  // Force re-render after table is available for toolbar controls
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    // After first render, table ref will be populated
    forceUpdate((n) => n + 1);
  }, []);

  // Search state with debounce
  const [searchInput, setSearchInput] = useState("");
  const [globalFilter, setGlobalFilter] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setGlobalFilter(searchInput);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Enabled filter state
  const [enabledFilter, setEnabledFilter] = useState<string>("enabled");

  // Column definitions
  const columns = useMemo<ColumnDef<Repository, unknown>[]>(
    () => [
      {
        accessorKey: "code",
        header: t("field.code"),
        enableHiding: false,
        cell: ({ row }) => (
          <Link
            to={`/admin/repositories/${row.original.id}`}
            className="font-semibold text-indigo-deep hover:underline"
          >
            {row.getValue("code") as string}
          </Link>
        ),
      },
      {
        accessorKey: "name",
        header: t("field.name"),
        enableHiding: false,
      },
      {
        accessorKey: "city",
        header: t("field.city"),
        cell: ({ row }) => (row.getValue("city") as string) || "\u2014",
      },
      {
        accessorKey: "countryCode",
        header: t("field.countryCode"),
      },
      {
        accessorKey: "enabled",
        header: t("field.enabled"),
        enableHiding: false,
        cell: ({ row }) => {
          const enabled = row.getValue("enabled") as boolean;
          return enabled ? (
            <span className="inline-block rounded-full bg-verdigris-tint px-2 py-0.5 text-xs font-medium text-verdigris">
              {t("badge_enabled")}
            </span>
          ) : (
            <span className="inline-block rounded-full bg-indigo-tint px-2 py-0.5 text-xs font-medium text-indigo">
              {t("badge_disabled")}
            </span>
          );
        },
        filterFn: (row, id, value) => {
          if (value === "all") return true;
          if (value === "enabled") return row.getValue(id) === true;
          if (value === "disabled") return row.getValue(id) === false;
          return true;
        },
      },
      {
        accessorKey: "shortName",
        header: t("field.shortName"),
        enableHiding: true,
      },
      {
        accessorKey: "address",
        header: t("field.address"),
        enableHiding: true,
        enableSorting: false,
      },
      {
        accessorKey: "website",
        header: t("field.website"),
        enableHiding: true,
        enableSorting: false,
        cell: ({ row }) => {
          const url = row.getValue("website") as string | null;
          if (!url) return "\u2014";
          return (
            <a
              href={url}
              target="_blank"
              rel="noopener"
              className="text-indigo-deep hover:underline"
            >
              {url}
            </a>
          );
        },
      },
      {
        accessorKey: "notes",
        header: t("field.notes"),
        enableHiding: true,
        enableSorting: false,
        cell: ({ row }) => {
          const notes = row.getValue("notes") as string | null;
          if (!notes) return "\u2014";
          return notes.length > 80 ? `${notes.slice(0, 80)}...` : notes;
        },
      },
    ],
    [t]
  );

  // Default column visibility: hide optional columns
  const defaultColumnVisibility = useMemo(
    () => ({
      shortName: false,
      address: false,
      website: false,
      notes: false,
    }),
    []
  );

  // Default column filter for enabled
  const defaultColumnFilters = useMemo<ColumnFiltersState>(
    () => [{ id: "enabled", value: "enabled" }],
    []
  );

  // Empty state when no repositories at all
  if (repositories.length === 0) {
    return (
      <div className="mx-auto max-w-7xl px-8 py-12">
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-4xl font-semibold text-stone-700">
            {t("title")}
          </h1>
          <Link
            to="/admin/repositories/new"
            className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            <Plus className="h-4 w-4" />
            {t("add")}
          </Link>
        </div>
        <div className="mt-12 text-center">
          <h2 className="font-sans text-lg font-semibold text-stone-700">
            {t("empty_title")}
          </h2>
          <p className="mt-2 font-sans text-sm text-stone-500">
            {t("empty_body")}
          </p>
          <Link
            to="/admin/repositories/new"
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            <Plus className="h-4 w-4" />
            {t("add")}
          </Link>
        </div>
      </div>
    );
  }

  const table = tableRef.current;

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-semibold text-stone-700">
          {t("title")}
        </h1>
        {canCreate ? (
          <Link
            to="/admin/repositories/new"
            className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            <Plus className="h-4 w-4" />
            {t("add")}
          </Link>
        ) : (
          <p className="max-w-md text-right text-xs text-stone-500">
            {t("single_repo_note")}
          </p>
        )}
      </div>

      {/* Toolbar */}
      <div className="mb-4 mt-6 flex items-center gap-3 rounded-lg border border-stone-200 p-4">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("search_placeholder")}
            aria-label={t("search_placeholder")}
            className="w-full rounded-lg border border-stone-200 py-2 pl-9 pr-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
        </div>

        {/* Enabled filter */}
        <select
          value={enabledFilter}
          onChange={(e) => {
            setEnabledFilter(e.target.value);
            table?.getColumn("enabled")?.setFilterValue(e.target.value);
          }}
          className="rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        >
          <option value="enabled">{t("filter_enabled")}</option>
          <option value="disabled">{t("filter_disabled")}</option>
          <option value="all">{t("filter_all")}</option>
        </select>

        {/* Column toggle */}
        {table && (
          <ColumnToggle table={table} label={t("columns_label")} />
        )}
      </div>

      {/* Data table */}
      <DataTable
        data={repositories}
        columns={columns}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        defaultColumnVisibility={defaultColumnVisibility}
        defaultSorting={[{ id: "name", desc: false }]}
        defaultColumnFilters={defaultColumnFilters}
        emptyMessage={t("empty_title")}
        tableRef={tableRef}
        renderFooter={(tbl) => {
          const filteredCount = tbl.getFilteredRowModel().rows.length;
          const totalCount = repositories.length;
          return (
            <div className="border-t border-stone-200 bg-stone-50 px-4 py-3 font-sans text-sm text-stone-500">
              {t("results_count", {
                count: filteredCount,
                total: totalCount,
              })}
            </div>
          );
        }}
      />
    </div>
  );
}
