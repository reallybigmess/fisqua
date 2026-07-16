/**
 * Vocabularies — Function Detail
 *
 * This page is the detail view for one function-style vocabulary term: label in every
 * active locale, linked descriptions, current status, and the full
 * audit trail. Mutations route through the shared admin dialogs
 * (merge, split, link-description) so each workflow stays consistent
 * with the rest of the vocabularies hub.
 *
 * Authority scope is the federation (migrations 0045-0048). Every
 * read/update/delete of `entities` (linked-entity reads,
 * primaryFunction reassignment, count subqueries) and every vocabulary
 * term read/mutation (save/merge/split/deprecate) is filtered by
 * `tenant.federationId`.
 *
 * @version v0.4.2
 */

import { useState, useEffect } from "react";
import { Form, Link, redirect, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { FUNCTION_CATEGORIES } from "~/lib/validation/enums";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { VocabularyStatusBadge } from "~/components/admin/vocabulary-status-badge";
import { MergeDialog } from "~/components/admin/merge-dialog";
import { SplitDialog } from "~/components/admin/split-dialog";
import type { Route } from "./+types/_auth.admin.vocabularies.functions.$id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VocabTerm {
  id: string;
  canonical: string;
  category: string | null;
  status: string;
  entityCount: number;
  notes: string | null;
  mergedInto: string | null;
  proposedBy: string | null;
}

interface LinkedEntity {
  id: string;
  displayName: string;
  entityType: string;
  entityCode: string | null;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { vocabularyTerms, entities } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const term = await db
    .select()
    .from(vocabularyTerms)
    .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)))
    .get();

  if (!term) {
    throw new Response("Not found", { status: 404 });
  }

  // If merged, redirect to the target
  if (term.mergedInto) {
    throw redirect(`/admin/vocabularies/functions/${term.mergedInto}`);
  }

  // Fetch linked entities (first page)
  const pageSize = 25;
  const linkedEntities = (await db
    .select({
      id: entities.id,
      displayName: entities.displayName,
      entityType: entities.entityType,
      entityCode: entities.entityCode,
    })
    .from(entities)
    .where(
      and(
        eq(entities.federationId, tenant.federationId),
        eq(entities.primaryFunctionId, id)
      )
    )
    .limit(pageSize)
    .all()) as LinkedEntity[];

  // Count total linked entities
  const [{ count: totalLinked }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(entities)
    .where(
      and(
        eq(entities.federationId, tenant.federationId),
        eq(entities.primaryFunctionId, id)
      )
    )
    .all();

  return { term: term as VocabTerm, linkedEntities, totalLinked };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, inArray, sql } = await import("drizzle-orm");
  const { vocabularyTerms, entities, changelog } = await import("~/db/schema");
  const { vocabularyTermSchema } = await import("~/lib/validation/vocabulary");
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Authority mutation gate (ruled 2026-07-08): every intent here (save,
  // merge, split, deprecate) is a canonical vocabulary mutation subject
  // to federation steward review. Behaviour-neutral today (lead admin =
  // steward); denies member-tenant admins once member tenants exist.
  const { requireFederationSteward } = await import("~/lib/federation.server");
  await requireFederationSteward(db, user, tenant);

  const formData = await request.formData();
  // The shared admin MergeDialog/SplitDialog submit the discriminator as
  // `_action`; the legacy vocab forms use `intent`. Accept either spelling.
  const intent = (formData.get("intent") ?? formData.get("_action")) as string;
  const now = Math.floor(Date.now() / 1000);
  const id = params.id;

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  if (intent === "save") {
    const canonical = (formData.get("canonical") as string)?.trim();
    const category = (formData.get("category") as string) || null;
    const status = (formData.get("status") as string) || "approved";
    const notes = (formData.get("notes") as string)?.trim() || null;

    const parsed = vocabularyTermSchema.safeParse({
      canonical,
      category: category || undefined,
      status,
      notes,
    });
    if (!parsed.success) {
      return { error: "Invalid input", fieldErrors: parsed.error.format() };
    }

    const existing = await db
      .select()
      .from(vocabularyTerms)
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)))
      .get();
    if (!existing) return { error: "Term not found" };

    await db
      .update(vocabularyTerms)
      .set({
        canonical: parsed.data.canonical,
        category: parsed.data.category ?? null,
        status: parsed.data.status,
        notes: parsed.data.notes ?? null,
        updatedAt: now,
      })
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)));

    // Changelog
    const diff: Record<string, { old: unknown; new: unknown }> = {};
    if (existing.canonical !== parsed.data.canonical) {
      diff.canonical = { old: existing.canonical, new: parsed.data.canonical };
    }
    if (existing.category !== (parsed.data.category ?? null)) {
      diff.category = { old: existing.category, new: parsed.data.category ?? null };
    }
    if (existing.status !== parsed.data.status) {
      diff.status = { old: existing.status, new: parsed.data.status };
    }
    if (existing.notes !== (parsed.data.notes ?? null)) {
      diff.notes = { old: existing.notes, new: parsed.data.notes ?? null };
    }

    if (Object.keys(diff).length > 0) {
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: id,
        recordType: "vocabulary_term",
        userId: user.id,
        note: `Updated: ${parsed.data.canonical}`,
        diff: JSON.stringify(diff),
        createdAt: now,
      });
    }

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Merge
  // ---------------------------------------------------------------------------
  if (intent === "merge") {
    const targetId = formData.get("targetId") as string;
    if (!targetId) return { error: "Missing target" };
    if (targetId === id) return { error: "Cannot merge into self" };

    const target = await db
      .select()
      .from(vocabularyTerms)
      .where(and(eq(vocabularyTerms.id, targetId), eq(vocabularyTerms.federationId, tenant.federationId)))
      .get();
    if (!target) return { error: "Target not found" };

    const source = await db
      .select()
      .from(vocabularyTerms)
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)))
      .get();
    if (!source) return { error: "Source not found" };

    // Parse selected entity IDs
    const linkIdsRaw = formData.get("linkIds") as string;
    let entityIds: string[] = [];
    try {
      entityIds = JSON.parse(linkIdsRaw || "[]");
    } catch {
      entityIds = [];
    }

    // Reassignment + deprecation + the ledger row commit in one batch so
    // the ledger cannot fall out of step with the mutation. Entity
    // reassignment is federation-scoped so a cross-tenant id-guess in the
    // linkIds payload cannot move entities between federations. The ledger
    // is always epoch ms (Date.now()), not the second-precision `now` this
    // route uses for vocabulary_terms.updated_at.
    const mergeStatements: any[] = [];
    if (entityIds.length > 0) {
      mergeStatements.push(
        db
          .update(entities)
          .set({ primaryFunctionId: targetId, updatedAt: now })
          .where(
            and(
              eq(entities.federationId, tenant.federationId),
              inArray(entities.id, entityIds)
            )
          )
      );
    }
    mergeStatements.push(
      db
        .update(vocabularyTerms)
        .set({
          mergedInto: targetId,
          status: "deprecated",
          updatedAt: now,
        })
        .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)))
    );
    mergeStatements.push(
      logAuthorityOperation(db, {
        federationId: tenant.federationId,
        recordType: "vocabulary_term",
        operation: "merge",
        sourceId: id,
        targetId,
        userId: user.id,
        detail: { movedLinks: entityIds.length },
        now: Date.now(),
      })
    );
    await db.batch(mergeStatements as any);

    // Update entity counts on both. The counts are tenant-scoped so
    // they reflect the calling tenant only; vocabulary_terms itself
    // does not carry a tenantId in the current schema.
    const [{ count: targetCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          eq(entities.primaryFunctionId, targetId)
        )
      )
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: targetCount, updatedAt: now })
      .where(and(eq(vocabularyTerms.id, targetId), eq(vocabularyTerms.federationId, tenant.federationId)));

    const [{ count: sourceCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          eq(entities.primaryFunctionId, id)
        )
      )
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: sourceCount, updatedAt: now })
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)));

    // Changelog
    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Merged "${source.canonical}" into "${target.canonical}" (${entityIds.length} entities reassigned)`,
      diff: JSON.stringify({
        mergedInto: { old: null, new: targetId },
        status: { old: source.status, new: "deprecated" },
      }),
      createdAt: now,
    });

    throw redirect(`/admin/vocabularies/functions/${targetId}`);
  }

  // ---------------------------------------------------------------------------
  // Split
  // ---------------------------------------------------------------------------
  if (intent === "split") {
    const newName = (formData.get("newName") as string)?.trim();
    if (!newName) return { error: "New term name is required" };

    const parsed = vocabularyTermSchema.safeParse({ canonical: newName });
    if (!parsed.success) return { error: "Invalid name" };

    const source = await db
      .select()
      .from(vocabularyTerms)
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)))
      .get();
    if (!source) return { error: "Source not found" };

    // Parse selected entity IDs
    const linkIdsRaw = formData.get("linkIds") as string;
    let entityIds: string[] = [];
    try {
      entityIds = JSON.parse(linkIdsRaw || "[]");
    } catch {
      entityIds = [];
    }

    // Term creation + entity moves + the ledger row commit in one batch so
    // the ledger cannot fall out of step with the mutation. Entity moves
    // are federation-scoped to prevent cross-federation reassignment via a
    // crafted linkIds payload. The ledger is always epoch ms (Date.now()),
    // not the second-precision `now` this route uses elsewhere.
    const newId = crypto.randomUUID();
    const splitStatements: any[] = [
      db.insert(vocabularyTerms).values({
        id: newId,
        federationId: tenant.federationId,
        canonical: parsed.data.canonical,
        category: source.category,
        status: "approved",
        entityCount: 0,
        createdAt: now,
        updatedAt: now,
      }),
    ];
    if (entityIds.length > 0) {
      splitStatements.push(
        db
          .update(entities)
          .set({ primaryFunctionId: newId, updatedAt: now })
          .where(
            and(
              eq(entities.federationId, tenant.federationId),
              inArray(entities.id, entityIds)
            )
          )
      );
    }
    splitStatements.push(
      logAuthorityOperation(db, {
        federationId: tenant.federationId,
        recordType: "vocabulary_term",
        operation: "split",
        sourceId: id,
        targetId: newId,
        userId: user.id,
        detail: { movedLinks: entityIds.length },
        now: Date.now(),
      })
    );
    await db.batch(splitStatements as any);

    // Update entity counts on both
    const [{ count: sourceCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          eq(entities.primaryFunctionId, id)
        )
      )
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: sourceCount, updatedAt: now })
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)));

    const [{ count: newCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          eq(entities.primaryFunctionId, newId)
        )
      )
      .all();
    await db
      .update(vocabularyTerms)
      .set({ entityCount: newCount, updatedAt: now })
      .where(and(eq(vocabularyTerms.id, newId), eq(vocabularyTerms.federationId, tenant.federationId)));

    // Changelog
    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
      recordType: "vocabulary_term",
      userId: user.id,
      note: `Split "${source.canonical}": created "${parsed.data.canonical}" with ${entityIds.length} entities`,
      diff: JSON.stringify({
        split: { newTermId: newId, newCanonical: parsed.data.canonical, entitiesMoved: entityIds.length },
      }),
      createdAt: now,
    });

    throw redirect(`/admin/vocabularies/functions/${newId}`);
  }

  // ---------------------------------------------------------------------------
  // Deprecate
  // ---------------------------------------------------------------------------
  if (intent === "deprecate") {
    const existing = await db
      .select()
      .from(vocabularyTerms)
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)))
      .get();
    if (!existing) return { error: "Term not found" };

    await db
      .update(vocabularyTerms)
      .set({ status: "deprecated", updatedAt: now })
      .where(and(eq(vocabularyTerms.id, id), eq(vocabularyTerms.federationId, tenant.federationId)));

    await db.insert(changelog).values({
      id: crypto.randomUUID(),
      recordId: id,
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
// Entity type badge styles (reused from entities page)
// ---------------------------------------------------------------------------

const TYPE_BADGE_STYLES: Record<string, string> = {
  person: "bg-indigo-tint text-indigo",
  family: "bg-verdigris-tint text-verdigris",
  corporate: "bg-indigo-tint text-indigo",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminVocabularyFunctionDetailPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { term, linkedEntities, totalLinked } = loaderData;
  const { t } = useTranslation("vocabularies");
  const fetcher = useFetcher();

  // Merge dialog state
  const [showMerge, setShowMerge] = useState(false);

  // Split dialog state
  const [showSplit, setShowSplit] = useState(false);

  // Check URL for action=merge (linked from listing kebab menu)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("action") === "merge") {
      setShowMerge(true);
    }
  }, []);

  // Map the linked entities into the shared dialogs' DescriptionLink
  // shape. `role` carries the entity type (person/family/corporate) —
  // the most meaningful per-row chip, since entityCode is frequently
  // null and is an opaque identifier rather than a human-readable label.
  const descLinks = linkedEntities.map((e) => ({
    id: e.id,
    descriptionTitle: e.displayName,
    role: e.entityType,
  }));

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      {/* Breadcrumb */}
      <nav className="mb-4 text-sm text-stone-500">
        <Link to="/admin/vocabularies" className="hover:underline">
          {t("page_title")}
        </Link>
        <span className="mx-1">/</span>
        <Link to="/admin/vocabularies/functions" className="hover:underline">
          {t("vocab_primary_functions")}
        </Link>
        <span className="mx-1">/</span>
        <span className="text-stone-700">{term.canonical}</span>
      </nav>

      {/* Page heading */}
      <div className="flex items-center gap-3">
        <h1 className="font-serif text-lg font-semibold text-stone-700">
          {term.canonical}
        </h1>
        <VocabularyStatusBadge
          status={term.status as "approved" | "proposed" | "deprecated"}
        />
      </div>

      {/* Action result messages */}
      {actionData && "error" in actionData && (
        <div className="mt-4 rounded-md border border-madder bg-madder-tint p-3 text-sm text-madder-deep">
          {actionData.error}
        </div>
      )}
      {actionData && "success" in actionData && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint p-3 text-sm text-verdigris-deep">
          {t("save_term")} ✓
        </div>
      )}

      {/* Edit form card */}
      <Form method="post" className="mt-6 rounded-lg border border-stone-200 p-6">
        <input type="hidden" name="intent" value="save" />

        <div className="space-y-4">
          {/* Canonical label */}
          <div>
            <label
              htmlFor="canonical"
              className="block text-sm font-medium text-indigo"
            >
              {t("field_canonical")}
            </label>
            <input
              id="canonical"
              name="canonical"
              type="text"
              defaultValue={term.canonical}
              required
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>

          {/* Category */}
          <div>
            <label
              htmlFor="category"
              className="block text-sm font-medium text-indigo"
            >
              {t("field_category")}
            </label>
            <select
              id="category"
              name="category"
              defaultValue={term.category ?? ""}
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            >
              <option value="">{"\u2014"}</option>
              {FUNCTION_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`cat_${cat}`)}
                </option>
              ))}
            </select>
          </div>

          {/* Status */}
          <div>
            <label
              htmlFor="status"
              className="block text-sm font-medium text-indigo"
            >
              {t("field_status")}
            </label>
            <select
              id="status"
              name="status"
              defaultValue={term.status}
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            >
              <option value="approved">{t("status_approved")}</option>
              <option value="proposed">{t("status_proposed")}</option>
              <option value="deprecated">{t("status_deprecated")}</option>
            </select>
          </div>

          {/* Notes */}
          <div>
            <label
              htmlFor="notes"
              className="block text-sm font-medium text-indigo"
            >
              {t("field_notes")}
            </label>
            <textarea
              id="notes"
              name="notes"
              defaultValue={term.notes ?? ""}
              rows={3}
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
        </div>

        {/* Save button */}
        <div className="mt-6">
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("save_term")}
          </button>
        </div>
      </Form>

      {/* Linked entities section */}
      <div className="mt-8">
        <CollapsibleSection title={`${t("linked_entities")} (${totalLinked})`}>
          {linkedEntities.length === 0 ? (
            <p className="py-4 text-sm text-stone-500">
              {t("no_linked_entities")}
            </p>
          ) : (
            <div className="space-y-2">
              {linkedEntities.map((entity) => (
                <div
                  key={entity.id}
                  className="flex items-center gap-3 rounded border border-stone-200 px-3 py-2"
                >
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      TYPE_BADGE_STYLES[entity.entityType] ?? ""
                    }`}
                  >
                    {entity.entityType}
                  </span>
                  <Link
                    to={`/admin/entities/${entity.id}`}
                    className="text-sm font-semibold text-indigo-deep hover:underline"
                  >
                    {entity.displayName}
                  </Link>
                  {entity.entityCode && (
                    <span className="text-xs text-stone-500">
                      {entity.entityCode}
                    </span>
                  )}
                </div>
              ))}
              {totalLinked > linkedEntities.length && (
                <p className="py-2 text-xs text-stone-500">
                  {t("linked_more", {
                    count: totalLinked - linkedEntities.length,
                  })}
                </p>
              )}
            </div>
          )}
        </CollapsibleSection>
      </div>

      {/* Action buttons */}
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setShowMerge(true)}
          className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
        >
          {t("merge_into")}
        </button>
        <button
          type="button"
          onClick={() => setShowSplit(true)}
          className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
        >
          {t("split_term")}
        </button>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="deprecate" />
          <button
            type="submit"
            className="rounded-md border border-madder-deep px-4 py-2 text-sm font-semibold text-madder-deep hover:bg-madder-tint"
            onClick={(e) => {
              if (
                !confirm(
                  t("deprecate_confirm", {
                    term: term.canonical,
                    count: totalLinked,
                  })
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            {t("deprecate_term")}
          </button>
        </fetcher.Form>
      </div>

      {/* Merge dialog (shared admin component) */}
      <MergeDialog
        isOpen={showMerge}
        onClose={() => setShowMerge(false)}
        sourceId={term.id}
        sourceName={term.canonical}
        entityType="vocabulary"
        links={descLinks}
        searchEndpoint="/admin/vocabularies/functions"
        i18nNamespace="vocabularies"
      />

      {/* Split dialog (shared admin component) */}
      <SplitDialog
        isOpen={showSplit}
        onClose={() => setShowSplit(false)}
        sourceId={term.id}
        sourceName={term.canonical}
        entityType="vocabulary"
        links={descLinks}
        i18nNamespace="vocabularies"
        splitNameField={{
          label: t("splitNameLabel"),
          placeholder: t("splitNamePlaceholder"),
        }}
      />
    </div>
  );
}
