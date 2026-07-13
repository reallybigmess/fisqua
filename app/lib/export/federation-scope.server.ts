/**
 * Export Federation Scope
 *
 * This module resolves the scope of a publish run: which tenants' rows
 * it reads and under which single R2 prefix it writes. It is the ONE
 * place that decides "single-tenant own-publish" vs "federation publish"
 * (federation spec §3 line 50, §9 step 8), so the route dropdown/
 * changelog, the api.publish validator, and the workflow read path all
 * agree by construction.
 *
 * THE MODEL (federation spec §1: "the lead publishes all members")
 * ----------------------------------------------------------------
 * Publishing is a federation-level operation. When the federation LEAD
 * tenant triggers a run, the run aggregates descriptions across EVERY
 * member tenant of the federation (after the step-6 partition the
 * Neogranadina federation's content is split across the `neogranadina`
 * and `ahr` tenants, so a lead-only read would silently drop 55,359 AHR
 * descriptions -- a published-output regression). The aggregation reads
 * per-repository, because each repository (and thus each fonds) belongs
 * to exactly one tenant.
 *
 * PUBLISH-NEUTRALITY -- why every artefact lands under the LEAD slug
 * -----------------------------------------------------------------
 * Before the partition, the Neogranadina single-tenant export wrote
 * every artefact under the `neogranadina/` R2 prefix, and the published
 * Zasqua site reads those exact keys. To keep the partition +
 * federation-reads round-trip publish-neutral, the federation export
 * writes ALL artefacts (including the AHR fonds now owned by the `ahr`
 * tenant) under the LEAD tenant's slug -- reproducing the pre-partition
 * layout byte-for-byte, keys included. The read tenant and the write
 * prefix are therefore decoupled: rows are read from their owning member
 * tenant, but keyed under the one publish slug. (A member running its
 * OWN separate export -- the deferred, off-by-default tenant-level
 * option, spec §1 -- would instead be a non-lead trigger: single-tenant
 * scope, its own slug. That path is preserved below and is what every
 * pre-step-8 caller still gets.)
 *
 * @version v0.4.2
 */

import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { federations, tenants } from "../../db/schema";
import type { ExportTenant } from "./types";

/**
 * The resolved scope of a publish run.
 *
 *   - `federationId`    — the federation this run publishes (recorded on
 *                         `exportRuns.federationId`).
 *   - `publishSlug`     — the SINGLE R2 key prefix for the whole run
 *                         (the lead tenant's slug in a federation run;
 *                         the tenant's own slug in a single-tenant run).
 *   - `memberTenantIds` — every tenant whose rows the run reads. One
 *                         entry for a single-tenant run; N for a
 *                         federation run.
 *   - `members`         — the full `ExportTenant` for each read tenant,
 *                         carrying its own `descriptiveStandard` so a
 *                         per-fonds EAD3 profile is chosen from the fonds'
 *                         OWNING tenant.
 *   - `isFederation`    — true when the lead is aggregating more than one
 *                         member tenant (informational; the read path is
 *                         identical whether one member or many).
 *   - `publishTenant`   — an `ExportTenant` whose `id`/`descriptiveStandard`
 *                         are the lead's but whose `slug` is `publishSlug`.
 *                         Used for the run-level artefacts that are not
 *                         per-fonds (descriptions-index, and the
 *                         entities/places/repositories writers, which take
 *                         `memberTenantIds` for their reads and
 *                         `publishTenant.slug` for their keys).
 *   - `authoritiesEnabled` — the triggering tenant's `authorities` capability.
 *                         When off, the entities.json/places.json steps are
 *                         skipped (spec §6); the display-field-only renderers
 *                         (descriptions/EAD3/DC/METS) are unaffected.
 */
export type ExportScope = {
  federationId: string;
  publishSlug: string;
  memberTenantIds: string[];
  members: ExportTenant[];
  isFederation: boolean;
  publishTenant: ExportTenant;
  authoritiesEnabled: boolean;
};

/**
 * Resolve the export scope for a triggering/request tenant.
 *
 * - If `tenant` is the LEAD of its federation, the run is a federation
 *   publish: it aggregates every member tenant of `tenant.federationId`
 *   and writes under the lead's slug.
 * - Otherwise (a non-lead tenant, e.g. a member running its own
 *   off-by-default export, or any solo tenant that is its own
 *   federation-of-one lead but has no other members) the run is
 *   single-tenant: it reads only `tenant`'s rows and writes under
 *   `tenant`'s slug. This is byte-identical to every pre-step-8 run.
 *
 * `tenant` must carry a non-null `descriptiveStandard` (a `kind='tenant'`
 * invariant; platform tenants cannot publish). Callers already assert
 * this before reaching here.
 */
export async function resolveExportScope(
  db: DrizzleD1Database<any>,
  tenant: ExportTenant
): Promise<ExportScope> {
  const fed = await db
    .select({ leadTenantId: federations.leadTenantId })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();

  const isLead = !!fed && fed.leadTenantId === tenant.id;

  // The triggering tenant's authorities capability gates the
  // entities.json/places.json steps. In a federation run the trigger IS
  // the lead; in an own-publish it is the tenant itself — either way the
  // trigger's flag is the governing one.
  const capRow = await db
    .select({ authoritiesEnabled: tenants.authoritiesEnabled })
    .from(tenants)
    .where(eq(tenants.id, tenant.id))
    .get();
  const authoritiesEnabled = capRow?.authoritiesEnabled ?? true;

  // Non-lead trigger → single-tenant own-publish (unchanged behaviour).
  if (!isLead) {
    return {
      federationId: tenant.federationId,
      publishSlug: tenant.slug,
      memberTenantIds: [tenant.id],
      members: [tenant],
      isFederation: false,
      publishTenant: tenant,
      authoritiesEnabled,
    };
  }

  // Lead trigger → federation publish. Read every member tenant of this
  // federation. Ordered by slug so the run's step order is deterministic
  // across environments (local and production seed different tenant
  // UUIDs, so id-order would differ; slug is stable).
  const memberRows = await db
    .select({
      id: tenants.id,
      slug: tenants.slug,
      descriptiveStandard: tenants.descriptiveStandard,
    })
    .from(tenants)
    .where(eq(tenants.federationId, tenant.federationId))
    .orderBy(tenants.slug)
    .all();

  // A federation's member tenants are all `kind='tenant'` and therefore
  // carry a descriptive standard; the filter is defensive (a stray
  // platform tenant would have a null standard and cannot publish).
  const members: ExportTenant[] = memberRows
    .filter((m) => m.descriptiveStandard != null)
    .map((m) => ({
      id: m.id,
      slug: m.slug,
      federationId: tenant.federationId,
      descriptiveStandard: m.descriptiveStandard as ExportTenant["descriptiveStandard"],
    }));

  return {
    federationId: tenant.federationId,
    publishSlug: tenant.slug,
    memberTenantIds: members.map((m) => m.id),
    members,
    isFederation: members.length > 1,
    // Lead identity, but keyed under the publish (lead) slug.
    publishTenant: {
      id: tenant.id,
      slug: tenant.slug,
      federationId: tenant.federationId,
      descriptiveStandard: tenant.descriptiveStandard,
    },
    authoritiesEnabled,
  };
}
