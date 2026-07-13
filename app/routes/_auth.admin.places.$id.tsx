/**
 * Places Admin — record detail (two-column redesign)
 *
 * The authority record page for a single place (spec §5 redesign,
 * mockup 2026-07-11): a ~420px left column carries the record itself —
 * Identity, Geography (the shipped map preview ALWAYS on screen; the
 * shipped coordinate editor plus a geocoding search in edit mode), and
 * Linked open data (TGN/HGIS/WHG as external links) — while the right
 * column serves the linked descriptions as a WORKLIST: server-side
 * search over title/reference code (`?dq=`), role pills with real
 * GROUP BY counts (spec §11's per-record role filter), sort by
 * date/title/reference code, and honest offset pagination with a
 * user-selectable page size (25/50/100). The loader ships ONE filtered
 * page, never the whole link set. Narrow screens stack record-first.
 *
 * Edit swaps the left column to the existing inline form in place —
 * same fields, same autosave drafts, same optimistic lock, the
 * coordinate editor replacing the preview — without remounting the
 * right column. Merge and split live on their own workbench routes;
 * this action handles update/delete/autosave and the description-link
 * intents.
 *
 * Authority scope is the federation (migrations 0045-0048). Every
 * read/update/delete of `places` is filtered by `tenant.federationId`.
 * The description-search subquery stays `tenant.id`-scoped
 * (descriptions remain tenant-scoped).
 *
 * @version v0.4.3
 */

import { useState, useEffect } from "react";
import { Form, useActionData, redirect } from "react-router";
import { useTranslation } from "react-i18next";
import { MapPin } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { StatusBand } from "~/components/admin/status-band";
import {
  PlaceMapPreview,
  CoordinateMapEditor,
  NoCoordinatesWell,
} from "~/components/admin/place-maps";
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
import { EditField } from "~/components/admin/edit-field";
import {
  TwoColumnDetail,
  DetailCard,
  VariantChips,
  NotesCards,
  NotesEditFields,
} from "~/components/admin/authority-detail-layout";
import { LinkedDescriptionsWorklist } from "~/components/admin/linked-descriptions-worklist";
import { GeocodeSearch } from "~/components/admin/geocode-search";
import { parseWorklistParams } from "~/lib/worklist-params";
import {
  PLACE_TYPES,
  PLACE_ROLES,
  COORDINATE_PRECISIONS,
} from "~/lib/validation/enums";
import type { Route } from "./+types/_auth.admin.places.$id";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, or, like, asc, sql } = await import("drizzle-orm");
  const { places, descriptionPlaces, descriptions, repositories } =
    await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const id = params.id;

  const place = await db
    .select()
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
    .get();

  if (!place) {
    throw new Response("Not found", { status: 404 });
  }

  // Click-to-unfold context card (spec §5 worklist enhancement):
  // fetched on demand by junction id, never eager-loaded for the page.
  // Ownership is enforced in the helper — a junction id belonging to
  // another place resolves to null (an IDOR surface), so the response
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
        recordType: "place",
        ownerId: id,
        junctionId: cardJunctionId,
      });
      return Response.json({ ocrFull });
    }
    const { loadLinkedDescriptionCard } = await import(
      "~/lib/authority-linked-context.server"
    );
    const card = await loadLinkedDescriptionCard(db, {
      recordType: "place",
      ownerId: id,
      displayName: place.displayName,
      junctionId: cardJunctionId,
    });
    return Response.json({ card });
  }

  // Unfiltered link total — drives the header count and the
  // delete-blocked affordance.
  const [{ count: descLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionPlaces)
    .where(eq(descriptionPlaces.placeId, id))
    .all();

  // ---- Linked-descriptions worklist (spec §5 redesign; round-3 filters) ----
  const sp = new URL(request.url).searchParams;
  const wl = parseWorklistParams(sp);
  // An off-vocabulary role param is ignored, never an empty worklist.
  const role =
    wl.role && (PLACE_ROLES as readonly string[]).includes(wl.role)
      ? (wl.role as (typeof PLACE_ROLES)[number])
      : null;

  // The record's OWN repository ids (unfiltered): drives repo-pill
  // progressive disclosure (shown only when the links span > 1 repo) and
  // validates the `?repo=` param — an id that is not one of the record's
  // is ignored, never an empty worklist. Keyed by id, not label.
  const recordRepoRows = await db
    .select({ repositoryId: descriptions.repositoryId })
    .from(descriptionPlaces)
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id),
    )
    .where(eq(descriptionPlaces.placeId, id))
    .groupBy(descriptions.repositoryId)
    .all();
  const recordRepoIds = new Set(recordRepoRows.map((r) => r.repositoryId));
  const repoSpan = recordRepoIds.size;
  const repo = wl.repo && recordRepoIds.has(wl.repo) ? wl.repo : null;

  // Search predicate over the joined description (title + reference
  // code), shared by the counts, the filtered total, and the page.
  const dqConditions: any[] = [eq(descriptionPlaces.placeId, id)];
  if (wl.dq) {
    const pat = `%${wl.dq}%`;
    dqConditions.push(
      or(
        like(descriptions.title, pat),
        like(descriptions.referenceCode, pat),
      )!,
    );
  }

  // Cross-honest counts (spec §3): role counts are computed under the
  // search AND the repository filter; repo counts under the search AND
  // the role filter — each pill shows what selecting it would yield given
  // everything else already chosen.
  const roleCountConditions = repo
    ? [...dqConditions, eq(descriptions.repositoryId, repo)]
    : dqConditions;
  const roleCounts = await db
    .select({
      role: descriptionPlaces.role,
      count: sql<number>`count(*)`,
    })
    .from(descriptionPlaces)
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id),
    )
    .where(and(...roleCountConditions))
    .groupBy(descriptionPlaces.role)
    .orderBy(sql`count(*) DESC`)
    .all();
  const allCount = roleCounts.reduce((sum, rc) => sum + rc.count, 0);

  // Repo pills: GROUP BY repository id, labelled short_name → code → name
  // (COALESCE(NULLIF(...)) — the AHRB repository's short_name is empty at
  // 13k-link scale), under the search + role filter.
  const repoCountConditions = role
    ? [...dqConditions, eq(descriptionPlaces.role, role)]
    : dqConditions;
  const repoCounts = await db
    .select({
      repositoryId: descriptions.repositoryId,
      label: sql<string>`COALESCE(NULLIF(${repositories.shortName}, ''), NULLIF(${repositories.code}, ''), ${repositories.name})`,
      count: sql<number>`count(*)`,
    })
    .from(descriptionPlaces)
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id),
    )
    .innerJoin(repositories, eq(descriptions.repositoryId, repositories.id))
    .where(and(...repoCountConditions))
    .groupBy(descriptions.repositoryId)
    .orderBy(sql`count(*) DESC`)
    .all();

  // Honest filtered total (search + role + repo) from a real COUNT.
  const filterConditions: any[] = [...dqConditions];
  if (role) filterConditions.push(eq(descriptionPlaces.role, role));
  if (repo) filterConditions.push(eq(descriptions.repositoryId, repo));
  const [{ count: total }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionPlaces)
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id),
    )
    .where(and(...filterConditions))
    .all();

  // One page, sorted server-side. Date sorts newest-first with undated
  // rows last; title and reference code sort ascending. The junction id
  // breaks ties so paging is stable.
  const orderBy =
    wl.sort === "title"
      ? [asc(descriptions.title), asc(descriptionPlaces.id)]
      : wl.sort === "code"
        ? [asc(descriptions.referenceCode), asc(descriptionPlaces.id)]
        : [
            sql`${descriptions.dateStart} IS NULL`,
            sql`${descriptions.dateStart} DESC`,
            asc(descriptionPlaces.id),
          ];
  const links = await db
    .select({
      id: descriptionPlaces.id,
      descriptionId: descriptionPlaces.descriptionId,
      role: descriptionPlaces.role,
      roleNote: descriptionPlaces.roleNote,
      descriptionTitle: descriptions.title,
      referenceCode: descriptions.referenceCode,
      descriptionLevel: descriptions.descriptionLevel,
      dateExpression: descriptions.dateExpression,
      dateStart: descriptions.dateStart,
      dateEnd: descriptions.dateEnd,
      creatorDisplay: descriptions.creatorDisplay,
      placeDisplay: descriptions.placeDisplay,
    })
    .from(descriptionPlaces)
    .innerJoin(
      descriptions,
      eq(descriptionPlaces.descriptionId, descriptions.id),
    )
    .where(and(...filterConditions))
    .orderBy(...orderBy)
    .limit(wl.size)
    .offset((wl.page - 1) * wl.size)
    .all();

  // Fetch merge target label if merged
  let mergeTarget: { id: string; label: string } | null = null;
  let mergeBand: { date: string; user: string } | null = null;
  if (place.mergedInto) {
    const target = await db
      .select({ id: places.id, label: places.label })
      .from(places)
      .where(
        and(eq(places.federationId, tenant.federationId), eq(places.id, place.mergedInto))
      )
      .get();
    if (target) mergeTarget = target;
    const { getOperationActor, bandDate } = await import(
      "~/lib/authority-workbench.server"
    );
    const actor = await getOperationActor(db, {
      recordType: "place",
      operation: "merge",
      sourceId: params.id,
      targetId: place.mergedInto,
    });
    if (actor) {
      mergeBand = { date: bandDate(actor.createdAt), user: actor.userName ?? "" };
    }
  }

  // Informational split bands (spec §4 — both halves stay live and
  // editable). The merged band takes precedence when the record was
  // later merged away.
  let splitIntoBand: {
    date: string;
    user: string;
    targets: { id: string; label: string }[];
  } | null = null;
  let splitFromBand: {
    date: string;
    user: string;
    parent: { id: string; label: string };
  } | null = null;
  if (!place.mergedInto) {
    const { getOperationActor, getSplitTargets, bandDate } = await import(
      "~/lib/authority-workbench.server"
    );
    const { inArray } = await import("drizzle-orm");

    const targetIds = await getSplitTargets(db, "place", id);
    if (targetIds.length > 0) {
      const targets = await db
        .select({ id: places.id, label: places.label })
        .from(places)
        .where(
          and(
            eq(places.federationId, tenant.federationId),
            inArray(places.id, targetIds),
          ),
        )
        .all();
      const actor = await getOperationActor(db, {
        recordType: "place",
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
      recordType: "place",
      operation: "split",
      targetId: id,
    });
    if (fromActor) {
      const parent = await db
        .select({ id: places.id, label: places.label })
        .from(places)
        .where(
          and(
            eq(places.federationId, tenant.federationId),
            eq(places.id, fromActor.sourceId),
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

  // Check for another user's draft on this record. Places are
  // federation-shared (migrations 0045-0048), so the conflicting editor may
  // legitimately live in ANY tenant of the session tenant's federation —
  // resolve their name through the tenants join scoped to the
  // federation, not to the session tenant alone (a same-federation
  // cross-tenant editor must not render as "Unknown").
  const { getConflictDraft } = await import("~/lib/drafts.server");
  const { users, tenants } = await import("~/db/schema");
  const conflictRaw = await getConflictDraft(db, tenant.id, id, "place", user.id);
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
    place,
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
    maptilerKey: env.MAPTILER_KEY,
  };
}

// The loader has two shapes: the full page payload and the on-demand
// card JSON (`?card=`). The card branch returns a bare Response, so the
// page-render helpers narrow to the object form.
type PlaceLoaderData = Exclude<Awaited<ReturnType<typeof loader>>, Response>;

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, sql } = await import("drizzle-orm");
  const { places, descriptionPlaces } = await import("~/db/schema");
  const { updatePlaceSchema } = await import("~/lib/validation/place");
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
  // below to the canonical place mutations (update, delete, merge, split)
  // — each requires a federation steward. NOT applied to autosave
  // (drafts), the read search, or the description-link intents, which
  // stay open to member-tenant admins (READ + member-side junction ops).
  const { requireFederationSteward } = await import("~/lib/federation.server");

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "autosave": {
      const { saveDraft } = await import("~/lib/drafts.server");
      const snapshot = formData.get("snapshot") as string;
      if (snapshot) {
        await saveDraft(db, tenant.id, id, "place", user.id, snapshot);
      }
      return { ok: true as const, autosaved: true };
    }

    case "update": {
      await requireFederationSteward(db, user, tenant);
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
      // Empty-string → null coercion at the form boundary: the select's
      // unset option submits "", which is NOT a vocabulary member, so it
      // must reach the z.enum as null (not recorded).
      const coordinatePrecision =
        (formData.get("coordinatePrecision") as string)?.trim() || null;
      const notes = (formData.get("notes") as string)?.trim() || null;
      const internalNotes =
        (formData.get("internalNotes") as string)?.trim() || null;

      // Parse coordinates. A present-but-unparseable value is a
      // FIELD ERROR, never a silent null — dropping a mistyped
      // coordinate would masquerade as a deliberate removal. Range
      // bounds (lat -90..90, lng -180..180) are enforced by the Zod
      // schema below.
      const latStr = (formData.get("latitude") as string)?.trim();
      const lngStr = (formData.get("longitude") as string)?.trim();
      const latitude = latStr ? parseFloat(latStr) : null;
      const longitude = lngStr ? parseFloat(lngStr) : null;
      const coordErrors: Record<string, string[]> = {};
      if (latStr && isNaN(latitude!)) {
        coordErrors.latitude = ["Latitude must be a number"];
      }
      if (lngStr && isNaN(longitude!)) {
        coordErrors.longitude = ["Longitude must be a number"];
      }
      if (Object.keys(coordErrors).length > 0) {
        return { ok: false as const, errors: coordErrors };
      }

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
        latitude,
        longitude,
        coordinatePrecision,
        tgnId: tgnId || null,
        hgisId: hgisId || null,
        whgId: whgId || null,
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
        .from(places)
        .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
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
      const updatedFields: Record<string, unknown> = {
        ...updates,
        nameVariants: updates.nameVariants ?? "[]",
        parentId: updates.parentId ?? null,
        latitude: updates.latitude ?? null,
        longitude: updates.longitude ?? null,
        coordinatePrecision: updates.coordinatePrecision ?? null,
        tgnId: updates.tgnId ?? null,
        hgisId: updates.hgisId ?? null,
        whgId: updates.whgId ?? null,
        notes: updates.notes ?? null,
        internalNotes: updates.internalNotes ?? null,
      };

      try {
        await db
          .update(places)
          .set({
            ...updatedFields,
            updatedAt: Date.now(),
          })
          .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)));
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
      await deleteDraft(db, tenant.id, id, "place");

      return { ok: true as const, message: "updated" };
    }

    case "delete": {
      await requireFederationSteward(db, user, tenant);
      // Server-side cascade check
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(descriptionPlaces)
        .where(eq(descriptionPlaces.placeId, id))
        .all();

      if (count > 0) {
        return { ok: false as const, error: "has_descriptions" };
      }

      // Snapshot the full row before deletion so the ledger row makes the
      // hard delete reconstructible (delete is unrecorded and
      // unrecoverable today). Delete + ledger insert share one batch.
      const original = await db
        .select()
        .from(places)
        .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
        .get();
      if (!original) {
        return redirect("/admin/places");
      }

      await db.batch([
        db
          .delete(places)
          .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id))),
        logAuthorityOperation(db, {
          federationId: tenant.federationId,
          recordType: "place",
          operation: "delete",
          sourceId: id,
          targetId: null,
          userId: user.id,
          detail: { snapshot: original },
        }),
      ] as any);
      return redirect("/admin/places");
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
    maptilerKey,
  } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("places");
  const { t: ta } = useTranslation("authorities");

  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);

  const isMerged = !!place.mergedInto;
  const hasDescriptions = descLinkCount > 0;

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
    nameVariantsList = JSON.parse(place.nameVariants || "[]");
  } catch {
    nameVariantsList = [];
  }

  return (
    <div className="mx-auto max-w-7xl px-8 py-12">
      {/* Breadcrumb */}
      <AdminBreadcrumb
        rootTo="/admin/places"
        rootLabel={t("title")}
        current={place.label}
      />

      {/* Title row: name + code + type, and the record actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <AuthorityDetailHeader
            title={place.label}
            isEditing={isEditing}
            isMerged={isMerged}
            hasDescriptions={hasDescriptions}
            descLinkCount={descLinkCount}
            mergeTo={`/admin/places/${place.id}/merge`}
            splitTo={`/admin/places/${place.id}/split`}
            onEdit={() => setIsEditing(true)}
            onDelete={() => setShowDeleteModal(true)}
            t={t}
          />
          <p className="mt-0.5 font-mono text-12 text-stone-500">
            {[place.placeCode, place.placeType ? t(place.placeType) : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
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

      {/* Superseded status band (ledger-derived) */}
      {place.mergedInto && mergeTarget && (
        <div className="mt-4 overflow-hidden rounded-md">
          <StatusBand
            variant="merged"
            date={mergeBand?.date ?? ""}
            user={mergeBand?.user || ta("bandUnknownUser")}
            survivor={{
              id: mergeTarget.id,
              name: mergeTarget.label,
              href: `/admin/places/${mergeTarget.id}`,
            }}
            ledgerHref={`/admin/places/${place.id}/history`}
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
              name: r.label,
              href: `/admin/places/${r.id}`,
            }))}
            ledgerHref={`/admin/places/${place.id}/history`}
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
              name: splitFromBand.parent.label,
              href: `/admin/places/${splitFromBand.parent.id}`,
            }}
            ledgerHref={`/admin/places/${place.id}/history`}
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
          {globalError === "duplicate_code"
            ? t("errorDuplicateCode")
            : globalError === "has_descriptions"
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
                place={place}
                nameVariantsList={nameVariantsList}
                errors={errors}
                maptilerKey={maptilerKey}
                t={t}
                onDiscard={() => setIsEditing(false)}
                formRef={formRef}
                onFormChange={handleFormChange}
              />
            </div>
          ) : (
            <ViewCards
              place={place}
              nameVariantsList={nameVariantsList}
              maptilerKey={maptilerKey}
              isMerged={isMerged}
              onSetCoords={() => setIsEditing(true)}
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
            roles={PLACE_ROLES}
            recordId={place.id}
            recordType="place"
            showEntityFields={false}
            roleLabel={(r) => t(`role_${r}`)}
            placeRoleLabel={(r) => t(`role_${r}`)}
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
            recordUpdatedAt={place.updatedAt}
            onCancel={() => setShowConflictDialog(false)}
            t={t}
          />
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode — three always-visible cards with real values
// ---------------------------------------------------------------------------

function ViewCards({
  place,
  nameVariantsList,
  maptilerKey,
  isMerged,
  onSetCoords,
  t,
}: {
  place: PlaceLoaderData["place"];
  nameVariantsList: string[];
  maptilerKey: string;
  isMerged: boolean;
  onSetCoords: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const lodLinks: Array<{
    label: string;
    value: string | null;
    href: ((id: string) => string) | null;
  }> = [
    { label: t("field.tgnId"), value: place.tgnId, href: SERVICE_URLS.tgn },
    { label: t("field.hgisId"), value: place.hgisId, href: SERVICE_URLS.hgis },
    { label: t("field.whgId"), value: place.whgId, href: SERVICE_URLS.whg },
  ];
  return (
    <div>
      {/* Identity */}
      <DetailCard title={t("sectionIdentity")} dimmed={isMerged}>
        <div className="space-y-2.5">
          <FieldDisplay label={t("field.label")} value={place.label} />
          <FieldDisplay
            label={t("field.displayName")}
            value={place.displayName}
          />
          <FieldDisplay
            label={t("field.placeType")}
            value={place.placeType ? t(place.placeType) : null}
          />
          <FieldDisplay label={t("field.parentId")} value={place.parentId} />
          <div>
            <p className="text-xs text-stone-500">{t("field.nameVariants")}</p>
            <VariantChips variants={nameVariantsList} />
          </div>
        </div>
      </DetailCard>

      {/* Geography — the map is ALWAYS on screen (spec §5 redesign) */}
      <DetailCard title={t("sectionGeography")} dimmed={isMerged}>
        {place.latitude != null && place.longitude != null ? (
          <>
            <PlaceMapPreview
              lat={place.latitude}
              lng={place.longitude}
              maptilerKey={maptilerKey}
            />
            <div className="mt-3 space-y-2">
              <div>
                <p className="text-xs text-stone-500">
                  {t("field.coordinates")}
                </p>
                <p className="font-mono text-13 nums text-stone-700">
                  {place.latitude}, {place.longitude}
                </p>
              </div>
              <FieldDisplay
                label={t("coordPrecisionLabel")}
                value={precisionDisplayLabel(place.coordinatePrecision, t)}
              />
            </div>
          </>
        ) : (
          <>
            <NoCoordinatesWell title={t("previewNoCoords")} />
            <div className="mt-3">
              <button
                type="button"
                onClick={onSetCoords}
                className="inline-flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-13 font-semibold text-stone-700 hover:bg-stone-50"
              >
                <MapPin className="h-4 w-4" strokeWidth={1.5} />
                {t("previewSetCoords")}
              </button>
            </div>
          </>
        )}
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
        notes={place.notes}
        internalNotes={place.internalNotes}
        notesLabel={t("sectionNotes")}
        internalNotesLabel={t("sectionInternalNotes")}
        internalBadge={t("internalBadge")}
      />
    </div>
  );
}

/** Localise a known coordinate-precision value; unknown/legacy values
 * (rows predating the vocabulary) render verbatim. */
function precisionDisplayLabel(
  value: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (!value) return null;
  const known: Record<string, string> = {
    exact: "precisionExact",
    approximate: "precisionApproximate",
    centroid: "precisionCentroid",
    uncertain: "precisionUncertain",
  };
  return known[value] ? t(known[value]) : value;
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditMode({
  place,
  nameVariantsList,
  errors,
  maptilerKey,
  t,
  onDiscard,
  formRef,
  onFormChange,
}: {
  place: PlaceLoaderData["place"];
  nameVariantsList: string[];
  errors?: Record<string, string[]> | undefined;
  maptilerKey: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
  onDiscard: () => void;
  formRef?: React.Ref<HTMLFormElement>;
  onFormChange?: () => void;
}) {
  const [nameVariants, setNameVariants] = useState<string[]>(nameVariantsList);
  const [latitude, setLatitude] = useState<number | null>(place.latitude);
  const [longitude, setLongitude] = useState<number | null>(place.longitude);
  const [precision, setPrecision] = useState(place.coordinatePrecision || "");
  const [tgnId, setTgnId] = useState(place.tgnId || "");
  const [hgisId, setHgisId] = useState(place.hgisId || "");
  const [whgId, setWhgId] = useState(place.whgId || "");
  // A geocode pick flies the editor map (token-keyed so ordinary
  // coordinate syncs — typed inputs, pin drags — never move the camera).
  const [flyTo, setFlyTo] = useState<{
    lat: number;
    lng: number;
    token: number;
  } | null>(null);
  // wikidataId dropped on places in 0036 (0% populated).

  // Any user gesture that sets coordinates (geocode pick, pin drag, map
  // click, manual entry) defaults an UNSET precision to 'approximate' —
  // a located place should not stay precision-less — but never overrides
  // a value the user already chose. Only "" (unset) is bumped.
  const defaultPrecisionOnCoordSet = () =>
    setPrecision((prev) => (prev === "" ? "approximate" : prev));

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
      <h3 className="mb-2.5 text-11 font-bold uppercase tracking-[0.12em] text-stone-500">
        {t("sectionIdentity")}
      </h3>
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

      {/* Geography — geocoding search + the shipped coordinate editor */}
      <h3 className="mb-2.5 mt-6 text-11 font-bold uppercase tracking-[0.12em] text-stone-500">
        {t("sectionGeography")}
      </h3>
      <div className="space-y-4">
        {/* Geocoding search (Juan's ruling): pick a modern place name to
            fly the map and set the pin — still draggable, still synced
            with the inputs below, never auto-saved. */}
        <GeocodeSearch
          maptilerKey={maptilerKey}
          onPick={(r) => {
            const lat = Math.round(r.lat * 1e6) / 1e6;
            const lng = Math.round(r.lng * 1e6) / 1e6;
            setLatitude(lat);
            setLongitude(lng);
            defaultPrecisionOnCoordSet();
            setFlyTo((prev) => ({
              lat,
              lng,
              token: (prev?.token ?? 0) + 1,
            }));
            onFormChange?.();
          }}
          t={t}
        />
        {/* Coordinate editor (design surface 10): click-to-set /
            drag-to-adjust map, mono inputs two-way synced with the
            pin, free-text precision with suggested values. */}
        <CoordinateMapEditor
          lat={latitude}
          lng={longitude}
          onChange={(newLat, newLng) => {
            setLatitude(newLat);
            setLongitude(newLng);
            defaultPrecisionOnCoordSet();
            onFormChange?.();
          }}
          maptilerKey={maptilerKey}
          flyTo={flyTo}
          t={t}
        />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="coord-lat"
              className="mb-1 block text-11 font-semibold uppercase tracking-wide text-indigo"
            >
              {t("field.latitude")}
            </label>
            <input
              id="coord-lat"
              type="text"
              inputMode="decimal"
              placeholder={"—"}
              value={latitude != null ? String(latitude) : ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "") return setLatitude(null);
                const num = parseFloat(v);
                if (!isNaN(num)) {
                  setLatitude(num);
                  defaultPrecisionOnCoordSet();
                }
              }}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-13 nums text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
            {errors?.latitude?.[0] && (
              <p className="mt-1 text-11 text-madder-deep">
                {errors.latitude[0]}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="coord-lng"
              className="mb-1 block text-11 font-semibold uppercase tracking-wide text-indigo"
            >
              {t("field.longitude")}
            </label>
            <input
              id="coord-lng"
              type="text"
              inputMode="decimal"
              placeholder={"—"}
              value={longitude != null ? String(longitude) : ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "") return setLongitude(null);
                const num = parseFloat(v);
                if (!isNaN(num)) {
                  setLongitude(num);
                  defaultPrecisionOnCoordSet();
                }
              }}
              className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-13 nums text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
            {errors?.longitude?.[0] && (
              <p className="mt-1 text-11 text-madder-deep">
                {errors.longitude[0]}
              </p>
            )}
          </div>
        </div>
        <div>
          <label
            htmlFor="coord-precision"
            className="mb-1 block text-11 font-semibold uppercase tracking-wide text-indigo"
          >
            {t("coordPrecisionLabel")}
          </label>
          <select
            id="coord-precision"
            value={precision}
            onChange={(e) => setPrecision(e.target.value)}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{t("coordPrecisionUnset")}</option>
            {COORDINATE_PRECISIONS.map((v) => (
              <option key={v} value={v}>
                {precisionDisplayLabel(v, t)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Linked open data */}
      <h3 className="mb-2.5 mt-6 text-11 font-bold uppercase tracking-[0.12em] text-stone-500">
        {t("sectionLod")}
      </h3>
      <div className="space-y-4">
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

      {/* Notes */}
      <h3 className="mb-2.5 mt-6 text-11 font-bold uppercase tracking-[0.12em] text-stone-500">
        {t("sectionNotes")}
      </h3>
      <NotesEditFields
        notes={place.notes}
        internalNotes={place.internalNotes}
        notesLabel={t("field.notes")}
        internalNotesLabel={t("field.internalNotes")}
        internalBadge={t("internalBadge")}
      />

      {/* Actions — Save/Discard + commit note at the column's end */}
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
