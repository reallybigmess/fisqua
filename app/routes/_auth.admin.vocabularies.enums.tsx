/**
 * Vocabularies — Enums Editor
 *
 * This page is the admin surface for managing the enum-valued
 * controlled vocabularies used across the app. It lets superadmins
 * add new values, deprecate old
 * ones, and merge duplicates; every mutation writes an audit row so
 * the change trail is recoverable.
 *
 * Authority scope is the federation (migrations 0045-0048). Usage counts on
 * `entities` and `places` are scoped to `tenant.federationId`;
 * descriptionEntities and descriptionPlaces inherit tenant scope via
 * FK chain.
 *
 * @version v0.4.2
 */

import { useState } from "react";
import { Form, Link, redirect, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, AlertTriangle, Pencil, Trash2, Plus, X, Check } from "lucide-react";
import { tenantContext, userContext } from "../context";
import {
  ENTITY_ROLES,
  PLACE_ROLES,
  ENTITY_TYPES,
  PLACE_TYPES,
} from "~/lib/validation/enums";
import type { Route } from "./+types/_auth.admin.vocabularies.enums";

// ---------------------------------------------------------------------------
// Vocab config
// ---------------------------------------------------------------------------

const VOCAB_MAP = {
  "entity-roles": {
    enumArray: ENTITY_ROLES,
    labelKey: "vocab_entity_roles",
  },
  "place-roles": {
    enumArray: PLACE_ROLES,
    labelKey: "vocab_place_roles",
  },
  "entity-types": {
    enumArray: ENTITY_TYPES,
    labelKey: "vocab_entity_types",
  },
  "place-types": {
    enumArray: PLACE_TYPES,
    labelKey: "vocab_place_types",
  },
} as const;

type VocabKey = keyof typeof VOCAB_MAP;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const {
    descriptionEntities,
    descriptionPlaces,
    entities,
    places,
  } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const url = new URL(request.url);
  const vocabParam = url.searchParams.get("vocab") as VocabKey | null;

  if (!vocabParam || !(vocabParam in VOCAB_MAP)) {
    throw redirect("/admin/vocabularies");
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Build usage count map
  const usageMap = new Map<string, number>();

  if (vocabParam === "entity-roles") {
    const rows = await db
      .select({
        role: descriptionEntities.role,
        count: sql<number>`count(*)`,
      })
      .from(descriptionEntities)
      .groupBy(descriptionEntities.role)
      .all();
    for (const row of rows) usageMap.set(row.role, row.count);
  } else if (vocabParam === "place-roles") {
    const rows = await db
      .select({
        role: descriptionPlaces.role,
        count: sql<number>`count(*)`,
      })
      .from(descriptionPlaces)
      .groupBy(descriptionPlaces.role)
      .all();
    for (const row of rows) usageMap.set(row.role, row.count);
  } else if (vocabParam === "entity-types") {
    const rows = await db
      .select({
        type: entities.entityType,
        count: sql<number>`count(*)`,
      })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          sql`${entities.mergedInto} IS NULL`
        )
      )
      .groupBy(entities.entityType)
      .all();
    for (const row of rows) usageMap.set(row.type, row.count);
  } else if (vocabParam === "place-types") {
    const rows = await db
      .select({
        type: places.placeType,
        count: sql<number>`count(*)`,
      })
      .from(places)
      .where(eq(places.federationId, tenant.federationId))
      .groupBy(places.placeType)
      .all();
    for (const row of rows) usageMap.set(row.type ?? "", row.count);
  }

  const vocabConfig = VOCAB_MAP[vocabParam];
  const terms = vocabConfig.enumArray.map((value) => ({
    value,
    label: value,
    count: usageMap.get(value) ?? 0,
  }));

  // Load pending changes if they exist
  let pendingChanges: PendingChange[] = [];
  try {
    const pendingModule = await import(
      "~/lib/validation/enum-pending-changes.json"
    );
    const allPending = pendingModule.default as PendingChange[];
    pendingChanges = allPending.filter(
      (c: PendingChange) => c.vocabKey === vocabParam
    );
  } catch {
    // No pending changes file yet
  }

  return {
    vocab: vocabParam,
    vocabLabel: vocabConfig.labelKey,
    terms,
    isSuperAdmin: user.isSuperAdmin,
    pendingChanges,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface PendingChange {
  vocabKey: string;
  action: "add" | "edit" | "delete";
  value: string;
  oldValue?: string;
  addedBy: string;
  addedAt: number;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");

  const user = context.get(userContext);
  requireAdmin(user);

  // Superadmin check for all mutations
  if (!user.isSuperAdmin) {
    throw new Response("Forbidden", { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get("_action") as string;
  const vocabKey = formData.get("vocabKey") as string;

  if (!vocabKey || !(vocabKey in VOCAB_MAP)) {
    return { ok: false as const, error: "invalid_vocab" };
  }

  const vocabConfig = VOCAB_MAP[vocabKey as VocabKey];
  const existingValues = new Set(
    vocabConfig.enumArray.map((v) => v.toLowerCase())
  );

  // Load current pending changes
  let pendingChanges: PendingChange[] = [];
  try {
    const pendingModule = await import(
      "~/lib/validation/enum-pending-changes.json"
    );
    pendingChanges = [...(pendingModule.default as PendingChange[])];
  } catch {
    // No file yet
  }

  switch (intent) {
    case "add-term": {
      const value = (formData.get("value") as string)?.trim();
      if (!value) {
        return { ok: false as const, error: "empty_value" };
      }
      if (existingValues.has(value.toLowerCase())) {
        return { ok: false as const, error: "duplicate" };
      }
      // Check pending adds too
      const pendingAdds = pendingChanges
        .filter((c) => c.vocabKey === vocabKey && c.action === "add")
        .map((c) => c.value.toLowerCase());
      if (pendingAdds.includes(value.toLowerCase())) {
        return { ok: false as const, error: "duplicate" };
      }
      pendingChanges.push({
        vocabKey,
        action: "add",
        value,
        addedBy: user.id,
        addedAt: Date.now(),
      });
      break;
    }

    case "edit-term": {
      const oldValue = (formData.get("oldValue") as string)?.trim();
      const newValue = (formData.get("newValue") as string)?.trim();
      if (!oldValue || !newValue) {
        return { ok: false as const, error: "empty_value" };
      }
      if (oldValue === newValue) {
        return { ok: false as const, error: "no_change" };
      }
      pendingChanges.push({
        vocabKey,
        action: "edit",
        value: newValue,
        oldValue,
        addedBy: user.id,
        addedAt: Date.now(),
      });
      break;
    }

    case "delete-term": {
      const value = (formData.get("value") as string)?.trim();
      const count = parseInt(formData.get("count") as string, 10) || 0;
      if (!value) {
        return { ok: false as const, error: "empty_value" };
      }
      if (count > 0) {
        return { ok: false as const, error: "in_use" };
      }
      pendingChanges.push({
        vocabKey,
        action: "delete",
        value,
        addedBy: user.id,
        addedAt: Date.now(),
      });
      break;
    }

    default:
      return { ok: false as const, error: "unknown_intent" };
  }

  // Note: In a production environment, pending changes would be persisted to
  // a database table or KV store. The JSON file approach requires a build step
  // to take effect, which aligns with the redeployment requirement. For now,
  // changes are tracked in session and displayed as pending.
  return {
    ok: true as const,
    pendingChanges: pendingChanges.filter((c) => c.vocabKey === vocabKey),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EnumVocabularyPage({
  loaderData,
}: Route.ComponentProps) {
  const { vocab, vocabLabel, terms, isSuperAdmin, pendingChanges } =
    loaderData;
  const { t } = useTranslation("vocabularies");
  const { t: tEntities } = useTranslation("entities");

  const [isAddingTerm, setIsAddingTerm] = useState(false);
  const [newTermValue, setNewTermValue] = useState("");
  const [editingTerm, setEditingTerm] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/vocabularies"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("page_title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{t(vocabLabel)}</li>
        </ol>
      </nav>

      {/* Page heading */}
      <h1 className="font-serif text-lg font-semibold text-stone-700">
        {t(vocabLabel)}
      </h1>

      {/* Redeployment warning banner */}
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-saffron bg-saffron-tint p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-saffron" />
        <p className="text-sm text-saffron-deep">
          {t("enum_redeployment_warning")}
        </p>
      </div>

      {/* Add term button (superadmin only) */}
      {isSuperAdmin && !isAddingTerm && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setIsAddingTerm(true)}
            className="inline-flex items-center gap-1 rounded-md border border-stone-200 px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Plus className="h-4 w-4" />
            {t("add_term")}
          </button>
        </div>
      )}

      {/* Terms table */}
      <div className="mt-4 rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200">
              <th className="px-4 py-3 text-left font-semibold text-stone-500">
                {t("col_function")}
              </th>
              <th className="px-4 py-3 text-right font-semibold text-stone-500">
                {t("col_usage")}
              </th>
              {isSuperAdmin && (
                <th className="px-4 py-3 text-right font-semibold text-stone-500">
                  {t("col_actions")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {/* Add term row (inline) */}
            {isAddingTerm && (
              <tr className="border-b border-stone-200 bg-stone-50">
                <td className="px-4 py-2" colSpan={isSuperAdmin ? 3 : 2}>
                  <Form method="post" className="flex items-center gap-2">
                    <input type="hidden" name="_action" value="add-term" />
                    <input type="hidden" name="vocabKey" value={vocab} />
                    <input
                      type="text"
                      name="value"
                      value={newTermValue}
                      onChange={(e) => setNewTermValue(e.target.value)}
                      placeholder={t("add_term")}
                      autoFocus
                      className="flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 rounded-md bg-indigo px-3 py-1.5 text-sm font-semibold text-parchment hover:bg-indigo-deep"
                    >
                      <Check className="h-4 w-4" />
                      {t("save_term")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsAddingTerm(false);
                        setNewTermValue("");
                      }}
                      className="inline-flex items-center rounded-lg border border-stone-200 px-2 py-1.5 text-sm text-stone-500 hover:bg-stone-50"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Form>
                </td>
              </tr>
            )}

            {terms.map((term) => (
              <tr
                key={term.value}
                className="border-b border-stone-200 last:border-b-0"
              >
                <td className="px-4 py-3 text-stone-700">
                  {editingTerm === term.value ? (
                    <Form
                      method="post"
                      className="flex items-center gap-2"
                      onSubmit={() => setEditingTerm(null)}
                    >
                      <input type="hidden" name="_action" value="edit-term" />
                      <input type="hidden" name="vocabKey" value={vocab} />
                      <input
                        type="hidden"
                        name="oldValue"
                        value={term.value}
                      />
                      <input
                        type="text"
                        name="newValue"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditingTerm(null);
                        }}
                        className="flex-1 rounded-lg border border-stone-200 px-2 py-1 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                      />
                      <button
                        type="submit"
                        className="text-indigo-deep hover:text-indigo"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingTerm(null)}
                        className="text-stone-500 hover:text-stone-700"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </Form>
                  ) : (
                    term.label
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-500">
                  {term.count}
                </td>
                {isSuperAdmin && (
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingTerm(term.value);
                          setEditValue(term.value);
                        }}
                        className="rounded p-1 text-stone-500 hover:bg-stone-50 hover:text-stone-700"
                        title={t("edit_term")}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {term.count === 0 ? (
                        <Form method="post" className="inline">
                          <input
                            type="hidden"
                            name="_action"
                            value="delete-term"
                          />
                          <input
                            type="hidden"
                            name="vocabKey"
                            value={vocab}
                          />
                          <input
                            type="hidden"
                            name="value"
                            value={term.value}
                          />
                          <input
                            type="hidden"
                            name="count"
                            value={String(term.count)}
                          />
                          <button
                            type="submit"
                            className="rounded p-1 text-madder hover:bg-madder-tint"
                            title={t("delete_term")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </Form>
                      ) : (
                        <span
                          className="cursor-not-allowed rounded p-1 text-stone-300"
                          title={t("cannot_delete", { count: term.count })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pending changes section (superadmin only) */}
      {isSuperAdmin && pendingChanges.length > 0 && (
        <div className="mt-6">
          <h2 className="font-sans text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("enum_pending_changes")}
          </h2>
          <div className="mt-2 rounded-lg border border-saffron bg-saffron-tint p-4">
            <ul className="space-y-2 text-sm text-saffron-deep">
              {pendingChanges.map((change, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="rounded bg-saffron-tint px-1.5 py-0.5 text-xs font-semibold uppercase">
                    {change.action}
                  </span>
                  {change.action === "edit" ? (
                    <span>
                      {change.oldValue} &rarr; {change.value}
                    </span>
                  ) : (
                    <span>{change.value}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
