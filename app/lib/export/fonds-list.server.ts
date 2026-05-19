/**
 * Fonds List Lookup
 *
 * This module deals with querying the distinct set of fonds
 * reference codes that have at least one publishable description.
 * Used by the publish dashboard to build the fonds selector dropdown
 * and by the validation layer in `api.publish` to reject requests
 * that target unknown fonds.
 *
 * Takes a tenant argument so cataloguers on Tenant A can never see
 * Tenant B's fonds in their selector dropdown. An earlier iteration
 * of the query was unscoped — it returned every root reference code
 * in the catalogue regardless of tenant, which would have been a
 * cross-tenant leak in a multi-tenant deploy.
 *
 * @version v0.4.0
 */

import { eq, and, isNull } from "drizzle-orm";
import { descriptions } from "../../db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { ExportTenant } from "./types";

/**
 * Query distinct root description reference codes for the given
 * tenant. Root descriptions are those with no parent (parentId IS
 * NULL). Returns sorted reference codes, filtering out any null
 * values.
 */
export async function getFondsList(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant
): Promise<string[]> {
  const roots = await db
    .select({ referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        isNull(descriptions.parentId)
      )
    )
    .orderBy(descriptions.referenceCode)
    .all();
  return roots.map((r) => r.referenceCode).filter(Boolean) as string[];
}
