/**
 * Places Admin — Merge workbench (full-page)
 *
 * The full-viewport merge surface for place authorities (spec §4,
 * handoff surface 1), the place counterpart of the entities merge
 * workbench. The `:id` record is merged away; the survivor arrives via
 * `?survivor=<id>`. Places carry no free-text `sources` note field, so
 * the ledger row (with the required `detail.reason`) is the sole durable
 * record of the merge.
 *
 * Gated on the `authorities` capability; the mutation requires a
 * federation steward.
 *
 * Both merge sides load rich linked-description context cards
 * (`loadLinkedDescriptionCards`); the survivor's cards are read-only.
 *
 * @version v0.4.3
 */

import { useTranslation } from "react-i18next";
import { redirect, useActionData } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  MergeWorkbench,
  type ComparisonField,
} from "~/components/admin/merge-workbench";
import type { Route } from "./+types/_auth.admin.places.$id.merge";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { places } = await import("~/db/schema");
  const { loadLinkedDescriptionCards } = await import(
    "~/lib/authority-linked-context.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;
  const survivorId = new URL(request.url).searchParams.get("survivor");

  const loser = await db
    .select()
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
    .get();
  if (!loser) throw new Response("Not found", { status: 404 });

  const loserCards = await loadLinkedDescriptionCards(db, {
    recordType: "place",
    ownerId: id,
    displayName: loser.displayName,
  });

  let survivor: typeof loser | null = null;
  let survivorCards: Awaited<ReturnType<typeof loadLinkedDescriptionCards>> | null =
    null;
  if (survivorId) {
    survivor =
      (await db
        .select()
        .from(places)
        .where(and(eq(places.federationId, tenant.federationId), eq(places.id, survivorId)))
        .get()) ?? null;
    if (survivor) {
      survivorCards = await loadLinkedDescriptionCards(db, {
        recordType: "place",
        ownerId: survivorId,
        displayName: survivor.displayName,
      });
    }
  }

  return { loser, loserCards, survivor, survivorCards };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { places, descriptionPlaces } = await import("~/db/schema");
  const { requireFederationSteward } = await import("~/lib/federation.server");
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);
  await requireFederationSteward(db, user, tenant);

  const formData = await request.formData();
  const reason = (formData.get("reason") as string)?.trim() || "";
  if (!reason) return { ok: false as const, error: "reason" as const };

  const loserId = (formData.get("loserId") as string) || params.id;
  const survivorId = formData.get("survivorId") as string;
  if (!survivorId) return { ok: false as const, error: "survivor" as const };

  const addVariants = formData.get("addVariants") === "true";
  let linkIds: string[] = [];
  try {
    linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
  } catch {
    linkIds = [];
  }

  const survivor = await db
    .select()
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, survivorId)))
    .get();
  const loser = await db
    .select()
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, loserId)))
    .get();
  if (!survivor || !loser) return { ok: false as const, error: "generic" as const };

  const formUpdatedAt = formData.get("_updatedAt") as string;
  const forceOverwrite = formData.get("_force") === "true";
  if (!forceOverwrite && formUpdatedAt && String(loser.updatedAt) !== formUpdatedAt) {
    return { ok: false as const, error: "conflict" as const, modifiedAt: loser.updatedAt };
  }

  // Each link must belong to the LOSER — a crafted linkId pointing at
  // another record's junction row is skipped, never repointed.
  const linkStatements: any[] = [];
  const droppedLinks: unknown[] = [];
  let movedLinks = 0;
  for (const linkId of linkIds) {
    const link = await db
      .select()
      .from(descriptionPlaces)
      .where(
        and(
          eq(descriptionPlaces.id, linkId),
          eq(descriptionPlaces.placeId, loserId),
        ),
      )
      .get();
    if (!link) continue;
    const conflict = await db
      .select({ id: descriptionPlaces.id })
      .from(descriptionPlaces)
      .where(
        and(
          eq(descriptionPlaces.descriptionId, link.descriptionId),
          eq(descriptionPlaces.placeId, survivorId),
          eq(descriptionPlaces.role, link.role),
        ),
      )
      .get();
    if (conflict) {
      droppedLinks.push(link);
      linkStatements.push(
        db.delete(descriptionPlaces).where(eq(descriptionPlaces.id, linkId)),
      );
    } else {
      movedLinks += 1;
      linkStatements.push(
        db
          .update(descriptionPlaces)
          .set({ placeId: survivorId })
          .where(eq(descriptionPlaces.id, linkId)),
      );
    }
  }

  let survivorVariants = survivor.nameVariants;
  if (addVariants) {
    let existing: string[] = [];
    try {
      existing = JSON.parse(survivor.nameVariants || "[]");
    } catch {
      existing = [];
    }
    let loserVariants: string[] = [];
    try {
      loserVariants = JSON.parse(loser.nameVariants || "[]");
    } catch {
      loserVariants = [];
    }
    survivorVariants = JSON.stringify(
      Array.from(new Set([...existing, loser.displayName, ...loserVariants])),
    );
  }

  // Links left behind = the loser's live links minus those actually
  // reassigned or conflict-dropped (not the raw client count).
  const [{ count: loserLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionPlaces)
    .where(eq(descriptionPlaces.placeId, loserId))
    .all();
  const leftBehind = Math.max(
    0,
    loserLinkCount - movedLinks - droppedLinks.length,
  );

  const timestamp = Date.now();
  const batch: any[] = [
    ...linkStatements,
    db
      .update(places)
      .set({ mergedInto: survivorId, updatedAt: timestamp })
      .where(and(eq(places.federationId, tenant.federationId), eq(places.id, loserId))),
  ];
  if (addVariants) {
    batch.push(
      db
        .update(places)
        .set({ nameVariants: survivorVariants, updatedAt: timestamp })
        .where(and(eq(places.federationId, tenant.federationId), eq(places.id, survivorId))),
    );
  }
  batch.push(
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType: "place",
      operation: "merge",
      sourceId: loserId,
      targetId: survivorId,
      userId: user.id,
      detail: { reason, movedLinks, droppedLinks, addVariants, leftBehind },
    }),
  );

  await db.batch(batch as any);
  return redirect(`/admin/places/${survivorId}`);
}

export default function PlaceMergeWorkbench({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { t: tp } = useTranslation("places");
  const actionData = useActionData<typeof action>();
  const { loser, loserCards, survivor, survivorCards } = loaderData;

  const coords = (r: typeof loser | null) =>
    r && r.latitude != null && r.longitude != null
      ? `${r.latitude}, ${r.longitude}`
      : "";

  const comparisonFields: ComparisonField[] = [
    { key: "displayName", label: tp("field.displayName") },
    { key: "placeCode", label: tp("field.placeCode") },
    { key: "coordinates", label: tp("field.latitude") },
    { key: "tgnId", label: tp("field.tgnId") },
    { key: "hgisId", label: tp("field.hgisId") },
    { key: "whgId", label: tp("field.whgId") },
    { key: "linkCount", label: t("mergeLinksHeading") },
  ];

  const toFields = (
    r: typeof loser | null,
    linkCount: number,
  ): Record<string, string | null> =>
    r
      ? {
          displayName: r.displayName,
          placeCode: r.placeCode,
          coordinates: coords(r),
          tgnId: r.tgnId,
          hgisId: r.hgisId,
          whgId: r.whgId,
          linkCount: String(linkCount),
        }
      : {};

  const conflictModifiedAt =
    actionData && "error" in actionData && actionData.error === "conflict"
      ? actionData.modifiedAt
      : null;

  return (
    <MergeWorkbench
      eyebrow={t("mergeEyebrowPlaces")}
      basePath="/admin/places"
      searchEndpoint="/admin/places"
      loser={{
        id: loser.id,
        name: loser.displayName,
        code: loser.placeCode ?? "",
        fields: toFields(loser, loserCards.totalLinks),
      }}
      loserUpdatedAt={loser.updatedAt}
      survivor={
        survivor
          ? {
              id: survivor.id,
              name: survivor.displayName,
              code: survivor.placeCode ?? "",
              fields: toFields(survivor, survivorCards?.totalLinks ?? 0),
            }
          : null
      }
      loserCards={loserCards}
      survivorCards={survivorCards}
      showAsRecorded={false}
      roleLabel={(role) => tp(`role_${role}`, role)}
      placeRoleLabel={(role) => tp(`role_${role}`, role)}
      comparisonFields={comparisonFields}
      conflictModifiedAt={conflictModifiedAt}
      t={t}
    />
  );
}
