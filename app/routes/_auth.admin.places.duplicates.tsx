/**
 * Places Admin — Possible-duplicates worklist
 *
 * The place duplicates queue (spec §4, handoff surface 3), the place
 * counterpart of the entities worklist. Places carry no lifespan
 * dates, so the tie-signals are the accent-normalised name collision
 * (always) and a shared TGN identifier; pairs dismissed with a
 * `separate` ledger operation never resurface. The action writes one
 * `separate` row with the required `detail.reason`; nothing on the
 * page mutates place records.
 *
 * Gated on the `authorities` capability (loader and action); the
 * dismissal requires a federation steward.
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
import type { Route } from "./+types/_auth.admin.places.duplicates";

/** Cap the rendered queue; the count line reflects the full number. */
const MAX_PAIRS = 50;

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, isNull, inArray, sql } = await import("drizzle-orm");
  const { places, descriptionPlaces } = await import("~/db/schema");
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
      id: places.id,
      name: places.displayName,
      code: places.placeCode,
      externalId: places.tgnId,
    })
    .from(places)
    .where(
      and(
        eq(places.federationId, tenant.federationId),
        isNull(places.mergedInto),
      ),
    )
    .all();

  const separatePairs = await getSeparatePairs(
    db,
    tenant.federationId,
    "place",
  );
  const { pairs: allPairs, truncated } = computeDuplicateCandidates(
    rows,
    separatePairs,
  );
  const pairs = allPairs.slice(0, MAX_PAIRS);

  const visibleIds = Array.from(
    new Set(pairs.flatMap((p) => [p.a.id, p.b.id])),
  );
  const linkCounts = new Map<string, number>();
  if (visibleIds.length > 0) {
    const counts = await db
      .select({
        placeId: descriptionPlaces.placeId,
        count: sql<number>`count(*)`,
      })
      .from(descriptionPlaces)
      .where(inArray(descriptionPlaces.placeId, visibleIds))
      .groupBy(descriptionPlaces.placeId)
      .all();
    for (const c of counts) linkCounts.set(c.placeId, c.count);
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
  const { places } = await import("~/db/schema");
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

  const [a, b] = await Promise.all([
    db
      .select({ id: places.id })
      .from(places)
      .where(
        and(
          eq(places.federationId, tenant.federationId),
          eq(places.id, sourceId),
          isNull(places.mergedInto),
        ),
      )
      .get(),
    db
      .select({ id: places.id })
      .from(places)
      .where(
        and(
          eq(places.federationId, tenant.federationId),
          eq(places.id, targetId),
          isNull(places.mergedInto),
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
      recordType: "place",
      operation: "separate",
      sourceId,
      targetId,
      userId: user.id,
      detail: { reason },
    }),
  ] as any);

  return { ok: true as const };
}

export default function PlaceDuplicatesPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { pairs, totalPairs, truncated, linkCounts } = loaderData;

  const metaFor = (r: CandidatePair["a"]): string => {
    const parts = [r.code, t("dupLinksMeta", { count: linkCounts[r.id] ?? 0 })];
    return parts.filter(Boolean).join(" · ");
  };
  const meta: PairMeta[] = pairs.map((p) => ({
    metaA: metaFor(p.a),
    metaB: metaFor(p.b),
  }));

  return (
    <DuplicatesWorklist
      eyebrow={t("mergeEyebrowPlaces")}
      basePath="/admin/places"
      pairs={pairs}
      totalPairs={totalPairs}
      truncated={truncated}
      meta={meta}
      signalLabels={{
        name: t("dupSignalName"),
        dates: t("dupSignalDates"),
        externalId: t("dupSignalTgn"),
      }}
      t={t}
    />
  );
}
