/**
 * Vocabularies — Functions List
 *
 * This page is the index of the function-style vocabulary terms — typically archival
 * activities like "correspondence" or "accounting" — with bulk
 * actions for approve, reject, and merge. Each row deep-links to the
 * per-function detail page.
 *
 * @version v0.3.0
 */

import { useState, useEffect, useMemo } from "react";
import { Link, useSearchParams, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Search, Plus, MoreVertical } from "lucide-react";
import { userContext } from "../context";
import { FUNCTION_CATEGORIES } from "~/lib/validation/enums";
import { CategoryFilterChips } from "~/components/admin/category-filter-chips";
import { VocabularyStatusBadge } from "~/components/admin/vocabulary-status-badge";
import { escapeLike } from "~/lib/sql-utils";
import type { Route } from "./+types/_auth.admin.vocabularies.functions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VocabTerm {
  id: string;
  canonical: string;
  category: string | null;
  status: "approved" | "proposed" | "deprecated";
  entityCount: number;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, like, isNull, asc, desc, sql } = await import(
    "drizzle-orm"
  );
  const { vocabularyTerms } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);

  // JSON search API for merge dialog
  if (url.searchParams.get("intent") === "search-terms") {
    const q = url.searchParams.get("q")?.trim() || "";
    const excludeId = url.searchParams.get("exclude") || "";
    const conditions = [
      like(vocabularyTerms.canonical, `%${escapeLike(q)}%`),
      isNull(vocabularyTerms.mergedInto),
      eq(vocabularyTerms.status, "approved"),
    ];
    if (excludeId) {
      conditions.push(sql`${vocabularyTerms.id} != ${excludeId}`);
    }
    const results = await db
      .select({
        id: vocabularyTerms.id,
        displayName: vocabularyTerms.canonical,
        code: vocabularyTerms.category,
      })
      .from(vocabularyTerms)
      .where(and(...conditions))
      .limit(10)
      .all();
    return Response.json(results);
  }

  // Parse URL params
  const q = url.searchParams.get("q")?.trim() || "";
  const category = url.searchParams.get("category") || null;
  const status = url.searchParams.get("status") || "approved";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const sort = url.searchParams.get("sort") || "entityCount";
  const dir = url.searchParams.get("dir") || "desc";
  const pageSize = 50;

  // Build conditions
  const conditions = [isNull(vocabularyTerms.mergedInto)];

  if (status && status !== "all") {
    conditions.push(eq(vocabularyTerms.status, status as "approved" | "proposed" | "deprecated"));
  }
  if (category) {
    conditions.push(eq(vocabularyTerms.category, category));
  }
  if (q) {
    conditions.push(
      sql`lower(${vocabularyTerms.canonical}) LIKE lower(${"%" + escapeLike(q) + "%"})`
    );
  }

  // Build order
  const sortColumn =
    sort === "canonical"
      ? vocabularyTerms.canonical
      : sort === "category"
        ? vocabularyTerms.category
        : vocabularyTerms.entityCount;

  const orderFn = dir === "asc" ? asc : desc;

  // Count total
  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(vocabularyTerms)
    .where(and(...conditions))
    .all();
  const total = countResult[0]?.count ?? 0;

  // Fetch page
  const terms = (await db
    .select()
    .from(vocabularyTerms)
    .where(and(...conditions))
    .orderBy(orderFn(sortColumn), asc(vocabularyTerms.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()) as VocabTerm[];

  return { terms, total, page, pageSize, category, status, q, sort, dir };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql } = await import("drizzle-orm");
  const { vocabularyTerms, changelog } = await import("~/db/schema");
  const { vocabularyTermSchema } = await import(
    "~/lib/validation/vocabulary"
  );

  const user = context.get(userContext);
  requireAdmin(user);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const now = Math.floor(Date.now() / 1000);

  if (intent === "add-function") {
    const canonical = (formData.get("canonical") as string)?.trim();
    const parsed = vocabularyTermSchema.safeParse({
      canonical,
      status: "approved",
    });
    if (!parsed.success) {
      return { error: "Invalid input" };
    }
    const id = crypto.randomUUID();
    await db.insert(vocabularyTerms).values({
      id,
      canonical: parsed.data.canonical,
      category: parsed.data.category ?? null,
      status: "approved",
      entityCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Created function: ${parsed.data.canonical}`,
      diff: JSON.stringify({ canonical: { old: null, new: parsed.data.canonical } }),
      createdAt: now,
    });
    return { success: true };
  }

  if (intent === "rename") {
    const termId = formData.get("termId") as string;
    const newName = (formData.get("canonical") as string)?.trim();
    if (!termId || !newName) return { error: "Missing fields" };

    const parsed = vocabularyTermSchema.safeParse({ canonical: newName });
    if (!parsed.success) return { error: "Invalid name" };

    const existing = await db
      .select({ canonical: vocabularyTerms.canonical })
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, termId))
      .get();
    if (!existing) return { error: "Term not found" };

    await db
      .update(vocabularyTerms)
      .set({ canonical: parsed.data.canonical, updatedAt: now })
      .where(eq(vocabularyTerms.id, termId));

    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: termId,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Renamed: ${existing.canonical} → ${parsed.data.canonical}`,
      diff: JSON.stringify({
        canonical: { old: existing.canonical, new: parsed.data.canonical },
      }),
      createdAt: now,
    });
    return { success: true };
  }

  if (intent === "deprecate") {
    const termId = formData.get("termId") as string;
    if (!termId) return { error: "Missing term ID" };

    const existing = await db
      .select({ canonical: vocabularyTerms.canonical, status: vocabularyTerms.status })
      .from(vocabularyTerms)
      .where(eq(vocabularyTerms.id, termId))
      .get();
    if (!existing) return { error: "Term not found" };

    await db
      .update(vocabularyTerms)
      .set({ status: "deprecated", updatedAt: now })
      .where(eq(vocabularyTerms.id, termId));

    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: termId,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Deprecated: ${existing.canonical}`,
      diff: JSON.stringify({
        status: { old: existing.status, new: "deprecated" },
      }),
      createdAt: now,
    });
    return { success: true };
  }

  return { error: "Unknown intent" };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminVocabularyFunctionsPage({
  loaderData,
}: Route.ComponentProps) {
  const data = loaderData;
  const { t } = useTranslation("vocabularies");
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();

  // Search input with debounce
  const [searchInput, setSearchInput] = useState(data.q || "");
  const [debouncedSearch, setDebouncedSearch] = useState(data.q || "");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (debouncedSearch !== (data.q || "")) {
      const params = new URLSearchParams(searchParams);
      if (debouncedSearch) {
        params.set("q", debouncedSearch);
      } else {
        params.delete("q");
      }
      params.delete("page");
      setSearchParams(params, { replace: true });
    }
  }, [debouncedSearch]);

  // Add function form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newFunctionName, setNewFunctionName] = useState("");

  // Kebab menu state
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  function handleCategoryChange(cat: string | null) {
    const params = new URLSearchParams(searchParams);
    if (cat) {
      params.set("category", cat);
    } else {
      params.delete("category");
    }
    params.delete("page");
    setSearchParams(params, { replace: true });
  }

  function handleStatusChange(status: string) {
    const params = new URLSearchParams(searchParams);
    params.set("status", status);
    params.delete("page");
    setSearchParams(params, { replace: true });
  }

  function handleSort(column: string) {
    const params = new URLSearchParams(searchParams);
    const currentSort = params.get("sort") || "entityCount";
    const currentDir = params.get("dir") || "desc";
    if (currentSort === column) {
      params.set("dir", currentDir === "asc" ? "desc" : "asc");
    } else {
      params.set("sort", column);
      params.set("dir", column === "canonical" ? "asc" : "desc");
    }
    params.delete("page");
    setSearchParams(params, { replace: true });
  }

  function handlePageChange(page: number) {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(page));
    setSearchParams(params, { replace: true });
  }

  const currentSort = data.sort || "entityCount";
  const currentDir = data.dir || "desc";
  const statusFilter = data.status || "approved";
  const totalPages = Math.ceil(data.total / data.pageSize);

  const statusOptions = ["all", "approved", "proposed", "deprecated"];

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-stone-500">
        <Link to="/admin/vocabularies" className="hover:underline">
          {t("page_title")}
        </Link>
        <span className="mx-1">/</span>
        <span className="text-stone-700">{t("vocab_primary_functions")}</span>
      </nav>

      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-lg font-semibold text-stone-700">
          {t("vocab_primary_functions")}
        </h1>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          <Plus className="h-4 w-4" />
          {t("add_function")}
        </button>
      </div>

      {/* Add function inline form */}
      {showAddForm && (
        <fetcher.Form method="post" className="mt-4 flex items-center gap-2">
          <input type="hidden" name="intent" value="add-function" />
          <input
            type="text"
            name="canonical"
            value={newFunctionName}
            onChange={(e) => setNewFunctionName(e.target.value)}
            placeholder={t("col_function")}
            className="flex-1 rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            required
          />
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("add_function")}
          </button>
        </fetcher.Form>
      )}

      {/* Toolbar */}
      <div className="mt-6 space-y-3">
        {/* Search */}
        <div className="relative">
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

        {/* Category filter chips */}
        <CategoryFilterChips
          categories={FUNCTION_CATEGORIES}
          selected={data.category}
          onChange={handleCategoryChange}
          t={t}
        />

        {/* Status filter buttons */}
        <div className="flex gap-1">
          {statusOptions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleStatusChange(s)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                statusFilter === s
                  ? "bg-stone-700 text-white"
                  : "bg-stone-50 text-stone-500 hover:bg-stone-100"
              }`}
            >
              {s === "all"
                ? t("all_filter")
                : t(`status_${s}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Data table */}
      {data.terms.length === 0 ? (
        <div className="mt-8 rounded-lg border border-stone-200 p-8 text-center">
          <h2 className="font-sans text-lg font-semibold text-stone-700">
            {t("no_functions_found")}
          </h2>
          <p className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto">
            {t("no_functions_body")}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-stone-200">
          <div className="overflow-x-auto">
            <table className="min-w-full">
              <thead className="bg-stone-50">
                <tr>
                  <th
                    className="px-4 py-3 text-left text-xs font-normal uppercase tracking-wide text-stone-500"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort("canonical")}
                      className="inline-flex items-center"
                    >
                      {t("col_function")}
                      <SortIndicator column="canonical" current={currentSort} dir={currentDir} />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
                    {t("col_category")}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-normal uppercase tracking-wide text-stone-500">
                    <button
                      type="button"
                      onClick={() => handleSort("entityCount")}
                      className="inline-flex items-center"
                    >
                      {t("col_usage")}
                      <SortIndicator column="entityCount" current={currentSort} dir={currentDir} />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-normal uppercase tracking-wide text-stone-500">
                    {t("col_status")}
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-normal uppercase tracking-wide text-stone-500">
                    {t("col_actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.terms.map((term) => (
                  <tr
                    key={term.id}
                    className={`border-t border-stone-200 hover:bg-stone-50 ${
                      term.status === "proposed" ? "border-l-2 border-l-saffron" : ""
                    }`}
                  >
                    <td className="px-4 py-3 text-sm">
                      {renamingId === term.id ? (
                        <fetcher.Form
                          method="post"
                          className="flex items-center gap-2"
                          onSubmit={() => setRenamingId(null)}
                        >
                          <input type="hidden" name="intent" value="rename" />
                          <input type="hidden" name="termId" value={term.id} />
                          <input
                            type="text"
                            name="canonical"
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            className="rounded border border-stone-200 px-2 py-1 text-sm focus:border-indigo focus:outline-none"
                            onKeyDown={(e) => {
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            autoFocus
                          />
                          <button
                            type="submit"
                            className="rounded bg-indigo px-2 py-1 text-xs text-parchment"
                          >
                            {t("save_term")}
                          </button>
                        </fetcher.Form>
                      ) : (
                        <Link
                          to={`/admin/vocabularies/functions/${term.id}`}
                          className="font-semibold text-indigo-deep hover:underline"
                        >
                          {term.canonical}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-stone-500">
                      {term.category ? (
                        <span className="inline-block rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs">
                          {t(`cat_${term.category}`)}
                        </span>
                      ) : (
                        "\u2014"
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm tabular-nums text-stone-700">
                      {term.entityCount}
                    </td>
                    <td className="px-4 py-3">
                      <VocabularyStatusBadge status={term.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="relative inline-block">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenMenu(openMenu === term.id ? null : term.id)
                          }
                          className="rounded p-1 text-stone-500 hover:bg-stone-100"
                          aria-label={t("col_actions")}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {openMenu === term.id && (
                          <div className="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingId(term.id);
                                setRenameValue(term.canonical);
                                setOpenMenu(null);
                              }}
                              className="w-full px-4 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                            >
                              {t("rename_term")}
                            </button>
                            <Link
                              to={`/admin/vocabularies/functions/${term.id}?action=merge`}
                              className="block w-full px-4 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
                              onClick={() => setOpenMenu(null)}
                            >
                              {t("merge_into")}
                            </Link>
                            <fetcher.Form method="post">
                              <input type="hidden" name="intent" value="deprecate" />
                              <input type="hidden" name="termId" value={term.id} />
                              <button
                                type="submit"
                                className="w-full px-4 py-2 text-left text-sm text-madder-deep hover:bg-stone-50"
                                onClick={() => setOpenMenu(null)}
                              >
                                {t("deprecate_term")}
                              </button>
                            </fetcher.Form>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination footer */}
          <div className="flex items-center justify-between border-t border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-500">
            <span>
              {t("n_terms", { count: data.total })}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => handlePageChange(data.page - 1)}
                className="rounded-lg border border-stone-200 px-3 py-1 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="flex items-center px-2 text-sm">
                {data.page} / {totalPages}
              </span>
              <button
                type="button"
                disabled={data.page >= totalPages}
                onClick={() => handlePageChange(data.page + 1)}
                className="rounded-lg border border-stone-200 px-3 py-1 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SortIndicator({
  column,
  current,
  dir,
}: {
  column: string;
  current: string;
  dir: string;
}) {
  if (current !== column) {
    return <span className="ml-1 text-stone-400">&uarr;&darr;</span>;
  }
  return (
    <span className="ml-1 text-indigo">{dir === "asc" ? "\u2191" : "\u2193"}</span>
  );
}
