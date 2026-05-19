/**
 * Entities Admin — Edit
 *
 * This page is the edit form for a single entity authority record. It surfaces every
 * ISAAR(CPF)-adjacent field -- dates of existence, history, legal
 * status, functions over time, name variants, Wikidata / VIAF IDs,
 * merge pointer -- alongside the linked-descriptions panel that shows
 * every archival record this entity appears in and lets curators
 * unlink or retarget links without leaving the page. Autosaves to
 * `drafts` on a debounce; a conflict banner appears if another user
 * has an open draft on the same entity.
 *
 * The merge workflow is two-step: the curator picks a canonical
 * target, confirms the direction of the merge, and the server moves
 * every `description_entities` row onto the canonical entity while
 * leaving the superseded row in place with a `merged_into` pointer so
 * external references do not break.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `entities` and the
 * description-search subquery is filtered by `tenant.id`; the
 * split-action insert attributes the new entity to `tenant.id`
 * rather than a single-tenant hard-code.
 *
 * @version v0.4.0
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Form,
  useLoaderData,
  useActionData,
  useFetcher,
  redirect,
  Link,
} from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, Pencil, Trash2, Merge, Split, Plus } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { MergeDialog } from "~/components/admin/merge-dialog";
import { SplitDialog } from "~/components/admin/split-dialog";
import { NameVariantInput } from "~/components/forms/name-variant-input";
import { LodLinkField } from "~/components/forms/lod-link-field";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import { LinkedDescriptionsCard } from "~/components/admin/linked-descriptions-card";
import { LinkDescriptionDialog } from "~/components/admin/link-description-dialog";
import { EditDescriptionLinkDialog } from "~/components/admin/edit-description-link-dialog";
import { ENTITY_ROLES } from "~/lib/validation/enums";
import { TypeaheadInput } from "~/components/admin/typeahead-input";
import type { Route } from "./+types/_auth.admin.entities.$id";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities, descriptions, vocabularyTerms } = await import(
    "~/db/schema"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const entity = await db
    .select()
    .from(entities)
    .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)))
    .get();

  if (!entity) {
    throw new Response("Not found", { status: 404 });
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
      .where(eq(vocabularyTerms.id, entity.primaryFunctionId))
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

  // Fetch first 5 description titles if any exist
  let descExamples: { title: string }[] = [];
  if (descLinkCount > 0) {
    descExamples = await db
      .select({ title: descriptions.title })
      .from(descriptionEntities)
      .innerJoin(
        descriptions,
        eq(descriptionEntities.descriptionId, descriptions.id)
      )
      .where(eq(descriptionEntities.entityId, id))
      .limit(5)
      .all();
  }

  // If merged, fetch target entity's displayName
  let mergeTarget: { id: string; displayName: string } | null = null;
  if (entity.mergedInto) {
    const target = await db
      .select({ id: entities.id, displayName: entities.displayName })
      .from(entities)
      .where(
        and(eq(entities.tenantId, tenant.id), eq(entities.id, entity.mergedInto))
      )
      .get();
    if (target) {
      mergeTarget = target;
    }
  }

  // Fetch all description links for display and merge/split dialogs
  const descLinks = await db
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
    })
    .from(descriptionEntities)
    .innerJoin(
      descriptions,
      eq(descriptionEntities.descriptionId, descriptions.id)
    )
    .where(eq(descriptionEntities.entityId, id))
    .orderBy(descriptionEntities.sequence)
    .all();

  // Check for another user's draft on this record
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, id, "entity", user.id);
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.tenantId, tenant.id), eq(users.id, conflictRaw.userId)))
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  return {
    entity,
    descLinkCount,
    descExamples,
    mergeTarget,
    descLinks,
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
  const { generateUniqueCode } = await import("~/lib/codes.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, id, "entity", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
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
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)))
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
        // User selected an existing term
        resolvedFunctionId = primaryFunctionIdRaw;
      } else if (primaryFunctionText) {
        // User typed a value -- check if it matches an existing term (case-insensitive)
        const { like: likeFn, isNull: isNullFn } = await import("drizzle-orm");
        const existingTerm = await db
          .select({ id: vocabularyTerms.id })
          .from(vocabularyTerms)
          .where(
            and(
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
      };

      try {
        await db
          .update(entities)
          .set({
            ...updatedFields,
            updatedAt: Date.now(),
          })
          .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)));

        // Update entity count on the vocabulary term
        if (resolvedFunctionId) {
          const [{ count: entityCountForTerm }] = await db
            .select({ count: sql<number>`count(*)` })
            .from(entities)
            .where(
              and(
                eq(entities.tenantId, tenant.id),
                eq(entities.primaryFunctionId, resolvedFunctionId)
              )
            )
            .all();
          await db
            .update(vocabularyTerms)
            .set({ entityCount: entityCountForTerm, updatedAt: Date.now() })
            .where(eq(vocabularyTerms.id, resolvedFunctionId));
        }
      } catch {
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
      await deleteDraft(db, id, "entity");

      return { ok: true as const, message: "updated" };
    }

    case "delete": {
      // Server-side cascade check
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptionEntities)
        .where(eq(descriptionEntities.entityId, id))
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      await db
        .delete(entities)
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)));
      return redirect("/admin/entities");
    }

    case "merge": {
      const targetId = formData.get("targetId") as string;
      let linkIds: string[] = [];
      try {
        linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
      } catch {
        linkIds = [];
      }

      // Validate target exists
      const target = await db
        .select()
        .from(entities)
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, targetId)))
        .get();
      if (!target) {
        return { ok: false as const, error: "generic" };
      }

      // Reassign each selected link
      for (const linkId of linkIds) {
        const link = await db
          .select()
          .from(descriptionEntities)
          .where(eq(descriptionEntities.id, linkId))
          .get();
        if (!link) continue;

        // Check for unique constraint conflict
        const conflict = await db
          .select({ id: descriptionEntities.id })
          .from(descriptionEntities)
          .where(
            and(
              eq(descriptionEntities.descriptionId, link.descriptionId),
              eq(descriptionEntities.entityId, targetId),
              eq(descriptionEntities.role, link.role)
            )
          )
          .get();

        if (conflict) {
          // Delete redundant link
          await db
            .delete(descriptionEntities)
            .where(eq(descriptionEntities.id, linkId));
        } else {
          // Reassign to target
          await db
            .update(descriptionEntities)
            .set({ entityId: targetId })
            .where(eq(descriptionEntities.id, linkId));
        }
      }

      // Fetch source entity for audit notes
      const source = await db
        .select()
        .from(entities)
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)))
        .get();

      const now = new Date().toISOString().slice(0, 10);

      // Set mergedInto on source + audit note
      const sourceNote = `Merged into ${target.displayName} (${target.entityCode}) on ${now}`;
      await db
        .update(entities)
        .set({
          mergedInto: targetId,
          sources: source?.sources
            ? `${source.sources}\n${sourceNote}`
            : sourceNote,
          updatedAt: Date.now(),
        })
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)));

      // Audit note on target
      const targetNote = `Merged from ${source?.displayName} (${source?.entityCode}) on ${now}`;
      await db
        .update(entities)
        .set({
          sources: target.sources
            ? `${target.sources}\n${targetNote}`
            : targetNote,
          updatedAt: Date.now(),
        })
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, targetId)));

      return redirect(`/admin/entities/${targetId}`);
    }

    case "split": {
      let linkIds: string[] = [];
      try {
        linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
      } catch {
        linkIds = [];
      }

      // Fetch source entity
      const source = await db
        .select()
        .from(entities)
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)))
        .get();
      if (!source) {
        return { ok: false as const, error: "generic" };
      }

      // Generate fresh code
      const newCode = await generateUniqueCode(
        db,
        "ne",
        entities,
        entities.entityCode
      );

      const newId = crypto.randomUUID();
      const now = new Date().toISOString().slice(0, 10);
      const timestamp = Date.now();

      // Create new entity (copy all fields from source)
      const splitFromNote = `Split from ${source.displayName} (${source.entityCode}) on ${now}`;
      await db.insert(entities).values({
        tenantId: tenant.id,
        id: newId,
        entityCode: newCode,
        displayName: source.displayName,
        sortName: source.sortName,
        surname: source.surname,
        givenName: source.givenName,
        entityType: source.entityType,
        honorific: source.honorific,
        primaryFunction: source.primaryFunction,
        nameVariants: source.nameVariants,
        datesOfExistence: source.datesOfExistence,
        dateStart: source.dateStart,
        dateEnd: source.dateEnd,
        history: source.history,
        functions: source.functions,
        sources: splitFromNote,
        mergedInto: null,
        wikidataId: null,
        viafId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      // Move selected links to new entity
      for (const linkId of linkIds) {
        await db
          .update(descriptionEntities)
          .set({ entityId: newId })
          .where(eq(descriptionEntities.id, linkId));
      }

      // Audit note on source
      const splitIntoNote = `Split into ${source.displayName} (${newCode}) on ${now}`;
      await db
        .update(entities)
        .set({
          sources: source.sources
            ? `${source.sources}\n${splitIntoNote}`
            : splitIntoNote,
          updatedAt: timestamp,
        })
        .where(and(eq(entities.tenantId, tenant.id), eq(entities.id, id)));

      return redirect(`/admin/entities/${newId}`);
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
    descExamples,
    mergeTarget,
    descLinks,
    conflictDraft,
    functionTerm,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("entities");

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [showSplitDialog, setShowSplitDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [confirmRemoveLinkId, setConfirmRemoveLinkId] = useState<string | null>(null);
  const unlinkFetcher = useFetcher();

  const hasDescriptions = descLinkCount > 0;
  const isMerged = !!entity.mergedInto;

  // Show conflict dialog when server returns optimistic lock error
  useEffect(() => {
    if (actionData && "error" in actionData && actionData.error === "conflict") {
      setShowConflictDialog(true);
    }
  }, [actionData]);

  // Autosave via useFetcher
  const draftFetcher = useFetcher();
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const triggerAutosave = useCallback(() => {
    if (!formRef.current || !isEditing) return;
    const fd = new FormData(formRef.current);
    const snapshot: Record<string, string> = {};
    for (const [key, value] of fd.entries()) {
      if (!key.startsWith("_")) {
        snapshot[key] = value as string;
      }
    }
    draftFetcher.submit(
      { _action: "autosave", snapshot: JSON.stringify(snapshot) },
      { method: "post" }
    );
  }, [isEditing, draftFetcher]);

  const handleFormChange = useCallback(() => {
    if (!isEditing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(triggerAutosave, 2000);
  }, [isEditing, triggerAutosave]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isEditing]);

  const draftStatus =
    draftFetcher.state === "submitting"
      ? "saving"
      : draftFetcher.data && "autosaved" in draftFetcher.data
        ? "saved"
        : null;

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
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/entities"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{entity.displayName}</li>
        </ol>
      </nav>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">
          {entity.displayName}
        </h1>

        {!isEditing && !isMerged && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowMergeDialog(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Merge className="h-4 w-4" />
              {t("mergeButton")}
            </button>
            <button
              type="button"
              onClick={() => setShowSplitDialog(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Split className="h-4 w-4" />
              {t("splitButton")}
            </button>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Pencil className="h-4 w-4" />
              {t("editButton")}
            </button>
            <button
              type="button"
              onClick={() => !hasDescriptions && setShowDeleteModal(true)}
              disabled={hasDescriptions}
              aria-disabled={hasDescriptions ? "true" : undefined}
              title={
                hasDescriptions
                  ? t("deleteBlocked", { count: descLinkCount })
                  : undefined
              }
              className={
                hasDescriptions
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                  : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
              }
            >
              <Trash2 className="h-4 w-4" />
              {t("deleteButton")}
            </button>
          </div>
        )}
      </div>

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

      {/* Merge banner */}
      {isMerged && mergeTarget && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {t("mergedBanner", { target: mergeTarget.displayName })}{" "}
          <Link
            to={`/admin/entities/${mergeTarget.id}`}
            className="font-semibold text-indigo-deep hover:underline"
          >
            {t("mergedBannerLink")}
          </Link>
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

      {/* Linked descriptions section */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-sans text-sm font-semibold uppercase tracking-wide text-stone-500">
            {t("linked_descriptions")}
          </h2>
          <button
            type="button"
            onClick={() => setShowLinkDialog(true)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-deep hover:text-indigo"
          >
            <Plus className="h-4 w-4" />
            {t("add_description_link")}
          </button>
        </div>
        {descLinks.length === 0 ? (
          <p className="mt-3 text-sm text-stone-400">
            {t("no_linked_descriptions")}
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {descLinks.map((link) => (
              <div key={link.id}>
                {confirmRemoveLinkId === link.id ? (
                  <div className="flex items-center gap-3 rounded-md border border-madder bg-madder-tint px-4 py-3 text-sm">
                    <span className="text-stone-700">{t("remove_link_confirm")}</span>
                    <button
                      type="button"
                      onClick={() => {
                        unlinkFetcher.submit(
                          { _action: "unlink_description", linkId: link.id },
                          { method: "post" }
                        );
                        setConfirmRemoveLinkId(null);
                      }}
                      className="font-semibold text-madder hover:underline"
                    >
                      {t("remove_link")}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmRemoveLinkId(null)}
                      className="text-stone-500 hover:text-stone-700"
                    >
                      {t("mergeCancel")}
                    </button>
                  </div>
                ) : (
                  <LinkedDescriptionsCard
                    linkId={link.id}
                    descriptionId={link.descriptionId}
                    descriptionTitle={link.descriptionTitle}
                    referenceCode={link.referenceCode}
                    descriptionLevel={link.descriptionLevel}
                    role={link.role}
                    roleNote={link.roleNote}
                    sequence={link.sequence}
                    honorific={link.honorific}
                    function={link.function}
                    nameAsRecorded={link.nameAsRecorded}
                    onEdit={(id) => setEditingLinkId(id)}
                    onRemove={(id) => setConfirmRemoveLinkId(id)}
                    t={t}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Link description dialog */}
      <LinkDescriptionDialog
        isOpen={showLinkDialog}
        onClose={() => setShowLinkDialog(false)}
        roles={ENTITY_ROLES}
        entityOrPlaceId={entity.id}
        recordType="entity"
        t={t}
      />

      {/* Edit description link dialog */}
      {editingLinkId && (() => {
        const editLink = descLinks.find((l) => l.id === editingLinkId);
        if (!editLink) return null;
        return (
          <EditDescriptionLinkDialog
            isOpen={true}
            onClose={() => setEditingLinkId(null)}
            linkId={editingLinkId}
            currentValues={{
              role: editLink.role,
              roleNote: editLink.roleNote,
              sequence: editLink.sequence,
              honorific: editLink.honorific,
              function: editLink.function,
              nameAsRecorded: editLink.nameAsRecorded,
            }}
            roles={ENTITY_ROLES}
            showEntityFields={true}
            t={t}
          />
        );
      })()}

      {/* Detail card */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        {isEditing ? (
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
        ) : (
          <ViewMode
            entity={entity}
            nameVariantsList={nameVariantsList}
            functionTerm={functionTerm}
            t={t}
          />
        )}
      </div>

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
              className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto"
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

      {/* Merge dialog */}
      <MergeDialog
        isOpen={showMergeDialog}
        onClose={() => setShowMergeDialog(false)}
        sourceId={entity.id}
        sourceName={entity.displayName}
        entityType="entity"
        links={descLinks}
        searchEndpoint="/admin/entities"
        i18nNamespace="entities"
      />

      {/* Split dialog */}
      <SplitDialog
        isOpen={showSplitDialog}
        onClose={() => setShowSplitDialog(false)}
        sourceId={entity.id}
        sourceName={entity.displayName}
        entityType="entity"
        links={descLinks}
        i18nNamespace="entities"
      />

      {/* Optimistic lock conflict dialog */}
      {showConflictDialog &&
        actionData &&
        "error" in actionData &&
        actionData.error === "conflict" && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
              <h2 className="text-lg font-semibold text-stone-700">
                {t("overwrite_confirm", {
                  name: "",
                  time:
                    "modifiedAt" in actionData
                      ? new Date(
                          actionData.modifiedAt as number
                        ).toLocaleString()
                      : "",
                })}
              </h2>
              <div className="mt-4 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowConflictDialog(false)}
                  className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
                >
                  {t("overwrite_cancel")}
                </button>
                <Form method="post">
                  <input type="hidden" name="_action" value="update" />
                  <input type="hidden" name="_force" value="true" />
                  <input
                    type="hidden"
                    name="_updatedAt"
                    value={String(entity.updatedAt)}
                  />
                  <button
                    type="submit"
                    className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
                  >
                    {t("overwrite_button")}
                  </button>
                </Form>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

function ViewMode({
  entity,
  nameVariantsList,
  functionTerm,
  t,
}: {
  entity: any;
  nameVariantsList: string[];
  functionTerm: { id: string; canonical: string; status: string; category: string | null } | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div>
      {/* Identity area */}
      <CollapsibleSection title={t("sectionIdentity")}>
        <div className="space-y-3">
          <FieldDisplay
            label={t("field.displayName")}
            value={entity.displayName}
          />
          <FieldDisplay
            label={t("field.sortName")}
            value={entity.sortName}
          />
          <div className="grid grid-cols-3 gap-4">
            <FieldDisplay
              label={t("field.surname")}
              value={entity.surname}
            />
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
          <FieldDisplay
            label={t("field.entityCode")}
            value={entity.entityCode}
          />
          {nameVariantsList.length > 0 && (
            <div>
              <p className="text-xs text-stone-500">
                {t("field.nameVariants")}
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {nameVariantsList.map((v, i) => (
                  <span
                    key={i}
                    className="inline-block rounded bg-stone-100 px-2 py-1 text-xs text-stone-700"
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Description area */}
      <CollapsibleSection title={t("sectionDescription")}>
        <div className="space-y-3">
          <FieldDisplay
            label={t("field.datesOfExistence")}
            value={entity.datesOfExistence}
          />
          <div className="grid grid-cols-2 gap-4">
            <FieldDisplay
              label={t("field.dateStart")}
              value={entity.dateStart}
            />
            <FieldDisplay
              label={t("field.dateEnd")}
              value={entity.dateEnd}
            />
          </div>
          <FieldDisplay label={t("field.history")} value={entity.history} />
          <div>
            <p className="text-xs text-stone-500">{t("field.primaryFunction")}</p>
            <div className="flex items-center gap-2">
              <p className="text-sm text-stone-700">
                {functionTerm?.canonical ?? entity.primaryFunction ?? "\u2014"}
              </p>
              {functionTerm?.status === "proposed" && (
                <span className="rounded-full bg-saffron-tint px-2 py-0.5 text-xs font-semibold text-saffron-deep">
                  Proposed
                </span>
              )}
            </div>
          </div>
          {/* legalStatus dropped in 0036 (0% populated). */}
          <FieldDisplay
            label={t("field.functions")}
            value={entity.functions}
          />
        </div>
      </CollapsibleSection>

      {/* Relationships area */}
      {entity.mergedInto && (
        <CollapsibleSection title={t("sectionRelationships")}>
          <div className="space-y-3">
            <FieldDisplay
              label={t("field.mergedInto")}
              value={entity.mergedInto}
            />
          </div>
        </CollapsibleSection>
      )}

      {/* Control area */}
      <CollapsibleSection title={t("sectionControl")}>
        <div className="space-y-3">
          <FieldDisplay label={t("field.sources")} value={entity.sources} />
          <FieldDisplay
            label={t("field.wikidataId")}
            value={entity.wikidataId}
          />
          <FieldDisplay
            label={t("field.viafId")}
            value={entity.viafId}
          />
        </div>
      </CollapsibleSection>
    </div>
  );
}

function FieldDisplay({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-sm text-stone-700">{value || "\u2014"}</p>
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

function EditField({
  name,
  label,
  defaultValue,
  required,
  error,
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        {required && <span className="text-madder"> *</span>}
      </label>
      <input
        type="text"
        id={name}
        name={name}
        defaultValue={defaultValue}
        aria-required={required ? "true" : undefined}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}

function EditTextarea({
  name,
  label,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  defaultValue: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={3}
        defaultValue={defaultValue}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}
