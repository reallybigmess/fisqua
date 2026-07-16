/**
 * Entities Admin — Possible-duplicates worklist
 *
 * The entity duplicates queue (spec §4, handoff surface 3). The loader
 * computes candidates deterministically on every request: active
 * (non-merged-away) entities in the session tenant's federation,
 * bucketed by accent-normalised name, with date overlap and shared
 * Wikidata as ranking tie-signals; pairs with a `separate` ledger
 * operation between them never resurface. No background jobs, no
 * candidate table.
 *
 * The action handles one intent — `separate` — writing a single
 * `separate` ledger row with the required `detail.reason`. Nothing on
 * this page mutates entity records themselves; "Compare & merge"
 * deep-links into the merge workbench.
 *
 * Gated on the `authorities` capability (loader and action); the
 * dismissal is a federation-steward decision like every other ledger
 * write.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  DuplicatesWorklist,
  type PairMeta,
} from "~/components/admin/duplicates-worklist";
import type { CandidatePair } from "~/lib/authority-duplicates.server";
import type { Route } from "./+types/_auth.admin.entities.duplicates";

/** Cap the rendered queue; the count line reflects the full number. */
const MAX_PAIRS = 50;

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, isNull, inArray, sql } = await import("drizzle-orm");
  const { entities, descriptionEntities } = await import("~/db/schema");
  const { computeDuplicateCandidates, getSeparatePairs } = await import(
    "~/lib/authority-duplicates.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);

  const rows = await db
    .select({
      id: entities.id,
      name: entities.displayName,
      code: entities.entityCode,
      dateStart: entities.dateStart,
      dateEnd: entities.dateEnd,
      dates: entities.datesOfExistence,
      externalId: entities.wikidataId,
    })
    .from(entities)
    .where(
      and(
        eq(entities.federationId, tenant.federationId),
        isNull(entities.mergedInto),
      ),
    )
    .all();

  const separatePairs = await getSeparatePairs(
    db,
    tenant.federationId,
    "entity",
  );
  const { pairs: allPairs, truncated } = computeDuplicateCandidates(
    rows,
    separatePairs,
  );
  const pairs = allPairs.slice(0, MAX_PAIRS);

  // Link counts for the records on the visible cards only.
  const visibleIds = Array.from(
    new Set(pairs.flatMap((p) => [p.a.id, p.b.id])),
  );
  const linkCounts = new Map<string, number>();
  if (visibleIds.length > 0) {
    const counts = await db
      .select({
        entityId: descriptionEntities.entityId,
        count: sql<number>`count(*)`,
      })
      .from(descriptionEntities)
      .where(inArray(descriptionEntities.entityId, visibleIds))
      .groupBy(descriptionEntities.entityId)
      .all();
    for (const c of counts) linkCounts.set(c.entityId, c.count);
  }

  return {
    pairs,
    totalPairs: allPairs.length,
    truncated,
    linkCounts: Object.fromEntries(linkCounts),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, isNull } = await import("drizzle-orm");
  const { entities } = await import("~/db/schema");
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
  if ((formData.get("_action") as string) !== "separate") {
    return { ok: false as const, error: "generic" as const };
  }

  const reason = (formData.get("reason") as string)?.trim() || "";
  if (!reason) return { ok: false as const, error: "reason" as const };

  const sourceId = formData.get("sourceId") as string;
  const targetId = formData.get("targetId") as string;
  if (!sourceId || !targetId || sourceId === targetId) {
    return { ok: false as const, error: "generic" as const };
  }

  // Both records must be live entities in this federation — a
  // dismissal names two real records, never arbitrary ids.
  const [a, b] = await Promise.all([
    db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          eq(entities.id, sourceId),
          isNull(entities.mergedInto),
        ),
      )
      .get(),
    db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          eq(entities.id, targetId),
          isNull(entities.mergedInto),
        ),
      )
      .get(),
  ]);
  if (!a || !b) {
    return { ok: false as const, error: "generic" as const };
  }

  await db.batch([
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType: "entity",
      operation: "separate",
      sourceId,
      targetId,
      userId: user.id,
      detail: { reason },
    }),
  ] as any);

  return { ok: true as const };
}

export default function EntityDuplicatesPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { pairs, totalPairs, truncated, linkCounts } = loaderData;

  const metaFor = (r: CandidatePair["a"]): string => {
    const parts = [r.code, r.dates, t("dupLinksMeta", { count: linkCounts[r.id] ?? 0 })];
    return parts.filter(Boolean).join(" · ");
  };
  const meta: PairMeta[] = pairs.map((p) => ({
    metaA: metaFor(p.a),
    metaB: metaFor(p.b),
  }));

  return (
    <DuplicatesWorklist
      eyebrow={t("mergeEyebrowEntities")}
      basePath="/admin/entities"
      pairs={pairs}
      totalPairs={totalPairs}
      truncated={truncated}
      meta={meta}
      signalLabels={{
        name: t("dupSignalName"),
        dates: t("dupSignalDates"),
        externalId: t("dupSignalWikidata"),
      }}
      t={t}
    />
  );
}
