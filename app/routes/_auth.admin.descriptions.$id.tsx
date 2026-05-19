/**
 * Descriptions Admin — Edit
 *
 * The standard-aware editor for a single archival description.
 * Surfaces every section defined by the active descriptive standard
 * (resolved from `tenant.descriptiveStandard` via
 * `getStandardConfig`) plus the bibliographic, digital, and entity/
 * place linker primitives the renderer composes. Autosaves to
 * `drafts` on a debounce and writes a diff to `changelog` on
 * explicit save so every edit is auditable. A conflict banner warns
 * when another user holds an open draft on the same record.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `descriptions`,
 * `repositories`, and `users` is filtered by `tenant.id`;
 * description-entities and description-places joins inherit tenant
 * scope through the parent `descriptions.tenantId`.
 *
 * The `case "update"` branch invokes the standard-aware validator
 * factory
 * (`descriptionValidatorFor(tenant.descriptiveStandard,
 * desc.descriptionLevel)`) before the DB write — this is the single
 * write boundary the per-standard mandatoriness rules enforce. The
 * `case "autosave"` branch is INTENTIONALLY untouched: autosave
 * writes to the `drafts` table, which is a forgiving snapshot
 * store; only the explicit save path crosses into `descriptions` and
 * only that path enforces the validator.
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
import { ChevronRight, Pencil, Trash2, Plus, Image } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { DescriptionForm } from "~/components/descriptions/description-form";
import { ResizablePane } from "~/components/descriptions/resizable-pane";
import { AdminIiifViewer } from "~/components/descriptions/admin-iiif-viewer";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import { PublishToggle } from "~/components/descriptions/publish-toggle";
import type { Route } from "./+types/_auth.admin.descriptions.$id";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const {
    descriptions,
    repositories,
    descriptionEntities,
    descriptionPlaces,
    entities,
    places,
  } = await import("~/db/schema");
  const { getAllowedChildLevels } = await import(
    "~/lib/description-levels"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  // Schema-invariant guard — see action handler.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null",
    );
  }
  const descriptiveStandard = tenant.descriptiveStandard;

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  // Fetch description
  const description = await db
    .select()
    .from(descriptions)
    .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
    .get();

  if (!description) {
    throw new Response("Not found", { status: 404 });
  }

  // Fetch ancestor chain for breadcrumbs (limit to 10 to prevent infinite loops)
  const ancestors: { id: string; title: string; referenceCode: string }[] = [];
  let currentParentId = description.parentId;
  let depth = 0;
  while (currentParentId && depth < 10) {
    const ancestor = await db
      .select({
        id: descriptions.id,
        title: descriptions.title,
        referenceCode: descriptions.referenceCode,
        parentId: descriptions.parentId,
      })
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          eq(descriptions.id, currentParentId)
        )
      )
      .get();

    if (!ancestor) break;
    ancestors.unshift({
      id: ancestor.id,
      title: ancestor.title,
      referenceCode: ancestor.referenceCode,
    });
    currentParentId = ancestor.parentId;
    depth++;
  }

  // Fetch enabled repositories for edit mode
  const repoList = await db
    .select({ id: repositories.id, name: repositories.name })
    .from(repositories)
    .where(
      and(eq(repositories.tenantId, tenant.id), eq(repositories.enabled, true))
    )
    .all();

  // Fetch parent for level constraint in edit mode
  let parent: { descriptionLevel: string } | null = null;
  if (description.parentId) {
    parent =
      (await db
        .select({ descriptionLevel: descriptions.descriptionLevel })
        .from(descriptions)
        .where(
          and(
            eq(descriptions.tenantId, tenant.id),
            eq(descriptions.id, description.parentId)
          )
        )
        .get()) ?? null;
  }

  const allowedLevels = parent
    ? getAllowedChildLevels(parent.descriptionLevel)
    : getAllowedChildLevels(null);

  // Fetch entity links joined with entity display name
  const entityLinks = await db
    .select({
      id: descriptionEntities.id,
      descriptionId: descriptionEntities.descriptionId,
      entityId: descriptionEntities.entityId,
      role: descriptionEntities.role,
      roleNote: descriptionEntities.roleNote,
      sequence: descriptionEntities.sequence,
      honorific: descriptionEntities.honorific,
      function: descriptionEntities.function,
      nameAsRecorded: descriptionEntities.nameAsRecorded,
      createdAt: descriptionEntities.createdAt,
      entityDisplayName: entities.displayName,
      entityCode: entities.entityCode,
    })
    .from(descriptionEntities)
    .innerJoin(entities, eq(descriptionEntities.entityId, entities.id))
    .where(eq(descriptionEntities.descriptionId, id))
    .orderBy(descriptionEntities.sequence)
    .all();

  // Fetch place links joined with place label
  const placeLinks = await db
    .select({
      id: descriptionPlaces.id,
      descriptionId: descriptionPlaces.descriptionId,
      placeId: descriptionPlaces.placeId,
      role: descriptionPlaces.role,
      roleNote: descriptionPlaces.roleNote,
      createdAt: descriptionPlaces.createdAt,
      placeLabel: places.label,
      placeCode: places.placeCode,
    })
    .from(descriptionPlaces)
    .innerJoin(places, eq(descriptionPlaces.placeId, places.id))
    .where(eq(descriptionPlaces.descriptionId, id))
    .orderBy(descriptionPlaces.createdAt)
    .all();

  const entityLinkCount = entityLinks.length;
  const placeLinkCount = placeLinks.length;

  // Check for another user's draft on this record
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(
    db,
    id,
    "description",
    user.id
  );
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .where(
        and(eq(users.tenantId, tenant.id), eq(users.id, conflictRaw.userId))
      )
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  return {
    description,
    ancestors,
    repositories: repoList,
    parent,
    allowedLevels,
    entityLinkCount,
    placeLinkCount,
    entityLinks,
    placeLinks,
    conflictDraft,
    // Hand the active standard down to <DescriptionForm> so the
    // renderer picks the correct StandardConfig.
    descriptiveStandard,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql, and } = await import("drizzle-orm");
  const { descriptions, descriptionEntities, descriptionPlaces } =
    await import("~/db/schema");
  const { isValidChildLevel } = await import("~/lib/description-levels");
  const {
    DESCRIPTION_LEVELS,
    RESOURCE_TYPES,
    ENTITY_ROLES,
    PLACE_ROLES,
  } = await import("~/lib/validation/enums");
  const { z } = await import("zod/v4");
  const { descriptionValidatorFor } = await import(
    "~/lib/standards/validator-factory"
  );
  type DescriptionLevel =
    import("~/lib/standards/types").DescriptionLevel;

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "toggle_publish": {
      const desc = await db
        .select({ isPublished: descriptions.isPublished })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();

      if (!desc) {
        throw new Response("Not found", { status: 404 });
      }

      await db
        .update(descriptions)
        .set({
          isPublished: !desc.isPublished,
          updatedAt: Date.now(),
        })
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)));

      return { ok: true as const };
    }

    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, id, "description", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      // Parse all fields from form
      const getField = (name: string) =>
        ((formData.get(name) as string)?.trim() || null) as string | null;

      const title = getField("title");
      const descriptionLevel = getField("descriptionLevel");
      const localIdentifier = getField("localIdentifier");
      const repositoryId = getField("repositoryId");
      const translatedTitle = getField("translatedTitle");
      const uniformTitle = getField("uniformTitle");
      const resourceType = getField("resourceType");
      const genre = getField("genre");
      const dateExpression = getField("dateExpression");
      const dateStart = getField("dateStart");
      const dateEnd = getField("dateEnd");
      const dateCertainty = getField("dateCertainty");
      const extent = getField("extent");
      const dimensions = getField("dimensions");
      const medium = getField("medium");
      const provenance = getField("provenance");
      const scopeContent = getField("scopeContent");
      const ocrText = getField("ocrText");
      const arrangement = getField("arrangement");
      const accessConditions = getField("accessConditions");
      const reproductionConditions = getField("reproductionConditions");
      const language = getField("language");
      const locationOfOriginals = getField("locationOfOriginals");
      const locationOfCopies = getField("locationOfCopies");
      // relatedMaterials dropped in 0036 (0% populated).
      const findingAids = getField("findingAids");
      const notes = getField("notes");
      const internalNotes = getField("internalNotes");
      const imprint = getField("imprint");
      const editionStatement = getField("editionStatement");
      const seriesStatement = getField("seriesStatement");
      const volumeNumber = getField("volumeNumber");
      const issueNumber = getField("issueNumber");
      const pages = getField("pages");
      const sectionTitle = getField("sectionTitle");
      // Standard-aware columns surfaced through the validator. These
      // MUST also flow into `updatedFields` below — reading them
      // inline into `formObject` only would silently drop the values
      // on save (the validator would pass but the DB write would
      // omit them). Hoisting through `getField` matches the pattern
      // of every other field above so the formObject / updatedFields
      // pair stays parallel by inspection.
      const publicationTitle = getField("publicationTitle");
      const adminBiogHistory = getField("adminBiogHistory");
      const acquisitionInfo = getField("acquisitionInfo");
      const preferredCitation = getField("preferredCitation");
      const systemOfArrangement = getField("systemOfArrangement");
      const physicalCharacteristics = getField("physicalCharacteristics");
      const creatorDisplay = getField("creatorDisplay");
      const iiifManifestUrl = getField("iiifManifestUrl");
      const hasDigital = formData.get("hasDigital") === "on";

      // Pre-validate the descriptionLevel against the closed enum.
      // The standard-aware validator factory (below) trusts that the
      // level is one of `DescriptionLevel`; if a malicious payload
      // ships an arbitrary string, we want a clean field-level error
      // here rather than an obscure config-lookup throw downstream.
      const levelEnum = z.enum(DESCRIPTION_LEVELS);
      const levelParse = levelEnum.safeParse(descriptionLevel);
      if (!levelParse.success) {
        return {
          ok: false as const,
          errors: { descriptionLevel: ["required"] },
        };
      }

      // Validate level constraint if parent exists
      const desc = await db
        .select({
          parentId: descriptions.parentId,
          referenceCode: descriptions.referenceCode,
        })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();

      if (desc?.parentId) {
        const parent = await db
          .select({ descriptionLevel: descriptions.descriptionLevel })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.tenantId, tenant.id),
              eq(descriptions.id, desc.parentId)
            )
          )
          .get();

        if (
          parent &&
          !isValidChildLevel(
            parent.descriptionLevel,
            levelParse.data
          )
        ) {
          return {
            ok: false as const,
            errors: { descriptionLevel: ["invalid_level"] },
          };
        }
      }

      // Standard-aware validation. Build the full form payload as a
      // column-keyed object and run it through the per-standard
      // validator picked from `tenant.descriptiveStandard`. The
      // factory enforces every mandatory field for the (standard,
      // level) pair via Zod v4 `.check()` — collecting ALL
      // required-field issues in a single pass so the form surfaces
      // them together.
      const formObject: Record<string, unknown> = {
        title,
        descriptionLevel: levelParse.data,
        localIdentifier,
        repositoryId,
        translatedTitle,
        uniformTitle,
        resourceType,
        genre,
        dateExpression,
        dateStart,
        dateEnd,
        dateCertainty,
        extent,
        dimensions,
        medium,
        provenance,
        scopeContent,
        ocrText,
        arrangement,
        accessConditions,
        reproductionConditions,
        language,
        locationOfOriginals,
        locationOfCopies,
        findingAids,
        notes,
        internalNotes,
        imprint,
        editionStatement,
        seriesStatement,
        volumeNumber,
        issueNumber,
        pages,
        sectionTitle,
        publicationTitle,
        adminBiogHistory,
        acquisitionInfo,
        preferredCitation,
        systemOfArrangement,
        physicalCharacteristics,
        creatorDisplay,
        iiifManifestUrl,
        hasDigital,
      };

      // `tenants.descriptive_standard` is NOT NULL when
      // `kind = 'tenant'` per the schema CHECK in
      // drizzle/0034_tenants_table.sql. Operators with
      // `kind = 'platform'` never reach description CRUD routes (the
      // auth middleware blocks). The Drizzle inferred type is
      // nullable; we narrow with an explicit invariant throw rather
      // than silently defaulting.
      if (tenant.descriptiveStandard == null) {
        throw new Error(
          "Schema invariant violation: tenant.descriptiveStandard is null",
        );
      }
      const validator = descriptionValidatorFor(
        tenant.descriptiveStandard,
        levelParse.data as DescriptionLevel,
      );
      const stdParsed = validator.safeParse(formObject);
      if (!stdParsed.success) {
        return {
          ok: false as const,
          errors: z.flattenError(stdParsed.error).fieldErrors,
        };
      }

      // Check referenceCode uniqueness would not apply on update since
      // referenceCode is read-only in edit mode. But we keep the field
      // consistent in the DB.

      // Fetch original record before update for changelog diff
      const original = await db
        .select()
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();

      // Optimistic lock check: compare updatedAt from form vs DB
      const formUpdatedAt = formData.get("_updatedAt") as string;
      const forceOverwrite = formData.get("_force") === "true";
      if (
        !forceOverwrite &&
        formUpdatedAt &&
        original &&
        String(original.updatedAt) !== formUpdatedAt
      ) {
        // Find who modified it
        const { users } = await import("~/db/schema");
        let modifiedBy = "Unknown";
        if (original.updatedBy) {
          const modifier = await db
            .select({ name: users.name })
            .from(users)
            .where(
              and(eq(users.tenantId, tenant.id), eq(users.id, original.updatedBy))
            )
            .get();
          if (modifier?.name) modifiedBy = modifier.name;
        }
        return {
          ok: false as const,
          error: "conflict" as const,
          modifiedBy,
          modifiedAt: original.updatedAt,
        };
      }

      const updatedFields = {
        title: title ?? "",
        descriptionLevel: levelParse.data,
        localIdentifier,
        repositoryId: repositoryId ?? "",
        translatedTitle,
        uniformTitle,
        resourceType:
          resourceType &&
          RESOURCE_TYPES.includes(
            resourceType as (typeof RESOURCE_TYPES)[number]
          )
            ? (resourceType as (typeof RESOURCE_TYPES)[number])
            : null,
        genre: genre ?? "[]",
        dateExpression,
        dateStart,
        dateEnd,
        dateCertainty,
        extent,
        dimensions,
        medium,
        provenance,
        scopeContent,
        ocrText: ocrText ?? "",
        arrangement,
        accessConditions,
        reproductionConditions,
        language,
        locationOfOriginals,
        locationOfCopies,
        findingAids,
        notes,
        internalNotes,
        imprint,
        editionStatement,
        seriesStatement,
        volumeNumber,
        issueNumber,
        pages,
        sectionTitle,
        // Standard-aware columns. These MUST stay in lockstep with
        // the `formObject` constructor above and with `getField`
        // reads higher in this action — see the parallel-by-
        // inspection note. Adding a new standard-aware column
        // requires three touch-points: the `getField` block,
        // `formObject`, and this object.
        publicationTitle,
        adminBiogHistory,
        acquisitionInfo,
        preferredCitation,
        systemOfArrangement,
        physicalCharacteristics,
        creatorDisplay,
        iiifManifestUrl,
        hasDigital,
      };

      try {
        await db
          .update(descriptions)
          .set({
            ...updatedFields,
            updatedBy: user.id,
            updatedAt: Date.now(),
          })
          .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)));
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
          await createChangelogEntry(
            db,
            id,
            "description",
            user.id,
            diff,
            commitNote
          );
        }
      }

      // Delete draft after successful save
      const { deleteDraft } = await import("~/lib/drafts.server");
      await deleteDraft(db, id, "description");

      return { ok: true as const, message: "updated" };
    }

    case "delete": {
      // Check childCount > 0
      const desc = await db
        .select({ childCount: descriptions.childCount, parentId: descriptions.parentId })
        .from(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)))
        .get();

      if (!desc) {
        throw new Response("Not found", { status: 404 });
      }

      if (desc.childCount > 0) {
        return {
          ok: false as const,
          error: "delete_blocked",
          count: desc.childCount,
        };
      }

      // Delete description (entity/place links cascade per schema)
      await db
        .delete(descriptions)
        .where(and(eq(descriptions.tenantId, tenant.id), eq(descriptions.id, id)));

      // Decrement parent's childCount if parentId exists
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

      return redirect("/admin/descriptions");
    }

    // -----------------------------------------------------------------
    // Entity link actions
    // -----------------------------------------------------------------

    case "link_entity": {
      const linkSchema = z.object({
        descriptionId: z.string().uuid(),
        entityId: z.string().uuid(),
        role: z.enum(ENTITY_ROLES),
        sequence: z.coerce.number().int().min(0).default(0),
        honorific: z.string().max(100).optional(),
        function: z.string().max(300).optional(),
        nameAsRecorded: z.string().max(500).optional(),
      });
      const parsed = linkSchema.safeParse({
        descriptionId: formData.get("descriptionId"),
        entityId: formData.get("entityId"),
        role: formData.get("role"),
        sequence: formData.get("sequence"),
        honorific: (formData.get("honorific") as string)?.trim() || undefined,
        function: (formData.get("function") as string)?.trim() || undefined,
        nameAsRecorded:
          (formData.get("nameAsRecorded") as string)?.trim() || undefined,
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      try {
        await db.insert(descriptionEntities).values({
          id: crypto.randomUUID(),
          descriptionId: parsed.data.descriptionId,
          entityId: parsed.data.entityId,
          role: parsed.data.role,
          sequence: parsed.data.sequence,
          honorific: parsed.data.honorific ?? null,
          function: parsed.data.function ?? null,
          nameAsRecorded: parsed.data.nameAsRecorded ?? null,
          createdAt: Date.now(),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("UNIQUE constraint")) {
          return { ok: false as const, error: "duplicate_link" };
        }
        return { ok: false as const, error: "generic" };
      }
      return { ok: true as const, message: "entity_linked" };
    }

    case "update_entity_link": {
      const entityLinkSchema = z.object({
        linkId: z.string().uuid(),
        role: z.enum(ENTITY_ROLES),
        honorific: z.string().max(100).optional(),
        function: z.string().max(300).optional(),
        nameAsRecorded: z.string().max(500).optional(),
      });
      const parsed = entityLinkSchema.safeParse({
        linkId: formData.get("linkId"),
        role: formData.get("role"),
        honorific: (formData.get("honorific") as string)?.trim() || undefined,
        function: (formData.get("function") as string)?.trim() || undefined,
        nameAsRecorded:
          (formData.get("nameAsRecorded") as string)?.trim() || undefined,
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      await db
        .update(descriptionEntities)
        .set({
          role: parsed.data.role,
          honorific: parsed.data.honorific ?? null,
          function: parsed.data.function ?? null,
          nameAsRecorded: parsed.data.nameAsRecorded ?? null,
        })
        .where(eq(descriptionEntities.id, parsed.data.linkId));
      return { ok: true as const, message: "updated" };
    }

    case "remove_entity_link": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) return { ok: false as const, error: "generic" };
      await db
        .delete(descriptionEntities)
        .where(eq(descriptionEntities.id, linkId));
      return { ok: true as const, message: "link_removed" };
    }

    case "reorder_entity_link": {
      const linkId = formData.get("linkId") as string;
      const direction = formData.get("direction") as string;
      if (!linkId || !["up", "down"].includes(direction)) {
        return { ok: false as const, error: "generic" };
      }
      const current = await db
        .select()
        .from(descriptionEntities)
        .where(eq(descriptionEntities.id, linkId))
        .get();
      if (!current) return { ok: false as const, error: "generic" };

      const targetSeq =
        direction === "up" ? current.sequence - 1 : current.sequence + 1;

      const adjacent = await db
        .select()
        .from(descriptionEntities)
        .where(
          and(
            eq(descriptionEntities.descriptionId, current.descriptionId),
            eq(descriptionEntities.sequence, targetSeq)
          )
        )
        .get();

      if (!adjacent) return { ok: false as const, error: "generic" };

      // Swap sequences
      await db
        .update(descriptionEntities)
        .set({ sequence: adjacent.sequence })
        .where(eq(descriptionEntities.id, current.id));
      await db
        .update(descriptionEntities)
        .set({ sequence: current.sequence })
        .where(eq(descriptionEntities.id, adjacent.id));

      return { ok: true as const, message: "reordered" };
    }

    // -----------------------------------------------------------------
    // Place link actions
    // -----------------------------------------------------------------

    case "link_place": {
      const linkSchema = z.object({
        descriptionId: z.string().uuid(),
        placeId: z.string().uuid(),
        role: z.enum(PLACE_ROLES),
      });
      const parsed = linkSchema.safeParse({
        descriptionId: formData.get("descriptionId"),
        placeId: formData.get("placeId"),
        role: formData.get("role"),
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      try {
        await db.insert(descriptionPlaces).values({
          id: crypto.randomUUID(),
          descriptionId: parsed.data.descriptionId,
          placeId: parsed.data.placeId,
          role: parsed.data.role,
          createdAt: Date.now(),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("UNIQUE constraint")) {
          return { ok: false as const, error: "duplicate_link" };
        }
        return { ok: false as const, error: "generic" };
      }
      return { ok: true as const, message: "place_linked" };
    }

    case "update_place_link": {
      const placeLinkSchema = z.object({
        linkId: z.string().uuid(),
        role: z.enum(PLACE_ROLES),
      });
      const parsed = placeLinkSchema.safeParse({
        linkId: formData.get("linkId"),
        role: formData.get("role"),
      });
      if (!parsed.success) {
        return { ok: false as const, errors: parsed.error.flatten().fieldErrors };
      }
      await db
        .update(descriptionPlaces)
        .set({ role: parsed.data.role })
        .where(eq(descriptionPlaces.id, parsed.data.linkId));
      return { ok: true as const, message: "updated" };
    }

    case "remove_place_link": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) return { ok: false as const, error: "generic" };
      await db
        .delete(descriptionPlaces)
        .where(eq(descriptionPlaces.id, linkId));
      return { ok: true as const, message: "link_removed" };
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DescriptionDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    description,
    ancestors,
    repositories,
    allowedLevels,
    entityLinkCount,
    placeLinkCount,
    entityLinks,
    placeLinks,
    conflictDraft,
    descriptiveStandard,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("descriptions_admin");

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const hasChildren = description.childCount > 0;

  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;
  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const successMessage =
    actionData && "message" in actionData && actionData.ok
      ? actionData.message
      : undefined;

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

  // Clean up debounce on unmount or mode change
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

  // Collapse middle breadcrumb ancestors if > 4
  const showAllAncestors = ancestors.length <= 4;
  const visibleAncestors = showAllAncestors
    ? ancestors
    : [...ancestors.slice(0, 1), ...ancestors.slice(-2)];
  const collapsedCount = showAllAncestors ? 0 : ancestors.length - 3;

  // Right pane content: IIIF viewer or placeholder
  const rightPane = description.iiifManifestUrl ? (
    <AdminIiifViewer manifestUrl={description.iiifManifestUrl} />
  ) : (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Image className="h-16 w-16 text-stone-300" />
      <p className="mt-4 text-sm text-stone-500">{t("no_manifest")}</p>
      {isEditing && (
        <button
          type="button"
          onClick={() => {
            const field = document.querySelector<HTMLInputElement>(
              'input[name="iiifManifestUrl"]'
            );
            field?.scrollIntoView({ behavior: "smooth", block: "center" });
            field?.focus();
          }}
          className="mt-2 text-xs text-indigo-deep underline"
        >
          {t("add_manifest")}
        </button>
      )}
    </div>
  );

  return (
    <div className="px-8 py-6">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link
              to="/admin/descriptions"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("breadcrumb_root")}
            </Link>
          </li>
          {visibleAncestors.map((ancestor, i) => (
            <li key={ancestor.id} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-stone-400" />
              {/* Show collapsed indicator after first ancestor */}
              {!showAllAncestors && i === 1 && collapsedCount > 0 && (
                <>
                  <span className="text-stone-400">...</span>
                  <ChevronRight className="h-4 w-4 text-stone-400" />
                </>
              )}
              <Link
                to={`/admin/descriptions/${ancestor.id}`}
                className="text-stone-500 hover:text-stone-700"
              >
                {ancestor.title}
              </Link>
            </li>
          ))}
          <li className="flex items-center gap-1">
            <ChevronRight className="h-4 w-4 text-stone-400" />
            <span className="text-stone-700">{description.title}</span>
          </li>
        </ol>
      </nav>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">
          {description.title}
        </h1>

        {!isEditing && (
          <div className="flex gap-2">
            <Link
              to={`/admin/descriptions/new?parentId=${description.id}`}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Plus className="h-4 w-4" />
              {t("add_child")}
            </Link>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              <Pencil className="h-4 w-4" />
              {t("edit")}
            </button>
            <button
              type="button"
              onClick={() => !hasChildren && setShowDeleteModal(true)}
              disabled={hasChildren}
              aria-disabled={hasChildren ? "true" : undefined}
              title={
                hasChildren
                  ? t("error_delete_blocked", {
                      count: description.childCount,
                    })
                  : undefined
              }
              className={
                hasChildren
                  ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                  : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
              }
            >
              <Trash2 className="h-4 w-4" />
              {t("delete_description")}
            </button>
          </div>
        )}
      </div>

      {/* Level and ref code badges */}
      <div className="mt-2 flex items-center gap-3">
        <span className="rounded bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-500">
          {t(`level_${description.descriptionLevel}`)}
        </span>
        <span className="text-xs text-stone-500">
          {description.referenceCode}
        </span>
        <PublishToggle
          descriptionId={description.id}
          isPublished={description.isPublished ?? false}
          lastExportedAt={description.lastExportedAt}
          updatedAt={description.updatedAt}
        />
      </div>

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
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

      {/* Success banner */}
      {successMessage === "updated" && (
        <div className="mt-4 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
          {t("success_updated")}
        </div>
      )}

      {/* Error banner */}
      {globalError && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "delete_blocked"
            ? t("error_delete_blocked", {
                count:
                  actionData && "count" in actionData
                    ? actionData.count
                    : description.childCount,
              })
            : t("error_generic")}
        </div>
      )}

      {/* Split pane: form (left) + IIIF viewer (right) */}
      <div className="mt-4">
        <ResizablePane
          left={
            <Form method="post" ref={formRef} onChange={handleFormChange}>
              <input
                type="hidden"
                name="_updatedAt"
                value={String(description.updatedAt)}
              />
              <DescriptionForm
                description={description}
                isEditing={isEditing}
                repositories={repositories}
                allowedLevels={allowedLevels as string[]}
                errors={errors as Record<string, string[]> | undefined}
                entityLinks={entityLinks}
                placeLinks={placeLinks}
                standard={descriptiveStandard}
              />
            </Form>
          }
          right={rightPane}
        />
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-stone-700">
              {t("delete_description")}
            </h2>
            <p className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto">
              {t("error_delete_confirm", { title: description.title })}
            </p>
            {(entityLinkCount > 0 || placeLinkCount > 0) && (
              <p className="mt-2 text-sm text-madder">
                {t("error_delete_cascade", {
                  entityCount: entityLinkCount,
                  placeCount: placeLinkCount,
                })}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("delete_cancel")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
                >
                  {t("delete_description")}
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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
              <h2 className="text-lg font-semibold text-stone-700">
                {t("overwrite_confirm", {
                  name: "modifiedBy" in actionData ? actionData.modifiedBy : "",
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
                    value={String(description.updatedAt)}
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
