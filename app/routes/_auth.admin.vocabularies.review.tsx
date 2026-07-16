/**
 * Vocabularies — Review Queue
 *
 * This page is the reviewer-only backlog of draft vocabulary terms
 * awaiting approval. It shows each draft with its proposed label, any
 * linked descriptions,
 * and inline approve / reject actions. Rejections surface the inline
 * panel so the reviewer can capture a reason without leaving the
 * queue.
 *
 * Authority scope is the federation (migrations 0045-0048). The merge
 * action's primaryFunctionId reassignment and post-merge entity-count
 * subqueries are scoped to `tenant.federationId`, and every vocab
 * mutation (approve/reject/merge) carries a federation predicate. The
 * queue is federation-scoped: a proposal surfaces in its federation via
 * vocabulary_terms.federation_id, which replaces the former
 * proposer-tenant visibility rule (and its orphan-proposal fallback).
 *
 * @version v0.4.2
 */

import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronLeft, Check, GitMerge, X } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { VocabularyStatusBadge } from "~/components/admin/vocabulary-status-badge";
import { RejectInlinePanel } from "~/components/admin/reject-inline-panel";
import { escapeLike } from "~/lib/sql-utils";
import type { Route } from "./+types/_auth.admin.vocabularies.review";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProposedTerm {
  id: string;
  canonical: string;
  category: string | null;
  entityCount: number;
  proposedByName: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, isNull, desc, sql } = await import("drizzle-orm");
  const { vocabularyTerms, users } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const url = new URL(request.url);

  // JSON search API for merge dialog (reuse same pattern as functions listing)
  if (url.searchParams.get("intent") === "search-terms") {
    const { like } = await import("drizzle-orm");
    const q = url.searchParams.get("q")?.trim() || "";
    const excludeId = url.searchParams.get("exclude") || "";
    const conditions = [
      eq(vocabularyTerms.federationId, tenant.federationId),
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

  const page = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1", 10)
  );
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  // Queue visibility: a proposal belongs to its FEDERATION (migration
  // 0045). The proposer-tenant scoping this replaced is superseded by
  // vocabulary_terms.federation_id, which every term carries (including
  // orphan proposals whose proposedBy went null after a user deletion),
  // so no or()/isNull fallback is needed. The users leftJoin below stays
  // only to surface the proposer name.
  const proposedVisibleHere = and(
    eq(vocabularyTerms.status, "proposed"),
    isNull(vocabularyTerms.mergedInto),
    eq(vocabularyTerms.federationId, tenant.federationId)
  );

  // Count total proposed terms visible to this tenant
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(vocabularyTerms)
    .leftJoin(users, eq(vocabularyTerms.proposedBy, users.id))
    .where(proposedVisibleHere)
    .all();

  // Fetch proposed terms with proposer name
  const rows = await db
    .select({
      id: vocabularyTerms.id,
      canonical: vocabularyTerms.canonical,
      category: vocabularyTerms.category,
      entityCount: vocabularyTerms.entityCount,
      proposedByName: users.name,
      createdAt: vocabularyTerms.createdAt,
    })
    .from(vocabularyTerms)
    .leftJoin(users, eq(vocabularyTerms.proposedBy, users.id))
    .where(proposedVisibleHere)
    .orderBy(desc(vocabularyTerms.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();

  return {
    terms: rows as ProposedTerm[],
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { vocabularyTerms, entities, changelog } = await import(
    "~/db/schema"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Authority mutation gate (ruled 2026-07-08): approving, rejecting, or
  // merging proposed terms is a canonical vocabulary mutation subject to
  // federation steward review; the review queue is steward-only.
  // Member-tenant PROPOSE is currently unreachable (the only propose
  // sites live inside the steward-gated entity create/update intents)
  // and defers to the entities/places propose-for-review follow-up
  // (ruled 2026-07-08). Behaviour-neutral today.
  const { requireFederationSteward } = await import("~/lib/federation.server");
  await requireFederationSteward(db, user, tenant);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "approve": {
      const termId = formData.get("termId") as string;
      const category = (formData.get("category") as string)?.trim() || null;
      if (!termId) return { ok: false as const, error: "missing_id" };

      const now = Math.floor(Date.now() / 1000);
      const updates: Record<string, unknown> = {
        status: "approved",
        reviewedBy: user.id,
        reviewedAt: now,
        updatedAt: now,
      };
      if (category) {
        updates.category = category;
      }

      await db
        .update(vocabularyTerms)
        .set(updates)
        .where(
          and(
            eq(vocabularyTerms.id, termId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        );

      // Changelog entry
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: termId,
        recordType: "vocabulary_term",
        userId: user.id,
        note: "Approved proposed term",
        diff: JSON.stringify({ status: { old: "proposed", new: "approved" } }),
        createdAt: now,
      });

      return { ok: true as const, action: "approved" };
    }

    case "reject": {
      const termId = formData.get("termId") as string;
      const reason = (formData.get("reason") as string)?.trim() || "";
      if (!termId) return { ok: false as const, error: "missing_id" };

      const now = Math.floor(Date.now() / 1000);

      // Fetch current term for notes append
      const term = await db
        .select({ notes: vocabularyTerms.notes })
        .from(vocabularyTerms)
        .where(
          and(
            eq(vocabularyTerms.id, termId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        )
        .get();

      const existingNotes = term?.notes || "";
      const rejectNote = reason
        ? `Rejected: ${reason}`
        : "Rejected (no reason given)";
      const updatedNotes = existingNotes
        ? `${existingNotes}\n${rejectNote}`
        : rejectNote;

      // Deprecate -- do NOT delete, do NOT null entity FKs
      await db
        .update(vocabularyTerms)
        .set({
          status: "deprecated",
          reviewedBy: user.id,
          reviewedAt: now,
          notes: updatedNotes,
          updatedAt: now,
        })
        .where(
          and(
            eq(vocabularyTerms.id, termId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        );

      // Changelog entry
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: termId,
        recordType: "vocabulary_term",
        userId: user.id,
        note: `Rejected: ${reason}`,
        diff: JSON.stringify({
          status: { old: "proposed", new: "deprecated" },
        }),
        createdAt: now,
      });

      return { ok: true as const, action: "rejected" };
    }

    case "merge": {
      const { logAuthorityOperation } = await import(
        "~/lib/authority-operations.server"
      );
      const sourceId = formData.get("sourceId") as string;
      const targetId = formData.get("targetId") as string;
      if (!sourceId || !targetId)
        return { ok: false as const, error: "missing_ids" };

      const now = Math.floor(Date.now() / 1000);

      // Count the entities the reassignment below will move BEFORE the
      // batch — the ledger's movedLinks must describe this merge, and the
      // predicate matches the UPDATE's exactly.
      const [{ count: movedLinks }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(entities)
        .where(
          and(
            eq(entities.federationId, tenant.federationId),
            eq(entities.primaryFunctionId, sourceId)
          )
        )
        .all();

      // Entity reassignment, source deprecation, and the ledger row commit
      // in one batch so the ledger cannot fall out of step with the
      // mutation. The target entityCount recompute and the changelog write
      // stay sequential after the batch (denormalised cache + display
      // trail, matching the functions.$id merge). The ledger is always
      // epoch ms (Date.now()), not this route's second-precision `now`.
      await db.batch([
        db
          .update(entities)
          .set({ primaryFunctionId: targetId, updatedAt: now })
          .where(
            and(
              eq(entities.federationId, tenant.federationId),
              eq(entities.primaryFunctionId, sourceId)
            )
          ),
        db
          .update(vocabularyTerms)
          .set({
            status: "deprecated",
            mergedInto: targetId,
            entityCount: 0,
            reviewedBy: user.id,
            reviewedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(vocabularyTerms.id, sourceId),
              eq(vocabularyTerms.federationId, tenant.federationId)
            )
          ),
        logAuthorityOperation(db, {
          federationId: tenant.federationId,
          recordType: "vocabulary_term",
          operation: "merge",
          sourceId,
          targetId,
          userId: user.id,
          detail: { movedLinks },
          now: Date.now(),
        }),
      ] as any);

      // Update target entity count (federation-scoped).
      const [{ count }] = await db
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
        .set({ entityCount: count, updatedAt: now })
        .where(
          and(
            eq(vocabularyTerms.id, targetId),
            eq(vocabularyTerms.federationId, tenant.federationId)
          )
        );

      // Changelog
      await db.insert(changelog).values({
        id: crypto.randomUUID(),
        recordId: sourceId,
        recordType: "vocabulary_term",
        userId: user.id,
        note: `Merged into ${targetId}`,
        diff: JSON.stringify({
          status: { old: "proposed", new: "deprecated" },
          mergedInto: { old: null, new: targetId },
        }),
        createdAt: now,
      });

      return { ok: true as const, action: "merged" };
    }

    default:
      return { ok: false as const, error: "unknown_intent" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ReviewQueuePage({
  loaderData,
}: Route.ComponentProps) {
  const { terms, total, page, totalPages } = loaderData;
  const { t } = useTranslation("vocabularies");
  const [rejectingTermId, setRejectingTermId] = useState<string | null>(null);
  const approveFetcher = useFetcher();

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return d.toISOString().slice(0, 10);
  };

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
          <li>
            <Link
              to="/admin/vocabularies/functions"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("vocab_primary_functions")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{t("review_queue")}</li>
        </ol>
      </nav>

      {/* Page heading */}
      <h1 className="font-serif text-lg font-semibold text-stone-700">
        {t("review_queue")}
      </h1>
      <p className="mt-1 text-sm text-stone-500">
        {t("n_proposed", { count: total })}
      </p>

      {/* Empty state */}
      {terms.length === 0 ? (
        <div className="mt-8 text-center">
          <p className="text-sm text-stone-400">{t("no_proposed")}</p>
        </div>
      ) : (
        <>
          {/* Terms table */}
          <div className="mt-6 rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <th className="px-4 py-3 text-left font-semibold text-stone-500">
                    {t("col_function")}
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-stone-500">
                    {t("proposed_by")}
                  </th>
                  <th className="px-4 py-3 text-left font-semibold text-stone-500">
                    Date
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-stone-500">
                    {t("col_usage")}
                  </th>
                  <th className="px-4 py-3 text-right font-semibold text-stone-500">
                    {t("col_actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {terms.map((term) => (
                  <tr
                    key={term.id}
                    className="border-b border-stone-200 last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/vocabularies/functions/${term.id}`}
                        className="font-semibold text-indigo-deep hover:underline"
                      >
                        {term.canonical}
                      </Link>
                      {term.category && (
                        <span className="ml-2 text-xs text-stone-400">
                          {term.category}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-stone-500">
                      {term.proposedByName ?? "\u2014"}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-stone-500">
                      {formatDate(term.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-stone-500">
                      {term.entityCount}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {/* Approve */}
                        <approveFetcher.Form method="post">
                          <input
                            type="hidden"
                            name="_action"
                            value="approve"
                          />
                          <input
                            type="hidden"
                            name="termId"
                            value={term.id}
                          />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded-md border border-verdigris-deep px-2 py-1 text-xs font-semibold text-verdigris-deep hover:bg-verdigris-tint"
                            title={t("approve_term")}
                          >
                            <Check className="h-3 w-3" />
                            {t("approve_term")}
                          </button>
                        </approveFetcher.Form>

                        {/* Reject */}
                        <button
                          type="button"
                          onClick={() =>
                            setRejectingTermId(
                              rejectingTermId === term.id ? null : term.id
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-md border border-madder-deep px-2 py-1 text-xs font-semibold text-madder-deep hover:bg-madder-tint"
                          title={t("reject_term")}
                        >
                          <X className="h-3 w-3" />
                          {t("reject_term")}
                        </button>
                      </div>

                      {/* Reject inline panel */}
                      {rejectingTermId === term.id && (
                        <div className="mt-2">
                          <RejectInlinePanel
                            termId={term.id}
                            termName={term.canonical}
                            isOpen={true}
                            onClose={() => setRejectingTermId(null)}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-stone-500">
                Page {page} of {totalPages}
              </p>
              <div className="flex gap-2">
                {page > 1 && (
                  <Link
                    to={`?page=${page - 1}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Link>
                )}
                {page < totalPages && (
                  <Link
                    to={`?page=${page + 1}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
