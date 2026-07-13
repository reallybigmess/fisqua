/**
 * Places Admin — Operation history (read-only)
 *
 * The per-record ledger history page for places (spec §4), the place
 * counterpart of the entities history route: every ledger operation
 * touching this place as source or target, newest first, with
 * direction-aware titles, the acting user, the reason, and compact
 * link-count summaries. Read-only — no action is exported.
 *
 * Gated on the `authorities` capability; federation-scoped.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  OperationHistory,
  type HistoryEntry,
} from "~/components/admin/operation-history";
import type { Route } from "./+types/_auth.admin.places.$id.history";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { places } = await import("~/db/schema");
  const { getOperationHistory } = await import(
    "~/lib/authority-workbench.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;

  const place = await db
    .select({
      id: places.id,
      displayName: places.displayName,
      placeCode: places.placeCode,
    })
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
    .get();
  if (!place) throw new Response("Not found", { status: 404 });

  const { rows: history, total: historyTotal } = await getOperationHistory(db, {
    federationId: tenant.federationId,
    recordType: "place",
    recordId: id,
  });

  const counterpartIds = Array.from(
    new Set(
      history
        .map((h) => h.counterpartId)
        .filter((cid): cid is string => cid != null),
    ),
  );
  const counterpartNames: Record<string, string> = {};
  if (counterpartIds.length > 0) {
    const rows = await db
      .select({ id: places.id, displayName: places.displayName })
      .from(places)
      .where(
        and(
          eq(places.federationId, tenant.federationId),
          inArray(places.id, counterpartIds),
        ),
      )
      .all();
    for (const r of rows) counterpartNames[r.id] = r.displayName;
  }

  return { place, history, historyTotal, counterpartNames };
}

export default function PlaceHistoryPage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { place, history, historyTotal, counterpartNames } = loaderData;

  const entries: HistoryEntry[] = history.map((h) => {
    const counterpartName = h.counterpartId
      ? (counterpartNames[h.counterpartId] ?? t("histUnknownRecord"))
      : t("histUnknownRecord");
    const counterpartHref =
      h.counterpartId && counterpartNames[h.counterpartId]
        ? `/admin/places/${h.counterpartId}`
        : null;

    let title: string;
    switch (h.operation) {
      case "merge":
        title =
          h.direction === "source"
            ? t("histMergedInto", { name: counterpartName })
            : t("histMergedFrom", { name: counterpartName });
        break;
      case "split":
        title =
          h.direction === "source"
            ? t("histSplitInto", { name: counterpartName })
            : t("histSplitFrom", { name: counterpartName });
        break;
      case "separate":
        title = t("histSeparate", { name: counterpartName });
        break;
      case "delete":
        title = t("histDeleted");
        break;
      case "resolve":
        title = t("histResolved");
        break;
      default:
        title = h.operation;
    }

    const detailParts: string[] = [];
    if (h.movedLinks != null && h.movedLinks > 0) {
      detailParts.push(t("histDetailMoved", { count: h.movedLinks }));
    }
    if (h.droppedLinks != null && h.droppedLinks > 0) {
      detailParts.push(t("histDetailDropped", { count: h.droppedLinks }));
    }
    if (h.leftBehind != null && h.leftBehind > 0) {
      detailParts.push(t("histDetailLeft", { count: h.leftBehind }));
    }

    return {
      id: h.id,
      operation: h.operation,
      title,
      counterpartHref,
      date: new Date(h.createdAt).toISOString().slice(0, 10),
      user: h.userName || t("bandUnknownUser"),
      reason: h.reason,
      detailParts,
    };
  });

  return (
    <OperationHistory
      eyebrow={t("mergeEyebrowPlaces")}
      recordName={place.displayName}
      recordCode={place.placeCode ?? ""}
      backTo={`/admin/places/${place.id}`}
      entries={entries}
      total={historyTotal}
      t={t}
    />
  );
}
