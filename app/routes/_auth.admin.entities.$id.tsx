/**
 * Entities Admin — record detail (two-column redesign)
 *
 * The authority record page for a single entity (spec §5 redesign,
 * mockup 2026-07-11): a ~420px left column carries the record itself —
 * Identity, Description, Control, and Linked open data
 * (Wikidata/VIAF/DBE; no map) — while the right column serves the
 * linked descriptions as a WORKLIST: server-side search over
 * title/reference code (`?dq=`), role pills with real GROUP BY counts
 * (spec §11's per-record role filter), sort by date/title/reference
 * code, and honest offset pagination with a user-selectable page size
 * (25/50/100). The loader ships ONE filtered page, never the whole
 * link set. Narrow screens stack record-first. Edit swaps the left
 * column to the existing inline form in place (autosave drafts +
 * optimistic lock untouched) without remounting the right column.
 *
 * Merge and split live on their own full-page workbench routes
 * (`entities.$id.merge`, `entities.$id.split`) — this action handles
 * only update/delete/autosave and the description-link intents. The
 * header's Merge/Split buttons navigate to the workbenches, which
 * enforce the required-reason ledger invariant this action does not
 * carry.
 *
 * Authority scope is the federation (migrations 0045-0048). Every
 * read/update/delete of `entities` and every vocabulary-term lookup is
 * filtered by `tenant.federationId`. The description-search subquery
 * stays `tenant.id`-scoped (descriptions remain tenant-scoped).
 *
 * @version v0.4.3
 */

import { useState, useEffect } from "react";
import { Form, useActionData, redirect } from "react-router";
import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { StatusBand } from "~/components/admin/status-band";
import { NameVariantInput } from "~/components/forms/name-variant-input";
import { LodLinkField, SERVICE_URLS } from "~/components/forms/lod-link-field";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import {
  AdminBreadcrumb,
  AuthorityDetailHeader,
} from "~/components/admin/authority-detail-header";
import { ConflictDialog } from "~/components/admin/conflict-dialog";
import { useAutosaveDraft } from "~/components/admin/use-autosave-draft";
import { FieldDisplay } from "~/components/admin/field-display";
import { EditField, EditTextarea } from "~/components/admin/edit-field";
import {
  TwoColumnDetail,
  DetailCard,
  VariantChips,
  NotesCards,
  NotesEditFields,
} from "~/components/admin/authority-detail-layout";
import { LinkedDescriptionsWorklist } from "~/components/admin/linked-descriptions-worklist";
import { parseWorklistParams } from "~/lib/worklist-params";
import { ENTITY_ROLES } from "~/lib/validation/enums";
import { TypeaheadInput } from "~/components/admin/typeahead-input";
import type { Route } from "./+types/_auth.admin.entities.$id";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, or, like, asc, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions, vocabularyTerms, repositories } = await import(
    "~/db/schema"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const entity = await db
    .select()
    .from(entities)
    .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id)))
    .get();

  if (!entity) {
    throw new Response("Not found", { status: 404 });
  }

  // Click-to-unfold context card (spec §5 worklist enhancement):
  // fetched on demand by junction id, never eager-loaded for the page.
  // Ownership is enforced in the helper — a junction id belonging to
  // another entity resolves to null (an IDOR surface), so the response
  // carries `card: null` rather than a foreign record's scope text.
  const cardUrl = new URL(request.url);
  const cardJunctionId = cardUrl.searchParams.get("card");
  if (cardJunctionId) {
    // "Show all" (`&full=1`): the full OCR transcript for that junction,
    // fetched only on that click — never eager-shipped (transcripts reach
    // 89 KB). Ownership is enforced in the helper identically to the card.
    if (cardUrl.searchParams.get("full") === "1") {
      const { loadJunctionOcrText } = await import(
        "~/lib/authority-linked-context.server"
      );
      const ocrFull = await loadJunctionOcrText(db, {
        recordType: "entity",
        ownerId: id,
        junctionId: cardJunctionId,
      });
      return Response.json({ ocrFull });
    }
    const { loadLinkedDescriptionCard } = await import(
      "~/lib/authority-linked-context.server"
    );
    const card = await loadLinkedDescriptionCard(db, {
      recordType: "entity",
      ownerId: id,
      displayName: entity.displayName,
      junctionId: cardJunctionId,
    });
    return Response.json({ card });
  }

  // Fetch linked vocabulary term for primaryFunction display
  let functionTerm: { id: string; canonical: string; status: string; category: string | null } | null = null;
  if (entity.primaryFunctionId) {
    const term = await db
      .select({
        id: vocabularyTerms.id,
        canonical: vocabularyTerms.canonical,
        status: vocabularyTerms.status,
        category: vocabularyTerms.category,
      })
      .from(vocabularyTerms)
      .where(
        and(
          eq(vocabularyTerms.id, entity.primaryFunctionId),
          eq(vocabularyTerms.federationId, tenant.federationId)
        )
      )
      .get();
    if (term) {
      functionTerm = term;
    }
  }

  // Count linked descriptions
  const [{ count: descLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionEntities)
    .where(eq(descriptionEntities.entityId, id))
    .all();

  // ---- Linked-descriptions worklist (spec §5 redesign; round-3 filters) ----
  const sp = new URL(request.url).searchParams;
  const wl = parseWorklistParams(sp);
  // An off-vocabulary role param is ignored, never an empty worklist.
  const role =
    wl.role && (ENTITY_ROLES as readonly string[]).includes(wl.role)
      ? (wl.role as (typeof ENTITY_ROLES)[number])
      : null;

  // The record's OWN repository ids (unfiltered): drives repo-pill
  // progressive disclosure (shown only when the links span > 1 repo) and
  // validates the `?repo=` param — an id that is not one of the record's
  // is ignored, never an empty worklist. Keyed by id, not label.
  const recordRepoRows = await db
    .select({ repositoryId: descriptions.repositoryId })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(eq(descriptionEntities.entityId, id))
    .groupBy(descriptions.repositoryId)
    .all();
  const recordRepoIds = new Set(recordRepoRows.map((r) => r.repositoryId));
  const repoSpan = recordRepoIds.size;
  const repo = wl.repo && recordRepoIds.has(wl.repo) ? wl.repo : null;

  // Search predicate over the joined description (title + reference
  // code), shared by the counts, the filtered total, and the page.
  const dqConditions: any[] = [eq(descriptionEntities.entityId, id)];
  if (wl.dq) {
    const pat = `%${wl.dq}%`;
    dqConditions.push(
      or(
        like(descriptions.title, pat),
        like(descriptions.referenceCode, pat),
      )!,
    );
  }

  // Cross-honest counts (spec §3): role counts under the search AND the
  // repository filter; repo counts under the search AND the role filter.
  const roleCountConditions = repo
    ? [...dqConditions, eq(descriptions.repositoryId, repo)]
    : dqConditions;
  const roleCounts = await db
    .select({
      role: descriptionEntities.role,
      count: sql<number>`count(*)`,
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(...roleCountConditions))
    .groupBy(descriptionEntities.role)
    .orderBy(sql`count(*) DESC`)
    .all();
  const allCount = roleCounts.reduce((sum, rc) => sum + rc.count, 0);

  // Repo pills: GROUP BY repository id, labelled short_name → code → name
  // (COALESCE(NULLIF(...)) — the AHRB repository's short_name is empty at
  // 13k-link scale), under the search + role filter.
  const repoCountConditions = role
    ? [...dqConditions, eq(descriptionEntities.role, role)]
    : dqConditions;
  const repoCounts = await db
    .select({
      repositoryId: descriptions.repositoryId,
      label: sql<string>`COALESCE(NULLIF(${repositories.shortName}, ''), NULLIF(${repositories.code}, ''), ${repositories.name})`,
      count: sql<number>`count(*)`,
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .innerJoin(repositories, eq(descriptions.repositoryId, repositories.id))
    .where(and(...repoCountConditions))
    .groupBy(descriptions.repositoryId)
    .orderBy(sql`count(*) DESC`)
    .all();

  // Honest filtered total (search + role + repo) from a real COUNT.
  const filterConditions: any[] = [...dqConditions];
  if (role) filterConditions.push(eq(descriptionEntities.role, role));
  if (repo) filterConditions.push(eq(descriptions.repositoryId, repo));
  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(...filterConditions))
    .all();

  // One page, sorted server-side. Date sorts newest-first with undated
  // rows last; title and reference code sort ascending. The junction id
  // breaks ties so paging is stable.
  const orderBy =
    wl.sort === "title"
      ? [asc(descriptions.title), asc(descriptionEntities.id)]
      : wl.sort === "code"
        ? [asc(descriptions.referenceCode), asc(descriptionEntities.id)]
        : [
            sql`${descriptions.dateStart} IS NULL`,
            sql`${descriptions.dateStart} DESC`,
            asc(descriptionEntities.id),
          ];
  const links = await db
    .select({
      id: descriptionEntities.id,
      descriptionId: descriptionEntities.descriptionId,
      role: descriptionEntities.role,
      roleNote: descriptionEntities.roleNote,
      sequence: descriptionEntities.sequence,
      honorific: descriptionEntities.honorific,
      function: descriptionEntities.function,
      nameAsRecorded: descriptionEntities.nameAsRecorded,
      descriptionTitle: descriptions.title,
      referenceCode: descriptions.referenceCode,
      descriptionLevel: descriptions.descriptionLevel,
      dateExpression: descriptions.dateExpression,
      dateStart: descriptions.dateStart,
      dateEnd: descriptions.dateEnd,
      creatorDisplay: descriptions.creatorDisplay,
      placeDisplay: descriptions.placeDisplay,
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id),
    )
    .where(and(...filterConditions))
    .orderBy(...orderBy)
    .limit(wl.size)
    .offset((wl.page - 1) * wl.size)
    .all();

  // If merged, fetch target entity's displayName + the ledger-derived
  // band actor (who merged it, when). Superseded status is derived from
  // the ledger — no schema column.
  let mergeTarget: { id: string; displayName: string } | null = null;
  let mergeBand: { date: string; user: string } | null = null;
  if (entity.mergedInto) {
    const target = await db
      .select({ id: entities.id, displayName: entities.displayName })
      .from(entities)
      .where(
        and(eq(entities.federationId, tenant.federationId), eq(entities.id, entity.mergedInto))
      )
      .get();
    if (target) {
      mergeTarget = target;
    }
    const { getOperationActor, bandDate } = await import(
      "~/lib/authority-workbench.server"
    );
    const actor = await getOperationActor(db, {
      recordType: "entity",
      operation: "merge",
      sourceId: id,
      targetId: entity.mergedInto,
    });
    if (actor) {
      mergeBand = { date: bandDate(actor.createdAt), user: actor.userName ?? "" };
    }
  }

  // Informational split bands (spec §4 — both halves stay live and
  // editable): "Split into…" on a split parent, "Split from…" on a
  // record a split created. The merged band takes precedence when the
  // record was later merged away.
  let splitIntoBand: {
    date: string;
    user: string;
    targets: { id: string; displayName: string }[];
  } | null = null;
  let splitFromBand: {
    date: string;
    user: string;
    parent: { id: string; displayName: string };
  } | null = null;
  if (!entity.mergedInto) {
    const { getOperationActor, getSplitTargets, bandDate } = await import(
      "~/lib/authority-workbench.server"
    );
    const { inArray } = await import("drizzle-orm");

    const targetIds = await getSplitTargets(db, "entity", id);
    if (targetIds.length > 0) {
      const targets = await db
        .select({ id: entities.id, displayName: entities.displayName })
        .from(entities)
        .where(
          and(
            eq(entities.federationId, tenant.federationId),
            inArray(entities.id, targetIds),
          ),
        )
        .all();
      const actor = await getOperationActor(db, {
        recordType: "entity",
        operation: "split",
        sourceId: id,
      });
      if (targets.length > 0 && actor) {
        splitIntoBand = {
          date: bandDate(actor.createdAt),
          user: actor.userName ?? "",
          targets,
        };
      }
    }

    const fromActor = await getOperationActor(db, {
      recordType: "entity",
      operation: "split",
      targetId: id,
    });
    if (fromActor) {
      const parent = await db
        .select({ id: entities.id, displayName: entities.displayName })
        .from(entities)
        .where(
          and(
            eq(entities.federationId, tenant.federationId),
            eq(entities.id, fromActor.sourceId),
          ),
        )
        .get();
      if (parent) {
        splitFromBand = {
          date: bandDate(fromActor.createdAt),
          user: fromActor.userName ?? "",
          parent,
        };
      }
    }
  }

  // Check for another user's draft on this record. Entities are
  // federation-shared (migrations 0045-0048), so the conflicting editor may
  // legitimately live in ANY tenant of the session tenant's federation —
  // resolve their name through the tenants join scoped to the
  // federation, not to the session tenant alone (a same-federation
  // cross-tenant editor must not render as "Unknown").
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users, tenants } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, tenant.id, id, "entity", user.id);
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .innerJoin(tenants, eq(users.tenantId, tenants.id))
      .where(
        and(
          eq(tenants.federationId, tenant.federationId),
          eq(users.id, conflictRaw.userId)
        )
      )
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  return {
    entity,
    descLinkCount,
    mergeTarget,
    mergeBand,
    splitIntoBand,
    splitFromBand,
    links,
    total,
    allCount,
    roleCounts,
    repoCounts,
    repoSpan,
    wl: {
      dq: wl.dq,
      role,
      repo,
      sort: wl.sort,
      size: wl.size,
      page: wl.page,
    },
    conflictDraft,
    functionTerm,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions, vocabularyTerms } = await import(
    "~/db/schema"
  );
  const { updateEntitySchema } = await import("~/lib/validation/entity");
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  // Authority mutation gate helper (ruled 2026-07-08). Applied per-intent
  // below to the canonical entity mutations (update, delete, merge,
  // split) — each requires a federation steward. NOT applied to autosave
  // (drafts), the read searches, or the description-link intents, which
  // stay open to member-tenant admins (READ + member-side junction ops).
  const { requireFederationSteward } = await import("~/lib/federation.server");

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, tenant.id, id, "entity", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      await requireFederationSteward(db, user, tenant);
      // Parse name variants from hidden field
      let nameVariants: string[] = [];
      try {
        nameVariants = JSON.parse(
          (formData.get("nameVariants") as string) || "[]"
        );
      } catch {
        nameVariants = [];
      }

      // Normalise form data
      const displayName =
        (formData.get("displayName") as string)?.trim() || undefined;
      const sortName =
        (formData.get("sortName") as string)?.trim() || undefined;
      const surname =
        (formData.get("surname") as string)?.trim() || undefined;
      const givenName =
        (formData.get("givenName") as string)?.trim() || undefined;
      const honorific =
        (formData.get("honorific") as string)?.trim() || undefined;
      const entityType =
        (formData.get("entityType") as string)?.trim() || undefined;
      const datesOfExistence =
        (formData.get("datesOfExistence") as string)?.trim() || undefined;
      const dateStart =
        (formData.get("dateStart") as string)?.trim() || undefined;
      const dateEnd =
        (formData.get("dateEnd") as string)?.trim() || undefined;
      const history =
        (formData.get("history") as string)?.trim() || undefined;
      const primaryFunction =
        (formData.get("primaryFunction") as string)?.trim() || undefined;
      // legalStatus dropped in 0036 (0% populated in production audit).
      const functions =
        (formData.get("functions") as string)?.trim() || undefined;
      const sources =
        (formData.get("sources") as string)?.trim() || undefined;
      const wikidataId =
        (formData.get("wikidataId") as string)?.trim() || undefined;
      const viafId =
        (formData.get("viafId") as string)?.trim() || undefined;
      const notes = (formData.get("notes") as string)?.trim() || null;
      const internalNotes =
        (formData.get("internalNotes") as string)?.trim() || null;

      const parsed = updateEntitySchema.safeParse({
        id,
        displayName,
        sortName,
        surname,
        givenName,
        honorific,
        entityType,
        primaryFunction,
        nameVariants: JSON.stringify(nameVariants),
        datesOfExistence,
        dateStart: dateStart || null,
        dateEnd: dateEnd || null,
        history,
        functions,
        sources,
        wikidataId: wikidataId || null,
        viafId: viafId || null,
        notes,
        internalNotes,
      });

      if (!parsed.success) {
        return {
          ok: false as const,
          errors: parsed.error.flatten().fieldErrors,
        };
      }

      // Fetch original for changelog diff
      const original = await db
        .select()
        .from(entities)
        .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id)))
        .get();

      // Optimistic lock check
      const formUpdatedAt = formData.get("_updatedAt") as string;
      const forceOverwrite = formData.get("_force") === "true";
      if (
        !forceOverwrite &&
        formUpdatedAt &&
        original &&
        String(original.updatedAt) !== formUpdatedAt
      ) {
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedAt: original.updatedAt,
        };
      }

      const { id: _id, ...updates } = parsed.data;

      // Resolve primaryFunctionId from typeahead
      let resolvedFunctionId: string | null = null;
      const primaryFunctionIdRaw = (formData.get("primaryFunctionId") as string)?.trim();
      const primaryFunctionText = updates.primaryFunction ?? null;

      if (primaryFunctionIdRaw) {
        // User selected an existing term. The hidden typeahead field
        // bypasses the Zod schema, and entities.primaryFunctionId is an
        // FK — an unverified stale id (term merged or deleted since
        // page load, or a tampered field) would fail the whole UPDATE
        // atomically and surface only the generic error, losing every
        // other edit in the submission. Verify existence first and
        // fail field-scoped instead.
        const selectedTerm = await db
          .select({ id: vocabularyTerms.id })
          .from(vocabularyTerms)
          .where(
            and(
              eq(vocabularyTerms.id, primaryFunctionIdRaw),
              eq(vocabularyTerms.federationId, tenant.federationId)
            )
          )
          .get();
        if (!selectedTerm) {
          return {
            ok: false as const,
            errors: {
              primaryFunction: [
                "Selected function no longer exists; reselect or retype it",
              ],
            },
          };
        }
        resolvedFunctionId = selectedTerm.id;
      } else if (primaryFunctionText) {
        // User typed a value -- check if it matches an existing term (case-insensitive)
        const { like: likeFn, isNull: isNullFn } = await import("drizzle-orm");
        const existingTerm = await db
          .select({ id: vocabularyTerms.id })
          .from(vocabularyTerms)
          .where(
            and(
              eq(vocabularyTerms.federationId, tenant.federationId),
              sql`LOWER(${vocabularyTerms.canonical}) = LOWER(${primaryFunctionText})`,
              isNullFn(vocabularyTerms.mergedInto)
            )
          )
          .get();

        if (existingTerm) {
          resolvedFunctionId = existingTerm.id;
        } else {
          // Create proposed term
          const newTermId = crypto.randomUUID();
          const now = Date.now();
          await db.insert(vocabularyTerms).values({
            id: newTermId,
            federationId: tenant.federationId,
            canonical: primaryFunctionText,
            category: null,
            status: "proposed",
            entityCount: 0,
            proposedBy: user.id,
            createdAt: now,
            updatedAt: now,
          });
          resolvedFunctionId = newTermId;
        }
      }

      const updatedFields = {
        ...updates,
        surname: updates.surname ?? null,
        givenName: updates.givenName ?? null,
        honorific: updates.honorific ?? null,
        primaryFunction: updates.primaryFunction ?? null,
        primaryFunctionId: resolvedFunctionId,
        datesOfExistence: updates.datesOfExistence ?? null,
        dateStart: updates.dateStart ?? null,
        dateEnd: updates.dateEnd ?? null,
        history: updates.history ?? null,
        functions: updates.functions ?? null,
        sources: updates.sources ?? null,
        wikidataId: updates.wikidataId ?? null,
        viafId: updates.viafId ?? null,
        notes: updates.notes ?? null,
        internalNotes: updates.internalNotes ?? null,
      };

      try {
        await db
          .update(entities)
          .set({
            ...updatedFields,
            updatedAt: Date.now(),
          })
          .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id)));

        // Update entity count on the vocabulary term
        if (resolvedFunctionId) {
          const [{ count: entityCountForTerm }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(entities)
            .where(
              and(
                eq(entities.federationId, tenant.federationId),
                eq(entities.primaryFunctionId, resolvedFunctionId)
              )
            )
            .all();
          await db
            .update(vocabularyTerms)
            .set({ entityCount: entityCountForTerm, updatedAt: Date.now() })
            .where(eq(vocabularyTerms.id, resolvedFunctionId));
        }
      } catch (e) {
        // Residual race: the term can still vanish between the
        // existence check above and the UPDATE. Surface it on the
        // field rather than as the generic failure.
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("FOREIGN KEY constraint failed")) {
          return {
            ok: false as const,
            errors: {
              primaryFunction: [
                "Selected function no longer exists; reselect or retype it",
              ],
            },
          };
        }
        return { ok: false as const, error: "generic" };
      }

      // Compute diff and create changelog entry
      if (original) {
        const { computeDiff, createChangelogEntry } = await import(
          "~/lib/changelog.server"
        );
        const diff = computeDiff(
          original as unknown as Record<string, unknown>,
          updatedFields as unknown as Record<string, unknown>
        );
        if (diff) {
          const commitNote =
            (formData.get("commitNote") as string)?.trim() || undefined;
          await createChangelogEntry(db, id, "entity", user.id, diff, commitNote);
        }
      }

      // Delete draft after successful save
      const { deleteDraft } = await import("~/lib/drafts.server");
      await deleteDraft(db, tenant.id, id, "entity");

      return { ok: true as const, message: "updated" };
    }

    case "delete": {
      await requireFederationSteward(db, user, tenant);
      // Server-side cascade check
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptionEntities)
        .where(eq(descriptionEntities.entityId, id))
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      // Snapshot the full row before deletion so the ledger row makes the
      // hard delete reconstructible (delete is unrecorded and unrecoverable
      // today). The delete + ledger insert share one batch: source_id is
      // the gone record's id and carries no FK, so ordering is free.
      const original = await db
        .select()
        .from(entities)
        .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id)))
        .get();
      if (!original) {
        return redirect("/admin/entities");
      }

      await db.batch([
        db
          .delete(entities)
          .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id))),
        logAuthorityOperation(db, {
          federationId: tenant.federationId,
          recordType: "entity",
          operation: "delete",
          sourceId: id,
          targetId: null,
          userId: user.id,
          detail: { snapshot: original },
        }),
      ] as any);
      return redirect("/admin/entities");
    }

    case "search-functions": {
      const q = (formData.get("q") as string)?.trim();
      if (!q || q.length < 2) return { searchResults: [] };
      const { like, isNull } = await import("drizzle-orm");
      const results = await db
        .select({
          id: vocabularyTerms.id,
          canonical: vocabularyTerms.canonical,
          category: vocabularyTerms.category,
        })
        .from(vocabularyTerms)
        .where(
          and(
            eq(vocabularyTerms.federationId, tenant.federationId),
            like(vocabularyTerms.canonical, `%${q}%`),
            isNull(vocabularyTerms.mergedInto),
            eq(vocabularyTerms.status, "approved")
          )
        )
        .limit(8)
        .all();
      return { searchResults: results };
    }

    case "search_descriptions": {
      const q = (formData.get("q") as string)?.trim();
      if (!q || q.length < 2) return Response.json({ results: [] });
      const results = await db
        .select({
          id: descriptions.id,
          title: descriptions.title,
          referenceCode: descriptions.referenceCode,
          descriptionLevel: descriptions.descriptionLevel,
        })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            sql`(${descriptions.title} LIKE ${"%" + q + "%"} OR ${descriptions.referenceCode} LIKE ${"%" + q + "%"})`
          )
        )
        .limit(20)
        .all();
      return Response.json({ results });
    }

    case "link_description": {
      const descriptionId = formData.get("descriptionId") as string;
      const role = formData.get("role") as string;
      if (!descriptionId || !role) {
        return { ok: false as const, error: "generic" };
      }
      const { ENTITY_ROLES } = await import("~/lib/validation/enums");
      if (!(ENTITY_ROLES as readonly string[]).includes(role)) {
        return { ok: false as const, error: "generic" };
      }
      const narrowedRole = role as (typeof ENTITY_ROLES)[number];
      try {
        await db.insert(descriptionEntities).values({
          id: crypto.randomUUID(),
          descriptionId,
          entityId: id,
          role: narrowedRole,
          sequence: 0,
          createdAt: Date.now(),
        });
      } catch (e) {
        if (String(e).includes("UNIQUE constraint failed")) {
          return { ok: false as const, error: "duplicate_link" };
        }
        return { ok: false as const, error: "generic" };
      }
      return { ok: true as const };
    }

    case "edit_description_link": {
      const linkId = formData.get("linkId") as string;
      const role = formData.get("role") as string;
      if (!linkId || !role) {
        return { ok: false as const, error: "generic" };
      }
      const { ENTITY_ROLES: roles } = await import("~/lib/validation/enums");
      if (!(roles as readonly string[]).includes(role)) {
        return { ok: false as const, error: "generic" };
      }
      const narrowedRole = role as (typeof roles)[number];
      const roleNote = (formData.get("roleNote") as string)?.trim() || null;
      const sequence = parseInt(formData.get("sequence") as string, 10) || 0;
      const honorific = (formData.get("honorific") as string)?.trim() || null;
      const func = (formData.get("function") as string)?.trim() || null;
      const nameAsRecorded =
        (formData.get("nameAsRecorded") as string)?.trim() || null;
      await db
        .update(descriptionEntities)
        .set({ role: narrowedRole, roleNote, sequence, honorific, function: func, nameAsRecorded })
        .where(eq(descriptionEntities.id, linkId));
      return { ok: true as const };
    }

    case "unlink_description": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) {
        return { ok: false as const, error: "generic" };
      }
      await db
        .delete(descriptionEntities)
        .where(eq(descriptionEntities.id, linkId));
      return { ok: true as const };
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EntityDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    entity,
    descLinkCount,
    mergeTarget,
    mergeBand,
    splitIntoBand,
    splitFromBand,
    links,
    total,
    allCount,
    roleCounts,
    repoCounts,
    repoSpan,
    wl,
    conflictDraft,
    functionTerm,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("entities");
  const { t: ta } = useTranslation("authorities");
  // Place-role labels for the context card's metadata strip live in the
  // places namespace (an entity's linked description can carry places).
  const { t: tp } = useTranslation("places");

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const hasDescriptions = descLinkCount > 0;
  const isMerged = !!entity.mergedInto;

  // Show conflict dialog when server returns optimistic lock error
  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error === "conflict") {
      setShowConflictDialog(true);
    }
  }, [actionData]);

  // Autosave via shared debounced-draft hook
  const { formRef, handleFormChange, draftStatus } = useAutosaveDraft(isEditing);

  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;
  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const successMessage =
    actionData && "message" in actionData && actionData.ok
      ? actionData.message
      : undefined;

  // Parse name variants for display
  let nameVariantsList: string[] = [];
  try {
    nameVariantsList = JSON.parse(entity.nameVariants || "[]");
  } catch {
    nameVariantsList = [];
  }

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Breadcrumb */}
      <AdminBreadcrumb
        rootTo="/admin/entities"
        rootLabel={t("title")}
        current={entity.displayName}
      />

      {/* Title row: name + code + type, and the record actions */}
      <AuthorityDetailHeader
        title={entity.displayName}
        isEditing={isEditing}
        isMerged={isMerged}
        hasDescriptions={hasDescriptions}
        descLinkCount={descLinkCount}
        mergeTo={`/admin/entities/${entity.id}/merge`}
        splitTo={`/admin/entities/${entity.id}/split`}
        onEdit={() => setIsEditing(true)}
        onDelete={() => setShowDeleteModal(true)}
        t={t}
      />
      <p className="mt-0.5 font-mono text-12 text-stone-500">
        {[
          entity.entityCode,
          entity.entityType === "person"
            ? t("person")
            : entity.entityType === "family"
              ? t("family")
              : t("corporate"),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
            namespace="entities"
          />
        </div>
      )}

      {/* Autosave status */}
      {isEditing && draftStatus && (
        <p className="mt-2 text-xs text-stone-400">
          {draftStatus === "saving"
            ? t("autosave_saving")
            : t("autosave_saved")}
        </p>
      )}

      {/* Superseded status band (ledger-derived) */}
      {isMerged && mergeTarget && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="merged"
            date={mergeBand?.date ?? ""}
            user={mergeBand?.user || ta("bandUnknownUser")}
            survivor={{
              id: mergeTarget.id,
              name: mergeTarget.displayName,
              href: `/admin/entities/${mergeTarget.id}`,
            }}
            ledgerHref={`/admin/entities/${entity.id}/history`}
            t={ta}
          />
        </div>
      )}

      {/* Informational split bands — the record stays live and editable */}
      {splitIntoBand && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="split"
            date={splitIntoBand.date}
            user={splitIntoBand.user || ta("bandUnknownUser")}
            records={splitIntoBand.targets.map((r) => ({
              id: r.id,
              name: r.displayName,
              href: `/admin/entities/${r.id}`,
            }))}
            ledgerHref={`/admin/entities/${entity.id}/history`}
            t={ta}
          />
        </div>
      )}
      {splitFromBand && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="splitFrom"
            date={splitFromBand.date}
            user={splitFromBand.user || ta("bandUnknownUser")}
            parent={{
              id: splitFromBand.parent.id,
              name: splitFromBand.parent.displayName,
              href: `/admin/entities/${splitFromBand.parent.id}`,
            }}
            ledgerHref={`/admin/entities/${entity.id}/history`}
            t={ta}
          />
        </div>
      )}

      {/* Success banner */}
      {successMessage === "updated" && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
          {t("successUpdated")}
        </div>
      )}

      {/* Error banner */}
      {globalError && globalError !== "conflict" && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "has_descriptions"
            ? t("deleteBlocked", { count: descLinkCount })
            : t("errorGeneric")}
        </div>
      )}

      {/* Two columns: the record on the left (always visible), the
          linked-descriptions worklist on the right. Toggling edit swaps
          only the left column's content — the worklist keeps its
          position in the tree and never remounts. */}
      <TwoColumnDetail
        left={
          isEditing ? (
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <EditMode
                entity={entity}
                nameVariantsList={nameVariantsList}
                functionTerm={functionTerm}
                errors={errors}
                t={t}
                onDiscard={() => setIsEditing(false)}
                formRef={formRef}
                onFormChange={handleFormChange}
              />
            </div>
          ) : (
            <ViewCards
              entity={entity}
              nameVariantsList={nameVariantsList}
              functionTerm={functionTerm}
              isMerged={isMerged}
              t={t}
            />
          )
        }
        right={
          <LinkedDescriptionsWorklist
            links={links}
            total={total}
            allCount={allCount}
            recordTotal={descLinkCount}
            roleCounts={roleCounts}
            repoCounts={repoCounts}
            repoSpan={repoSpan}
            dq={wl.dq}
            role={wl.role}
            repo={wl.repo}
            sort={wl.sort}
            size={wl.size}
            page={wl.page}
            isMerged={isMerged}
            roles={ENTITY_ROLES}
            recordId={entity.id}
            recordType="entity"
            showEntityFields={true}
            roleLabel={(r) => t(`role_${r}`)}
            placeRoleLabel={(r) => tp(`role_${r}`)}
            t={t}
            ta={ta}
          />
        }
      />

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowDeleteModal(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="delete-modal-title"
            aria-describedby="delete-modal-body"
            className="max-w-md rounded-lg bg-white p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-modal-title"
              className="font-serif text-lg font-semibold text-stone-700"
            >
              {t("deleteTitle")}
            </h2>
            <p
              id="delete-modal-body"
              className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto"
            >
              {t("deleteBody", { name: entity.displayName })}
            </p>
            <div className="mt-3">
              <label
                htmlFor="delete-confirm-input"
                className="mb-1 block text-xs font-medium text-indigo"
              >
                {t("field.entityCode")}: {entity.entityCode}
              </label>
              <input
                id="delete-confirm-input"
                type="text"
                autoComplete="off"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-madder focus:outline-none focus:ring-1 focus:ring-madder"
                value={deleteConfirmation}
                onChange={(e) => setDeleteConfirmation(e.target.value)}
              />
            </div>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmation("");
                }}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("mergeCancel")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  disabled={deleteConfirmation !== entity.entityCode}
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("deleteButton")}
                </button>
              </Form>
            </div>
          </div>
        </div>
      )}

      {/* Optimistic lock conflict dialog */}
      {showConflictDialog &&
        actionData &&
        "error" in actionData &&
        actionData.error === "conflict" && (
          <ConflictDialog
            modifiedByName=""
            modifiedAt={
              "modifiedAt" in actionData
                ? (actionData.modifiedAt as number)
                : null
            }
            recordUpdatedAt={entity.updatedAt}
            onCancel={() => setShowConflictDialog(false)}
            t={t}
          />
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode — always-visible cards with real values
// ---------------------------------------------------------------------------

function ViewCards({
  entity,
  nameVariantsList,
  functionTerm,
  isMerged,
  t,
}: {
  entity: any;
  nameVariantsList: string[];
  functionTerm: { id: string; canonical: string; status: string; category: string | null } | null;
  isMerged: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  // DBE has no stable public URL scheme on record — rendered as a
  // value, never an invented link.
  const lodLinks: Array<{
    label: string;
    value: string | null;
    href: ((id: string) => string) | null;
  }> = [
    {
      label: t("field.wikidataId"),
      value: entity.wikidataId,
      href: SERVICE_URLS.wikidata,
    },
    { label: t("field.viafId"), value: entity.viafId, href: SERVICE_URLS.viaf },
    { label: t("field.dbeId"), value: entity.dbeId, href: null },
  ];
  return (
    <div>
      {/* Identity */}
      <DetailCard title={t("sectionIdentity")} dimmed={isMerged}>
        <div className="space-y-2.5">
          <FieldDisplay
            label={t("field.displayName")}
            value={entity.displayName}
          />
          <FieldDisplay label={t("field.sortName")} value={entity.sortName} />
          <div className="grid grid-cols-3 gap-4">
            <FieldDisplay label={t("field.surname")} value={entity.surname} />
            <FieldDisplay
              label={t("field.givenName")}
              value={entity.givenName}
            />
            <FieldDisplay
              label={t("field.honorific")}
              value={entity.honorific}
            />
          </div>
          <FieldDisplay
            label={t("field.entityType")}
            value={
              entity.entityType === "person"
                ? t("person")
                : entity.entityType === "family"
                  ? t("family")
                  : t("corporate")
            }
          />
          <div>
            <p className="text-xs text-stone-500">{t("field.nameVariants")}</p>
            <VariantChips variants={nameVariantsList} />
          </div>
        </div>
      </DetailCard>

      {/* Description */}
      <DetailCard title={t("sectionDescription")} dimmed={isMerged}>
        <div className="space-y-2.5">
          <FieldDisplay
            label={t("field.datesOfExistence")}
            value={entity.datesOfExistence}
          />
          <div className="grid grid-cols-2 gap-4">
            <FieldDisplay
              label={t("field.dateStart")}
              value={entity.dateStart}
            />
            <FieldDisplay label={t("field.dateEnd")} value={entity.dateEnd} />
          </div>
          <FieldDisplay label={t("field.history")} value={entity.history} />
          <div>
            <p className="text-xs text-stone-500">
              {t("field.primaryFunction")}
            </p>
            <div className="flex items-center gap-2">
              <p className="text-sm text-stone-700">
                {functionTerm?.canonical ?? entity.primaryFunction ?? "—"}
              </p>
              {functionTerm?.status === "proposed" && (
                <span className="rounded-full bg-saffron-tint px-2 py-0.5 text-xs font-semibold text-saffron-deep">
                  Proposed
                </span>
              )}
            </div>
          </div>
          {/* legalStatus dropped in 0036 (0% populated). */}
          <FieldDisplay label={t("field.functions")} value={entity.functions} />
        </div>
      </DetailCard>

      {/* Control */}
      <DetailCard title={t("sectionControl")} dimmed={isMerged}>
        <FieldDisplay label={t("field.sources")} value={entity.sources} />
      </DetailCard>

      {/* Linked open data */}
      <DetailCard title={t("sectionLod")} dimmed={isMerged}>
        <div className="space-y-2.5">
          {lodLinks.map(({ label, value, href }) => (
            <div key={label}>
              <p className="text-xs text-stone-500">{label}</p>
              {value ? (
                href ? (
                  <a
                    href={href(value)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-13 font-semibold text-verdigris-deep hover:underline"
                  >
                    {value}
                  </a>
                ) : (
                  <p className="font-mono text-13 text-stone-700">{value}</p>
                )
              ) : (
                <p className="text-sm text-stone-700">{"—"}</p>
              )}
            </div>
          ))}
        </div>
      </DetailCard>

      {/* Notes — each card shows only when its value is non-empty. */}
      <NotesCards
        notes={entity.notes}
        internalNotes={entity.internalNotes}
        notesLabel={t("sectionNotes")}
        internalNotesLabel={t("sectionInternalNotes")}
        internalBadge={t("internalBadge")}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditMode({
  entity,
  nameVariantsList,
  functionTerm,
  errors,
  t,
  onDiscard,
  formRef,
  onFormChange,
}: {
  entity: any;
  nameVariantsList: string[];
  functionTerm: { id: string; canonical: string; status: string; category: string | null } | null;
  errors?: Record<string, string[]> | undefined;
  t: (key: string) => string;
  onDiscard: () => void;
  formRef?: React.Ref<HTMLFormElement>;
  onFormChange?: () => void;
}) {
  const [nameVariants, setNameVariants] = useState<string[]>(nameVariantsList);
  const [wikidataId, setWikidataId] = useState(entity.wikidataId || "");
  const [viafId, setViafId] = useState(entity.viafId || "");

  return (
    <Form method="post" ref={formRef} onChange={onFormChange}>
      <input type="hidden" name="_action" value="update" />
      <input
        type="hidden"
        name="_updatedAt"
        value={String(entity.updatedAt)}
      />
      <input
        type="hidden"
        name="nameVariants"
        value={JSON.stringify(nameVariants)}
      />
      <input type="hidden" name="wikidataId" value={wikidataId} />
      <input type="hidden" name="viafId" value={viafId} />

      {/* Identity area */}
      <CollapsibleSection title={t("sectionIdentity")}>
        <div className="space-y-4">
          <EditField
            name="displayName"
            label={t("field.displayName")}
            defaultValue={entity.displayName}
            required
            error={errors?.displayName?.[0]}
          />
          <EditField
            name="sortName"
            label={t("field.sortName")}
            defaultValue={entity.sortName}
            required
            error={errors?.sortName?.[0]}
          />
          <div className="grid grid-cols-3 gap-4">
            <EditField
              name="surname"
              label={t("field.surname")}
              defaultValue={entity.surname ?? ""}
              error={errors?.surname?.[0]}
            />
            <EditField
              name="givenName"
              label={t("field.givenName")}
              defaultValue={entity.givenName ?? ""}
              error={errors?.givenName?.[0]}
            />
            <EditField
              name="honorific"
              label={t("field.honorific")}
              defaultValue={entity.honorific ?? ""}
              error={errors?.honorific?.[0]}
            />
          </div>
          <div>
            <label
              htmlFor="entityType"
              className="mb-1 block text-xs font-medium text-indigo"
            >
              {t("field.entityType")}
              <span className="text-madder"> *</span>
            </label>
            <select
              id="entityType"
              name="entityType"
              defaultValue={entity.entityType}
              aria-required="true"
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            >
              <option value="person">{t("person")}</option>
              <option value="family">{t("family")}</option>
              <option value="corporate">{t("corporate")}</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.entityCode")}
            </label>
            <p className="text-sm text-stone-700">{entity.entityCode}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.nameVariants")}
            </label>
            <NameVariantInput
              value={nameVariants}
              onChange={setNameVariants}
              addLabel={t("addVariant")}
            />
          </div>
        </div>
      </CollapsibleSection>

      {/* Description area */}
      <CollapsibleSection title={t("sectionDescription")}>
        <div className="space-y-4">
          <EditField
            name="datesOfExistence"
            label={t("field.datesOfExistence")}
            defaultValue={entity.datesOfExistence ?? ""}
            error={errors?.datesOfExistence?.[0]}
          />
          <div className="grid grid-cols-2 gap-4">
            <EditField
              name="dateStart"
              label={t("field.dateStart")}
              defaultValue={entity.dateStart ?? ""}
              error={errors?.dateStart?.[0]}
            />
            <EditField
              name="dateEnd"
              label={t("field.dateEnd")}
              defaultValue={entity.dateEnd ?? ""}
              error={errors?.dateEnd?.[0]}
            />
          </div>
          <EditTextarea
            name="history"
            label={t("field.history")}
            defaultValue={entity.history ?? ""}
            error={errors?.history?.[0]}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.primaryFunction")}
            </label>
            <TypeaheadInput
              name="primaryFunction"
              defaultValue={functionTerm?.canonical ?? entity.primaryFunction ?? ""}
              defaultTermId={entity.primaryFunctionId ?? ""}
              defaultTermStatus={functionTerm?.status}
              searchEndpoint={`/admin/entities/${entity.id}`}
              placeholder={t("primary_function_placeholder")}
            />
            {errors?.primaryFunction?.[0] && (
              <p className="mt-1 text-xs text-madder">
                {errors.primaryFunction[0]}
              </p>
            )}
          </div>
          {/* legalStatus form field removed alongside the column
              drop in drizzle/0036_union_schema.sql (0% populated). */}
          <EditTextarea
            name="functions"
            label={t("field.functions")}
            defaultValue={entity.functions ?? ""}
            error={errors?.functions?.[0]}
          />
        </div>
      </CollapsibleSection>

      {/* Control area */}
      <CollapsibleSection title={t("sectionControl")}>
        <div className="space-y-4">
          <EditTextarea
            name="sources"
            label={t("field.sources")}
            defaultValue={entity.sources ?? ""}
            error={errors?.sources?.[0]}
          />
          <LodLinkField
            label={t("field.wikidataId")}
            value={wikidataId}
            onChange={setWikidataId}
            service="wikidata"
            error={errors?.wikidataId?.[0]}
          />
          <LodLinkField
            label={t("field.viafId")}
            value={viafId}
            onChange={setViafId}
            service="viaf"
            error={errors?.viafId?.[0]}
          />
        </div>
      </CollapsibleSection>

      {/* Notes area */}
      <CollapsibleSection title={t("sectionNotes")}>
        <NotesEditFields
          notes={entity.notes}
          internalNotes={entity.internalNotes}
          notesLabel={t("field.notes")}
          internalNotesLabel={t("field.internalNotes")}
          internalBadge={t("internalBadge")}
        />
      </CollapsibleSection>

      {/* Actions */}
      <div className="mt-6 space-y-3 border-t border-stone-200 pt-4">
        <input
          type="text"
          name="commitNote"
          placeholder={t("commit_note_placeholder")}
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
        />
        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("editSave")}
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("discardButton")}
          </button>
        </div>
      </div>
    </Form>
  );
}
