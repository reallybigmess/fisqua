/**
 * Import starter minting — pick a starter, mint a per-tenant profile
 *
 * This module deals with turning a starter PICK into a normal
 * `import_profiles` row (spec §8). A starter is a code definition
 * (`./starters`) or the generated canonical template
 * (`./canonical-template`); picking one mints an ordinary per-tenant
 * profile through `createProfile` (version 1, `starterKey` stamped,
 * `createdBy` = the picking admin, name = the definition's stable
 * `defaultName`). Nothing here is a seeded row and nothing links back to
 * the definition — a later definition edit never touches minted profiles.
 *
 * The unique `(tenantId, name)` index governs re-minting: the second mint
 * of the same starter surfaces the existing `duplicate_name` path, so a
 * tenant re-mints only under a different name (the admin renames in the
 * editor, then re-picks — v1 keeps the pick name-stable and defers renaming
 * to the editor). Offer legality is re-checked here as a backstop: a
 * starter not offered for the tenant's standard cannot be minted even if
 * the key is posted directly.
 *
 * @version v0.6.0
 */

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Standard } from "../standards/types";
import { createProfile, type SaveProfileResult } from "./profiles.server";
import { getStarterDefinition, startersForStandard } from "./starters";
import {
  CANONICAL_DEFAULT_NAME,
  CANONICAL_STARTER_KEY,
  generateCanonicalBindings,
} from "./canonical-template";

export interface MintStarterInput {
  tenantId: string;
  standard: Standard;
  userId: string;
  /** The starter key to mint — an external-format key or the canonical key. */
  starterKey: string;
}

/**
 * Mint a starter into a per-tenant profile. Returns the same
 * `SaveProfileResult` as `createProfile` (so the route surfaces
 * `duplicate_name` the same way), or `{ ok: false, error: "not_offered" }`
 * when the key is unknown or not offered for the tenant's standard.
 */
export async function mintStarter(
  db: DrizzleD1Database<any>,
  input: MintStarterInput,
): Promise<SaveProfileResult | { ok: false; error: "not_offered" }> {
  // The canonical template is generated per standard and offered for every
  // standard (its bindings project the standard's own union schema).
  if (input.starterKey === CANONICAL_STARTER_KEY) {
    return createProfile(db, {
      tenantId: input.tenantId,
      standard: input.standard,
      name: CANONICAL_DEFAULT_NAME,
      bindings: generateCanonicalBindings(input.standard),
      sharedWithFederation: false,
      userId: input.userId,
      starterKey: CANONICAL_STARTER_KEY,
    });
  }

  const definition = getStarterDefinition(input.starterKey);
  const offered = startersForStandard(input.standard).some(
    (s) => s.key === input.starterKey,
  );
  if (!definition || !offered) return { ok: false, error: "not_offered" };

  return createProfile(db, {
    tenantId: input.tenantId,
    standard: input.standard,
    name: definition.defaultName,
    // A fresh copy of the definition's bindings — the row owns its mapping
    // from mint time; a later definition edit does not reach it.
    bindings: definition.bindings.map((b) => ({ ...b })),
    sharedWithFederation: false,
    userId: input.userId,
    starterKey: definition.key,
  });
}
