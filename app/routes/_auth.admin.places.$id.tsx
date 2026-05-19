/**
 * Places Admin — Edit
 *
 * This page is the edit form for a single place authority record. It edits every
 * Linked Places Format field -- label, display name, place type,
 * coordinates with precision, historical gobernación / partido /
 * region, modern country and admin-level divisions, name variants --
 * plus external authority links (Wikidata, Getty TGN, World Historical
 * Gazetteer, HGIS). Autosaves to `drafts` on a debounce; a conflict
 * banner appears if another user has an open draft on the same place.
 *
 * The linked-descriptions panel lists every archival record that
 * references this place and lets curators unlink or retarget links in
 * place. The merge workflow mirrors the entity merge: pick a canonical
 * target, confirm direction, server moves every `description_places`
 * row onto the canonical place.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Every read/update/delete of `places` is filtered
 * by `tenant.id`; the split-action insert attributes the new place
 * to `tenant.id` rather than a single-tenant hard-code.
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
import { CoordinateInput } from "~/components/forms/coordinate-input";
import { DraftsBanner } from "~/components/admin/drafts-banner";
import { LinkedDescriptionsCard } from "~/components/admin/linked-descriptions-card";
import { LinkDescriptionDialog } from "~/components/admin/link-description-dialog";
import { EditDescriptionLinkDialog } from "~/components/admin/edit-description-link-dialog";
import { PLACE_TYPES, PLACE_ROLES } from "~/lib/validation/enums";
import type { Route } from "./+types/_auth.admin.places.$id";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { places, descriptionPlaces, descriptions } = await import(
    "~/db/schema"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const place = await db
    .select()
    .from(places)
    .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)))
    .get();

  if (!place) {
    throw new Response("Not found", { status: 404 });
  }

  // Count linked descriptions via junction table
  const [{ count: descLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionPlaces)
    .where(eq(descriptionPlaces.placeId, id))
    .all();

  // Fetch first 5 description titles if any exist
  let descExamples: { title: string }[] = [];
  if (descLinkCount > 0) {
    descExamples = await db
      .select({ title: descriptions.title })
      .from(descriptionPlaces)
      .innerJoin(
        descriptions,
        eq(descriptionPlaces.descriptionId, descriptions.id)
      )
      .where(eq(descriptionPlaces.placeId, id))
      .limit(5)
      .all();
  }

  // Fetch merge target label if merged
  let mergeTarget: { id: string; label: string } | null = null;
  if (place.mergedInto) {
    const target = await db
      .select({ id: places.id, label: places.label })
      .from(places)
      .where(
        and(eq(places.tenantId, tenant.id), eq(places.id, place.mergedInto))
      )
      .get();
    if (target) mergeTarget = target;
  }

  // Fetch all description links for display and merge/split dialogs
  const descLinks = await db
    .select({
      id: descriptionPlaces.id,
      descriptionId: descriptionPlaces.descriptionId,
      role: descriptionPlaces.role,
      roleNote: descriptionPlaces.roleNote,
      descriptionTitle: descriptions.title,
      referenceCode: descriptions.referenceCode,
      descriptionLevel: descriptions.descriptionLevel,
    })
    .from(descriptionPlaces)
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id)
    )
    .where(eq(descriptionPlaces.placeId, id))
    .all();

  // Check for another user's draft on this record
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, id, "place", user.id);
  let conflictDraft: { userName: string; updatedAt: number } | null = null;
  if (conflictRaw) {
    const conflictUser = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, conflictRaw.userId))
      .get();
    conflictDraft = {
      userName: conflictUser?.name || "Unknown",
      updatedAt: conflictRaw.updatedAt,
    };
  }

  return {
    place,
    descLinkCount,
    descExamples,
    mergeTarget,
    descLinks,
    conflictDraft,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, sql } = await import("drizzle-orm");
  const { places, descriptionPlaces } = await import("~/db/schema");
  const { updatePlaceSchema } = await import("~/lib/validation/place");
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
        await saveDraft(db, id, "place", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      const label = (formData.get("label") as string)?.trim() || undefined;
      const displayName =
        (formData.get("displayName") as string)?.trim() || undefined;
      const placeType =
        (formData.get("placeType") as string)?.trim() || undefined;
      const nameVariantsRaw = formData.get("nameVariants") as string;
      const parentId =
        (formData.get("parentId") as string)?.trim() || undefined;
      // historical_gobernacion, historical_partido, historical_region,
      // country_code, admin_level_1, admin_level_2 all dropped in 0036
      // (0% populated in production audit).
      const coordinatePrecision =
        (formData.get("coordinatePrecision") as string)?.trim() || undefined;

      // Parse coordinates
      const latStr = (formData.get("latitude") as string)?.trim();
      const lngStr = (formData.get("longitude") as string)?.trim();
      const latitude = latStr ? parseFloat(latStr) : null;
      const longitude = lngStr ? parseFloat(lngStr) : null;

      // LOD identifiers
      const tgnId =
        (formData.get("tgnId") as string)?.trim() || undefined;
      const hgisId =
        (formData.get("hgisId") as string)?.trim() || undefined;
      const whgId =
        (formData.get("whgId") as string)?.trim() || undefined;
      // wikidata_id dropped from places in 0036.

      const parsed = updatePlaceSchema.safeParse({
        id,
        label,
        displayName,
        placeType: placeType || null,
        nameVariants: nameVariantsRaw || "[]",
        parentId: parentId || null,
        latitude: latitude != null && !isNaN(latitude) ? latitude : null,
        longitude: longitude != null && !isNaN(longitude) ? longitude : null,
        coordinatePrecision,
        tgnId: tgnId || null,
        hgisId: hgisId || null,
        whgId: whgId || null,
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
        .from(places)
        .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)))
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
      const updatedFields = {
        ...updates,
        nameVariants: updates.nameVariants ?? "[]",
        parentId: updates.parentId ?? null,
        latitude: updates.latitude ?? null,
        longitude: updates.longitude ?? null,
        tgnId: updates.tgnId ?? null,
        hgisId: updates.hgisId ?? null,
        whgId: updates.whgId ?? null,
      };

      try {
        await db
          .update(places)
          .set({
            ...updatedFields,
            updatedAt: Date.now(),
          })
          .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)));
      } catch (e) {
        if (String(e).includes("UNIQUE constraint failed")) {
          return { ok: false as const, error: "duplicate_code" };
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
          await createChangelogEntry(db, id, "place", user.id, diff, commitNote);
        }
      }

      // Delete draft after successful save
      const { deleteDraft } = await import("~/lib/drafts.server");
      await deleteDraft(db, id, "place");

      return { ok: true as const, message: "updated" };
    }

    case "delete": {
      // Server-side cascade check
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptionPlaces)
        .where(eq(descriptionPlaces.placeId, id))
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      await db
        .delete(places)
        .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)));
      return redirect("/admin/places");
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
        .from(places)
        .where(and(eq(places.tenantId, tenant.id), eq(places.id, targetId)))
        .get();
      if (!target) {
        return { ok: false as const, error: "generic" };
      }

      // Reassign each selected link
      for (const linkId of linkIds) {
        const link = await db
          .select()
          .from(descriptionPlaces)
          .where(eq(descriptionPlaces.id, linkId))
          .get();
        if (!link) continue;

        // Check for unique constraint conflict (dp_unique_idx)
        const conflict = await db
          .select({ id: descriptionPlaces.id })
          .from(descriptionPlaces)
          .where(
            and(
              eq(descriptionPlaces.descriptionId, link.descriptionId),
              eq(descriptionPlaces.placeId, targetId),
              eq(descriptionPlaces.role, link.role)
            )
          )
          .get();

        if (conflict) {
          // Delete redundant link
          await db
            .delete(descriptionPlaces)
            .where(eq(descriptionPlaces.id, linkId));
        } else {
          // Reassign to target
          await db
            .update(descriptionPlaces)
            .set({ placeId: targetId })
            .where(eq(descriptionPlaces.id, linkId));
        }
      }

      // Fetch source for audit notes
      const source = await db
        .select()
        .from(places)
        .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)))
        .get();

      const now = new Date().toISOString().slice(0, 10);

      // Set mergedInto on source + audit note (places don't have a sources field -- use label-level note approach)
      // Actually, the places schema doesn't have a sources field. We'll track merge in the existing fields.
      // For now, set mergedInto which is the canonical tracking field.
      await db
        .update(places)
        .set({
          mergedInto: targetId,
          updatedAt: Date.now(),
        })
        .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)));

      return redirect(`/admin/places/${targetId}`);
    }

    case "split": {
      let linkIds: string[] = [];
      try {
        linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
      } catch {
        linkIds = [];
      }

      // Fetch source place
      const source = await db
        .select()
        .from(places)
        .where(and(eq(places.tenantId, tenant.id), eq(places.id, id)))
        .get();
      if (!source) {
        return { ok: false as const, error: "generic" };
      }

      // Generate fresh code
      const newCode = await generateUniqueCode(
        db,
        "nl",
        places,
        places.placeCode
      );

      const newId = crypto.randomUUID();
      const timestamp = Date.now();

      // Create new place (copy all fields from source)
      await db.insert(places).values({
        tenantId: tenant.id,
        id: newId,
        placeCode: newCode,
        label: source.label,
        displayName: source.displayName,
        placeType: source.placeType,
        nameVariants: source.nameVariants,
        parentId: source.parentId,
        latitude: source.latitude,
        longitude: source.longitude,
        coordinatePrecision: source.coordinatePrecision,
        // historical_*, country_code, admin_level_*, wikidata_id all
        // dropped on places in 0036.
        needsGeocoding: source.needsGeocoding,
        mergedInto: null,
        tgnId: null,
        hgisId: null,
        whgId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      // Move selected links to new place
      for (const linkId of linkIds) {
        await db
          .update(descriptionPlaces)
          .set({ placeId: newId })
          .where(eq(descriptionPlaces.id, linkId));
      }

      return redirect(`/admin/places/${newId}`);
    }

    case "search_descriptions": {
      const { descriptions } = await import("~/db/schema");
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
      const { PLACE_ROLES } = await import("~/lib/validation/enums");
      if (!(PLACE_ROLES as readonly string[]).includes(role)) {
        return { ok: false as const, error: "generic" };
      }
      const narrowedRole = role as (typeof PLACE_ROLES)[number];
      try {
        await db.insert(descriptionPlaces).values({
          id: crypto.randomUUID(),
          descriptionId,
          placeId: id,
          role: narrowedRole,
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
      const { PLACE_ROLES: placeRoles } = await import("~/lib/validation/enums");
      if (!(placeRoles as readonly string[]).includes(role)) {
        return { ok: false as const, error: "generic" };
      }
      const narrowedRole = role as (typeof placeRoles)[number];
      const roleNote = (formData.get("roleNote") as string)?.trim() || null;
      await db
        .update(descriptionPlaces)
        .set({ role: narrowedRole, roleNote })
        .where(eq(descriptionPlaces.id, linkId));
      return { ok: true as const };
    }

    case "unlink_description": {
      const linkId = formData.get("linkId") as string;
      if (!linkId) {
        return { ok: false as const, error: "generic" };
      }
      await db
        .delete(descriptionPlaces)
        .where(eq(descriptionPlaces.id, linkId));
      return { ok: true as const };
    }

    default:
      return { ok: false as const, error: "generic" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PlaceDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const {
    place,
    descLinkCount,
    descExamples,
    mergeTarget,
    descLinks,
    conflictDraft,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("places");

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [showSplitDialog, setShowSplitDialog] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [confirmRemoveLinkId, setConfirmRemoveLinkId] = useState<string | null>(null);
  const unlinkFetcher = useFetcher();

  const isMerged = !!place.mergedInto;

  const hasDescriptions = descLinkCount > 0;

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

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/places"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{place.label}</li>
        </ol>
      </nav>

      {/* Title row */}
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-2xl font-semibold text-stone-700">
          {place.label}
        </h1>

        {!isEditing && !isMerged ? (
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
        ) : null}
      </div>

      {/* Draft conflict banner */}
      {conflictDraft && (
        <div className="mt-4">
          <DraftsBanner
            userName={conflictDraft.userName}
            updatedAt={conflictDraft.updatedAt}
            namespace="places"
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
      {place.mergedInto && mergeTarget && (
        <div className="mt-4 rounded-lg border border-saffron bg-saffron-tint px-4 py-3 text-sm text-saffron-deep">
          <p>
            {t("mergedBanner", { target: mergeTarget.label })}
            {" "}
            <Link
              to={`/admin/places/${mergeTarget.id}`}
              className="font-semibold text-indigo-deep hover:underline"
            >
              {t("mergedBannerLink")}
            </Link>
          </p>
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
          {globalError === "duplicate_code"
            ? t("errorDuplicateCode")
            : globalError === "has_descriptions"
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
        roles={PLACE_ROLES}
        entityOrPlaceId={place.id}
        recordType="place"
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
            }}
            roles={PLACE_ROLES}
            showEntityFields={false}
            t={t}
          />
        );
      })()}

      {/* Detail card */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        {isEditing ? (
          <EditMode
            place={place}
            errors={errors}
            t={t}
            onDiscard={() => setIsEditing(false)}
            formRef={formRef}
            onFormChange={handleFormChange}
          />
        ) : (
          <ViewMode place={place} t={t} />
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
              {t("deleteBody", { name: place.label })}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("mergeCancel")}
              </button>
              <Form method="post">
                <input type="hidden" name="_action" value="delete" />
                <button
                  type="submit"
                  className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
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
        sourceId={place.id}
        sourceName={place.label}
        entityType="place"
        links={descLinks}
        searchEndpoint="/admin/places"
        i18nNamespace="places"
      />

      {/* Split dialog */}
      <SplitDialog
        isOpen={showSplitDialog}
        onClose={() => setShowSplitDialog(false)}
        sourceId={place.id}
        sourceName={place.label}
        entityType="place"
        links={descLinks}
        i18nNamespace="places"
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
                    value={String(place.updatedAt)}
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
  place,
  t,
}: {
  place: Awaited<ReturnType<typeof loader>>["place"];
  t: (key: string) => string;
}) {
  const nameVariants: string[] = (() => {
    try {
      return JSON.parse(place.nameVariants || "[]");
    } catch {
      return [];
    }
  })();

  return (
    <div>
      {/* Identity */}
      <CollapsibleSection title={t("sectionIdentity")}>
        <div className="space-y-3">
          <FieldDisplay label={t("field.label")} value={place.label} />
          <FieldDisplay
            label={t("field.displayName")}
            value={place.displayName}
          />
          <FieldDisplay
            label={t("field.placeCode")}
            value={place.placeCode}
          />
          <FieldDisplay
            label={t("field.placeType")}
            value={place.placeType ? t(place.placeType) : null}
          />
          <div>
            <p className="text-xs text-stone-500">{t("field.nameVariants")}</p>
            {nameVariants.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {nameVariants.map((v, i) => (
                  <span
                    key={i}
                    className="inline-block rounded bg-stone-100 px-2 py-1 text-xs text-stone-700"
                  >
                    {v}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-stone-700">{"\u2014"}</p>
            )}
          </div>
          <FieldDisplay
            label={t("field.parentId")}
            value={place.parentId}
          />
        </div>
      </CollapsibleSection>

      {/* Historical Context section removed alongside the column
          drops in drizzle/0036_union_schema.sql \u2014
          historicalGobernacion, historicalPartido, historicalRegion
          all dropped (0% populated in production audit). */}

      {/* Modern Geography & LOD */}
      <CollapsibleSection title={t("sectionGeography")}>
        <div className="space-y-3">
          {/* countryCode, adminLevel1, adminLevel2, wikidataId all
              dropped on places in 0036 (0% populated). */}
          <div>
            <p className="text-xs text-stone-500">
              {t("field.latitude")} / {t("field.longitude")}
            </p>
            <p className="text-sm text-stone-700">
              {place.latitude != null && place.longitude != null
                ? `${place.latitude}, ${place.longitude} (${place.coordinatePrecision || "\u2014"})`
                : "\u2014"}
            </p>
          </div>
          <FieldDisplay label={t("field.tgnId")} value={place.tgnId} />
          <FieldDisplay label={t("field.hgisId")} value={place.hgisId} />
          <FieldDisplay label={t("field.whgId")} value={place.whgId} />
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
  value: string | number | null | undefined;
}) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-sm text-stone-700">
        {value != null && value !== "" ? String(value) : "\u2014"}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditMode({
  place,
  errors,
  t,
  onDiscard,
  formRef,
  onFormChange,
}: {
  place: Awaited<ReturnType<typeof loader>>["place"];
  errors?: Record<string, string[]> | undefined;
  t: (key: string) => string;
  onDiscard: () => void;
  formRef?: React.Ref<HTMLFormElement>;
  onFormChange?: () => void;
}) {
  const initialVariants: string[] = (() => {
    try {
      return JSON.parse(place.nameVariants || "[]");
    } catch {
      return [];
    }
  })();

  const [nameVariants, setNameVariants] = useState<string[]>(initialVariants);
  const [latitude, setLatitude] = useState<number | null>(place.latitude);
  const [longitude, setLongitude] = useState<number | null>(place.longitude);
  const [precision, setPrecision] = useState(
    place.coordinatePrecision || "approximate"
  );
  const [tgnId, setTgnId] = useState(place.tgnId || "");
  const [hgisId, setHgisId] = useState(place.hgisId || "");
  const [whgId, setWhgId] = useState(place.whgId || "");
  // wikidataId dropped on places in 0036 (0% populated).

  return (
    <Form method="post" ref={formRef} onChange={onFormChange}>
      <input type="hidden" name="_action" value="update" />
      <input
        type="hidden"
        name="_updatedAt"
        value={String(place.updatedAt)}
      />
      <input
        type="hidden"
        name="nameVariants"
        value={JSON.stringify(nameVariants)}
      />
      <input
        type="hidden"
        name="latitude"
        value={latitude != null ? String(latitude) : ""}
      />
      <input
        type="hidden"
        name="longitude"
        value={longitude != null ? String(longitude) : ""}
      />
      <input
        type="hidden"
        name="coordinatePrecision"
        value={precision}
      />
      <input type="hidden" name="tgnId" value={tgnId} />
      <input type="hidden" name="hgisId" value={hgisId} />
      <input type="hidden" name="whgId" value={whgId} />

      {/* Identity */}
      <CollapsibleSection title={t("sectionIdentity")}>
        <div className="space-y-4">
          <EditField
            name="label"
            label={t("field.label")}
            defaultValue={place.label}
            required
            error={errors?.label?.[0]}
          />
          <EditField
            name="displayName"
            label={t("field.displayName")}
            defaultValue={place.displayName}
            required
            error={errors?.displayName?.[0]}
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("field.placeCode")}
            </label>
            <input
              type="text"
              disabled
              value={place.placeCode || ""}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-400 disabled:cursor-not-allowed disabled:bg-stone-50"
            />
          </div>
          <div>
            <label
              htmlFor="placeType"
              className="mb-1 block text-xs font-medium text-indigo"
            >
              {t("field.placeType")}
              <span className="text-madder"> *</span>
            </label>
            <select
              id="placeType"
              name="placeType"
              defaultValue={place.placeType || ""}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            >
              <option value="">--</option>
              {PLACE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(type)}
                </option>
              ))}
            </select>
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
          <EditField
            name="parentId"
            label={t("field.parentId")}
            defaultValue={place.parentId || ""}
            error={errors?.parentId?.[0]}
          />
        </div>
      </CollapsibleSection>

      {/* Historical Context section removed alongside the column
          drops in drizzle/0036_union_schema.sql —
          historicalGobernacion, historicalPartido, historicalRegion
          all dropped (0% populated). */}

      {/* Modern Geography & LOD */}
      <CollapsibleSection title={t("sectionGeography")}>
        <div className="space-y-4">
          {/* countryCode, adminLevel1, adminLevel2 dropped on places
              in 0036 (0% populated). */}
          <CoordinateInput
            latitude={latitude}
            longitude={longitude}
            precision={precision}
            onLatChange={setLatitude}
            onLngChange={setLongitude}
            onPrecisionChange={setPrecision}
          />
          <LodLinkField
            label={t("field.tgnId")}
            value={tgnId}
            onChange={setTgnId}
            service="tgn"
          />
          <LodLinkField
            label={t("field.hgisId")}
            value={hgisId}
            onChange={setHgisId}
            service="hgis"
          />
          <LodLinkField
            label={t("field.whgId")}
            value={whgId}
            onChange={setWhgId}
            service="whg"
          />
          {/* wikidataId dropped on places in 0036 (0% populated). */}
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
