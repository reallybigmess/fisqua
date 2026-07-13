/**
 * Fonds List Lookup
 *
 * This module deals with querying the distinct set of fonds
 * reference codes that have at least one publishable description.
 * Used by the publish dashboard to build the fonds selector dropdown
 * and by the validation layer in `api.publish` to reject requests
 * that target unknown fonds.
 *
 * Two scopings exist: `getFondsList` for a single tenant (a member
 * running its own off-by-default export) and `getScopedFondsList` /
 * `getFondsOwners` for a set of member tenants (a federation publish,
 * where the lead publishes every member -- federation spec §9 step 8).
 * A single tenant can never see another tenant's fonds; a federation
 * run sees the UNION across its members, keyed to each fonds' owning
 * tenant so the workflow reads each from the right place.
 *
 * @version v0.4.2
 */

import { eq, and, isNull, inArray } from "drizzle-orm";
import { descriptions } from "../../db/schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { ExportTenant } from "./types";

/**
 * Query distinct root description reference codes for the given
 * tenant. Root descriptions are those with no parent (parentId IS
 * NULL). Returns sorted reference codes, filtering out any null
 * values. Thin single-tenant wrapper over `getScopedFondsList`.
 */
export async function getFondsList(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant
): Promise<string[]> {
  return getScopedFondsList(db, [tenant.id]);
}

/**
 * Query distinct root description reference codes across a SET of
 * tenants -- the union a federation publish selects from. Root
 * descriptions are those with no parent (parentId IS NULL). Returns
 * sorted reference codes, filtering out any null values.
 *
 * Reference codes are unique per tenant (migration 0043), so across a
 * federation two members could in principle share a code; the sort +
 * distinct-by-code contract here matches the pre-partition single-tenant
 * list, and `getFondsOwners` keeps the code→tenant resolution
 * unambiguous for the read path.
 */
export async function getScopedFondsList(
  db: DrizzleD1Database<any>,
  tenantIds: string[]
): Promise<string[]> {
  if (tenantIds.length === 0) return [];
  const roots = await db
    .select({ referenceCode: descriptions.referenceCode })
    .from(descriptions)
    .where(
      and(
        inArray(descriptions.tenantId, tenantIds),
        isNull(descriptions.parentId)
      )
    )
    .orderBy(descriptions.referenceCode)
    .all();
  // Distinct by code (a code appears once even if — defensively — two
  // members hold it), preserving the sorted order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    if (r.referenceCode && !seen.has(r.referenceCode)) {
      seen.add(r.referenceCode);
      out.push(r.referenceCode);
    }
  }
  return out;
}

/**
 * Resolve each fonds (root) reference code to its OWNING tenant id,
 * across the given member tenants. The federation publish workflow
 * needs this so each per-fonds step reads from the tenant that actually
 * holds the fonds (the AHR fonds live in the `ahr` tenant after the
 * step-6 partition; the rest in `neogranadina`) even though every
 * artefact is written under the one publish slug.
 *
 * When (defensively) a code exists under more than one tenant, the
 * first by tenant scan order wins; this cannot happen for the current
 * federation, whose members' reference codes are prefix-disjoint
 * (the `co-ahr` prefix belongs to the ahr tenant; co-ahrb, co-cihjml,
 * pe-bn, and co-ahjci to neogranadina).
 */
export async function getFondsOwners(
  db: DrizzleD1Database<any>,
  tenantIds: string[]
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (tenantIds.length === 0) return owners;
  const roots = await db
    .select({
      referenceCode: descriptions.referenceCode,
      tenantId: descriptions.tenantId,
    })
    .from(descriptions)
    .where(
      and(
        inArray(descriptions.tenantId, tenantIds),
        isNull(descriptions.parentId)
      )
    )
    .all();
  for (const r of roots) {
    if (r.referenceCode && !owners.has(r.referenceCode)) {
      owners.set(r.referenceCode, r.tenantId);
    }
  }
  return owners;
}
