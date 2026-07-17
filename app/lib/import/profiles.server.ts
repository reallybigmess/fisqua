/**
 * Import profiles — CRUD and federation-shared visibility
 *
 * This module deals with the server-side lifecycle of mapping profiles
 * (spec §2, §7.3). A profile is a single mutable per-tenant row whose
 * `version` increments on every bindings edit; runs pin
 * `(profileId, profileVersion)` elsewhere, so this module never mutates
 * a profile in place without bumping the version and stamping
 * `updatedBy` / `updatedAt`.
 *
 * Sharing (spec §7.3): a profile owned by a federation's LEAD tenant and
 * flagged `sharedWithFederation` is visible READ-ONLY to that
 * federation's member tenants. Lead-ness is read from the same
 * federation machinery the authorities module uses — the federation's
 * `leadTenantId`. A member tenant may select and use a shared profile
 * but never edit or delete it; only the owning (lead) tenant can.
 *
 * Nothing references profiles by FK: uploads and runs keep FK-free
 * `profileId` pointers, so a delete here leaves those pointers dangling
 * by design (the run's journal, not the profile, is the record of what
 * an import did).
 *
 * @version v0.6.0
 */

import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { federations, importProfiles } from "../../db/schema";
import type { Tenant } from "../../context";
import { parseProfileBindings, type ProfileBindings } from "./profile-schema";
import { isValidTarget } from "./target-fields";
import type { Standard } from "../standards/types";

export interface ProfileRow {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  bindings: string;
  starterKey: string | null;
  sharedWithFederation: boolean;
  createdBy: string;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A profile plus whether the requesting tenant may edit it. */
export interface VisibleProfile extends ProfileRow {
  readOnly: boolean;
}

/**
 * The federation lead tenant id for a tenant's federation, or null. Takes
 * only the field it reads, so a caller holding a bare `federationId` (the
 * Workflow's profile resolution) need not fabricate a full Tenant.
 */
export async function federationLeadTenantId(
  db: DrizzleD1Database<any>,
  tenant: Pick<Tenant, "federationId">,
): Promise<string | null> {
  if (!tenant.federationId) return null;
  const fed = await db
    .select({ leadTenantId: federations.leadTenantId })
    .from(federations)
    .where(eq(federations.id, tenant.federationId))
    .get();
  return fed?.leadTenantId ?? null;
}

/** The tenant's own profiles, newest-edited first. */
export async function listOwnProfiles(
  db: DrizzleD1Database<any>,
  tenantId: string,
): Promise<ProfileRow[]> {
  return db
    .select()
    .from(importProfiles)
    .where(eq(importProfiles.tenantId, tenantId))
    .orderBy(desc(importProfiles.updatedAt))
    .all() as Promise<ProfileRow[]>;
}

/**
 * Profiles shared into the tenant by its federation lead — the
 * lead-owned, `sharedWithFederation` profiles, visible only when the
 * requesting tenant is NOT the lead (a lead already sees its own shared
 * profiles in `listOwnProfiles`).
 */
export async function listSharedProfiles(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
): Promise<ProfileRow[]> {
  const leadId = await federationLeadTenantId(db, tenant);
  if (!leadId || leadId === tenant.id) return [];
  return db
    .select()
    .from(importProfiles)
    .where(
      and(
        eq(importProfiles.tenantId, leadId),
        eq(importProfiles.sharedWithFederation, true),
      ),
    )
    .orderBy(desc(importProfiles.updatedAt))
    .all() as Promise<ProfileRow[]>;
}

/**
 * Resolve a single profile the tenant may see: its own (editable) or a
 * shared lead-owned profile (read-only). Returns null when the id is
 * neither owned nor validly shared into this tenant.
 */
export async function getVisibleProfile(
  db: DrizzleD1Database<any>,
  tenant: Tenant,
  profileId: string,
): Promise<VisibleProfile | null> {
  const row = (await db
    .select()
    .from(importProfiles)
    .where(eq(importProfiles.id, profileId))
    .get()) as ProfileRow | undefined;
  if (!row) return null;

  if (row.tenantId === tenant.id) return { ...row, readOnly: false };

  const leadId = await federationLeadTenantId(db, tenant);
  if (leadId && row.tenantId === leadId && row.sharedWithFederation) {
    return { ...row, readOnly: true };
  }
  return null;
}

export interface SaveProfileInput {
  tenantId: string;
  standard: Standard;
  name: string;
  bindings: unknown;
  sharedWithFederation: boolean;
  userId: string;
  /**
   * Stamped on the row when a starter profile is minted (phase 7); absent
   * for a hand-built profile, which stores `null`. Definition updates never
   * reach a minted row, so this is a provenance tag, not a live link.
   */
  starterKey?: string;
}

export type SaveProfileResult =
  | { ok: true; id: string; version: number }
  | {
      ok: false;
      error: string;
      issues?: string[];
      /**
       * On `duplicate_name`: the id of the profile already holding the
       * name, so the error can LINK to it (a notice must propose the fix,
       * never just name the problem). Absent when the conflicting row
       * cannot be resolved.
       */
      existingId?: string;
    };

// Validate a bindings payload structurally (Zod) and against the
// tenant's descriptive standard (target legality). Returns the parsed
// bindings or a flat list of issue tokens.
function validateBindings(
  bindings: unknown,
  standard: Standard,
): { ok: true; value: ProfileBindings } | { ok: false; issues: string[] } {
  const parsed = parseProfileBindings(bindings);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => i.message),
    };
  }
  const badTargets = parsed.data
    .map((b) => b.target)
    .filter((target) => !isValidTarget(standard, target));
  if (badTargets.length > 0) {
    return {
      ok: false,
      issues: badTargets.map((t) => `invalid_target:${t}`),
    };
  }
  return { ok: true, value: parsed.data };
}

// Profile names are unique per tenant (the 0064 unique index on
// (tenant_id, name)); a violation must surface as a typed result, never
// an unhandled 500. Drizzle wraps the D1 error, so the SQLite message
// must be looked for down the `cause` chain, not only on the top error.
function isUniqueNameViolation(e: unknown): boolean {
  let current: unknown = e;
  for (let depth = 0; current != null && depth < 5; depth++) {
    if (String(current).includes("UNIQUE constraint failed")) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The typed `duplicate_name` result, carrying the conflicting profile's id
 * when it resolves (one read on the same (tenant_id, name) key the unique
 * index guards). The lookup is best-effort: a miss still returns the named
 * error, just without a link target.
 */
async function duplicateNameResult(
  db: DrizzleD1Database<any>,
  tenantId: string,
  name: string,
): Promise<SaveProfileResult> {
  const existing = await db
    .select({ id: importProfiles.id })
    .from(importProfiles)
    .where(and(eq(importProfiles.tenantId, tenantId), eq(importProfiles.name, name)))
    .get();
  return { ok: false, error: "duplicate_name", existingId: existing?.id };
}

/** Create a new profile owned by the tenant. Version starts at 1. */
export async function createProfile(
  db: DrizzleD1Database<any>,
  input: SaveProfileInput,
): Promise<SaveProfileResult> {
  const valid = validateBindings(input.bindings, input.standard);
  if (!valid.ok) return { ok: false, error: "invalid_bindings", issues: valid.issues };

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    await db.insert(importProfiles).values({
      id,
      tenantId: input.tenantId,
      name: input.name,
      version: 1,
      bindings: JSON.stringify(valid.value),
      starterKey: input.starterKey ?? null,
      sharedWithFederation: input.sharedWithFederation,
      createdBy: input.userId,
      updatedBy: input.userId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (isUniqueNameViolation(e)) {
      return duplicateNameResult(db, input.tenantId, input.name);
    }
    throw e;
  }
  return { ok: true, id, version: 1 };
}

/**
 * Update an existing profile the tenant OWNS. Stamps `updatedBy` /
 * `updatedAt` on every edit, but bumps `version` ONLY when the bindings
 * actually changed — the version pins a mapping (runs record
 * (profileId, profileVersion)), so a rename or share-toggle must not
 * move it. A read-only shared profile (owned by the lead) is not
 * editable here — callers resolve editability via `getVisibleProfile`
 * first, and this guard is the backstop.
 */
export async function updateProfile(
  db: DrizzleD1Database<any>,
  profileId: string,
  input: SaveProfileInput,
): Promise<SaveProfileResult> {
  const existing = (await db
    .select()
    .from(importProfiles)
    .where(eq(importProfiles.id, profileId))
    .get()) as ProfileRow | undefined;
  if (!existing || existing.tenantId !== input.tenantId) {
    return { ok: false, error: "not_found" };
  }

  const valid = validateBindings(input.bindings, input.standard);
  if (!valid.ok) return { ok: false, error: "invalid_bindings", issues: valid.issues };

  // Both sides of the comparison come from the same serializer over the
  // same Zod-parsed shape, so string equality is canonical enough.
  const nextBindings = JSON.stringify(valid.value);
  const bindingsChanged = nextBindings !== existing.bindings;
  const nextVersion = bindingsChanged ? existing.version + 1 : existing.version;

  try {
    await db
      .update(importProfiles)
      .set({
        name: input.name,
        bindings: nextBindings,
        sharedWithFederation: input.sharedWithFederation,
        version: nextVersion,
        updatedBy: input.userId,
        updatedAt: Date.now(),
      })
      .where(eq(importProfiles.id, profileId));
  } catch (e) {
    if (isUniqueNameViolation(e)) {
      return duplicateNameResult(db, input.tenantId, input.name);
    }
    throw e;
  }
  return { ok: true, id: profileId, version: nextVersion };
}

/**
 * Delete a profile the tenant owns. Allowed (spec §7): runs and uploads
 * keep FK-free pointers, so a delete leaves those intact. Returns false
 * when the profile is not owned by the tenant.
 */
export async function deleteProfile(
  db: DrizzleD1Database<any>,
  tenantId: string,
  profileId: string,
): Promise<boolean> {
  const existing = (await db
    .select({ tenantId: importProfiles.tenantId })
    .from(importProfiles)
    .where(eq(importProfiles.id, profileId))
    .get()) as { tenantId: string } | undefined;
  if (!existing || existing.tenantId !== tenantId) return false;
  await db.delete(importProfiles).where(eq(importProfiles.id, profileId));
  return true;
}
