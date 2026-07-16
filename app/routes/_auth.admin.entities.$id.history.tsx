/**
 * Entities Admin — Operation history (read-only)
 *
 * The per-record ledger history page (spec §4): every
 * `authority_operations` row touching this entity as source or
 * target, newest first, with direction-aware human titles ("Merged
 * into X" vs "Merged from X"), the acting user, the required reason
 * as a quoted line, and compact link-count summaries. The status
 * band's "Open ledger entry" link lands here. Strictly read-only —
 * no action is exported.
 *
 * Gated on the `authorities` capability; queries are
 * federation-scoped like every authority read.
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
import type { Route } from "./+types/_auth.admin.entities.$id.history";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { entities } = await import("~/db/schema");
  const { getOperationHistory } = await import(
    "~/lib/authority-workbench.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;

  const entity = await db
    .select({
      id: entities.id,
      displayName: entities.displayName,
      entityCode: entities.entityCode,
    })
    .from(entities)
    .where(and(eq(entities.federationId, tenant.federationId), eq(entities.id, id)))
    .get();
  if (!entity) throw new Response("Not found", { status: 404 });

  const { rows: history, total: historyTotal } = await getOperationHistory(db, {
    federationId: tenant.federationId,
    recordType: "entity",
    recordId: id,
  });

  // Resolve counterpart names in one query (absent rows — e.g. a
  // deleted counterpart — fall back to the unknown-record label).
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
      .select({ id: entities.id, displayName: entities.displayName })
      .from(entities)
      .where(
        and(
          eq(entities.federationId, tenant.federationId),
          inArray(entities.id, counterpartIds),
        ),
      )
      .all();
    for (const r of rows) counterpartNames[r.id] = r.displayName;
  }

  return { entity, history, historyTotal, counterpartNames };
}

export default function EntityHistoryPage({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { entity, history, historyTotal, counterpartNames } = loaderData;

  const entries: HistoryEntry[] = history.map((h) => {
    const counterpartName = h.counterpartId
      ? (counterpartNames[h.counterpartId] ?? t("histUnknownRecord"))
      : t("histUnknownRecord");
    const counterpartHref =
      h.counterpartId && counterpartNames[h.counterpartId]
        ? `/admin/entities/${h.counterpartId}`
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
      eyebrow={t("mergeEyebrowEntities")}
      recordName={entity.displayName}
      recordCode={entity.entityCode ?? ""}
      backTo={`/admin/entities/${entity.id}`}
      entries={entries}
      total={historyTotal}
      t={t}
    />
  );
}
