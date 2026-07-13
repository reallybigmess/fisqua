/**
 * Entities Admin — Merge workbench (full-page)
 *
 * The full-viewport merge surface for entity authorities (spec §4,
 * handoff surface 1), replacing the old modal. The `:id` record is the
 * one that will be merged away; the survivor is chosen via the
 * `?survivor=<id>` query param (typeahead selection, list two-row
 * select, or direction swap all navigate here). The loader renders the
 * server-side field comparison for the pair; the action performs the
 * soft merge — the loser keeps its page with `mergedInto` set — and
 * writes the required reason into the ledger row's `detail.reason`.
 *
 * Gated on the `authorities` capability like the six phase-2 admin
 * routes; the mutation additionally requires a federation steward.
 *
 * Both merge sides load rich linked-description context cards
 * (`loadLinkedDescriptionCards`); the survivor's cards are read-only.
 *
 * @version v0.4.3
 */

import { useTranslation } from "react-i18next";
import { redirect } from "react-router";
import { useActionData } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  MergeWorkbench,
  type ComparisonField,
} from "~/components/admin/merge-workbench";
import type { Route } from "./+types/_auth.admin.entities.$id.merge";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { entities } = await import("~/db/schema");
  const { loadLinkedDescriptionCards } = await import(
    "~/lib/authority-linked-context.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;
  const url = new URL(request.url);
  const survivorId = url.searchParams.get("survivor");

  const loser = await db
    .select()
    .from(entities)
    .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id)))
    .get();
  if (!loser) throw new Response("Not found", { status: 404 });

  const loserCards = await loadLinkedDescriptionCards(db, {
    recordType: "entity",
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
        .from(entities)
        .where(
          and(
            eq(entities.federationId, tenant.federationId),
            eq(entities.id, survivorId),
          ),
        )
        .get()) ?? null;
    if (survivor) {
      survivorCards = await loadLinkedDescriptionCards(db, {
        recordType: "entity",
        ownerId: survivorId,
        displayName: survivor.displayName,
      });
    }
  }

  return {
    loser,
    loserCards,
    survivor,
    survivorCards,
  };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities } = await import("~/db/schema");
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
    .from(entities)
    .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, survivorId)))
    .get();
  const loser = await db
    .select()
    .from(entities)
    .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, loserId)))
    .get();
  if (!survivor || !loser) return { ok: false as const, error: "generic" as const };

  // Optimistic lock on the loser (the record being mutated to mergedInto).
  const formUpdatedAt = formData.get("_updatedAt") as string;
  const forceOverwrite = formData.get("_force") === "true";
  if (!forceOverwrite && formUpdatedAt && String(loser.updatedAt) !== formUpdatedAt) {
    return {
      ok: false as const,
      error: "conflict" as const,
      modifiedAt: loser.updatedAt,
    };
  }

  // Resolve each selected link before the batch: reassignments become
  // UPDATEs; rows colliding with the survivor's (descriptionId, entityId,
  // role) unique index are captured in full for the ledger, then deleted.
  // Each link must belong to the LOSER — a crafted linkId pointing at
  // another record's junction row is skipped, never repointed.
  const linkStatements: any[] = [];
  const droppedLinks: unknown[] = [];
  let movedLinks = 0;
  for (const linkId of linkIds) {
    const link = await db
      .select()
      .from(descriptionEntities)
      .where(
        and(
          eq(descriptionEntities.id, linkId),
          eq(descriptionEntities.entityId, loserId),
        ),
      )
      .get();
    if (!link) continue;
    const conflict = await db
      .select({ id: descriptionEntities.id })
      .from(descriptionEntities)
      .where(
        and(
          eq(descriptionEntities.descriptionId, link.descriptionId),
          eq(descriptionEntities.entityId, survivorId),
          eq(descriptionEntities.role, link.role),
        ),
      )
      .get();
    if (conflict) {
      droppedLinks.push(link);
      linkStatements.push(
        db.delete(descriptionEntities).where(eq(descriptionEntities.id, linkId)),
      );
    } else {
      movedLinks += 1;
      linkStatements.push(
        db
          .update(descriptionEntities)
          .set({ entityId: survivorId })
          .where(eq(descriptionEntities.id, linkId)),
      );
    }
  }

  // Fold the loser's names into the survivor's variants when requested.
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
    const merged = new Set([...existing, loser.displayName, ...loserVariants]);
    survivorVariants = JSON.stringify(Array.from(merged));
  }

  // Links left behind on the loser = its live links minus those
  // actually reassigned or conflict-dropped (not the raw client count,
  // which may contain ids that were skipped as not the loser's).
  const [{ count: loserLinkCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(descriptionEntities)
    .where(eq(descriptionEntities.entityId, loserId))
    .all();
  const leftBehind = Math.max(
    0,
    loserLinkCount - movedLinks - droppedLinks.length,
  );

  const timestamp = Date.now();
  const now = new Date().toISOString().slice(0, 10);
  const sourceNote = `Merged into ${survivor.displayName} (${survivor.entityCode}) on ${now}`;

  const batch: any[] = [
    ...linkStatements,
    db
      .update(entities)
      .set({
        mergedInto: survivorId,
        sources: loser.sources ? `${loser.sources}\n${sourceNote}` : sourceNote,
        updatedAt: timestamp,
      })
      .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, loserId))),
  ];
  if (addVariants) {
    batch.push(
      db
        .update(entities)
        .set({ nameVariants: survivorVariants, updatedAt: timestamp })
        .where(
          and(eq(entities.federationId, tenant.federationId), eq(entities.id, survivorId)),
        ),
    );
  }
  batch.push(
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType: "entity",
      operation: "merge",
      sourceId: loserId,
      targetId: survivorId,
      userId: user.id,
      detail: { reason, movedLinks, droppedLinks, addVariants, leftBehind },
    }),
  );

  await db.batch(batch as any);
  return redirect(`/admin/entities/${survivorId}`);
}

export default function EntityMergeWorkbench({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { t: te } = useTranslation("entities");
  const { t: tp } = useTranslation("places");
  const actionData = useActionData<typeof action>();
  const { loser, loserCards, survivor, survivorCards } = loaderData;

  const comparisonFields: ComparisonField[] = [
    { key: "displayName", label: te("field.displayName") },
    { key: "entityCode", label: te("field.entityCode") },
    { key: "datesOfExistence", label: te("field.datesOfExistence") },
    { key: "wikidataId", label: te("field.wikidataId") },
    { key: "viafId", label: te("field.viafId") },
    { key: "dbeId", label: te("field.dbeId") },
    { key: "linkCount", label: t("mergeLinksHeading") },
  ];

  const toFields = (
    r: typeof loser | null,
    linkCount: number,
  ): Record<string, string | null> =>
    r
      ? {
          displayName: r.displayName,
          entityCode: r.entityCode,
          datesOfExistence: r.datesOfExistence,
          wikidataId: r.wikidataId,
          viafId: r.viafId,
          dbeId: r.dbeId,
          linkCount: String(linkCount),
        }
      : {};

  const conflictModifiedAt =
    actionData && "error" in actionData && actionData.error === "conflict"
      ? actionData.modifiedAt
      : null;

  return (
    <MergeWorkbench
      eyebrow={t("mergeEyebrowEntities")}
      basePath="/admin/entities"
      searchEndpoint="/admin/entities"
      loser={{
        id: loser.id,
        name: loser.displayName,
        code: loser.entityCode ?? "",
        fields: toFields(loser, loserCards.totalLinks),
      }}
      loserUpdatedAt={loser.updatedAt}
      survivor={
        survivor
          ? {
              id: survivor.id,
              name: survivor.displayName,
              code: survivor.entityCode ?? "",
              fields: toFields(survivor, survivorCards?.totalLinks ?? 0),
            }
          : null
      }
      loserCards={loserCards}
      survivorCards={survivorCards}
      showAsRecorded
      roleLabel={(role) => te(`role_${role}`, role)}
      placeRoleLabel={(role) => tp(`role_${role}`, role)}
      comparisonFields={comparisonFields}
      conflictModifiedAt={conflictModifiedAt}
      t={t}
    />
  );
}
