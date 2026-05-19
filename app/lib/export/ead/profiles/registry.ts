/**
 * EAD3 Profile Registry
 *
 * This module deals with the closed-map lookup of EAD3 profiles plus
 * a throw-on-unknown resolver — pattern lifted byte-for-byte from
 * `app/lib/standards/registry.ts:32-60`. The closed-map shape gives
 * TypeScript an exhaustiveness gate (`Readonly<Record<Standard, EadProfile>>`):
 * adding a fourth standard later means dropping a fourth profile module
 * AND adding it here, or the compiler complains. Runtime safety is the
 * `Unknown descriptive standard: <x>` throw — no silent fallback for
 * unknown standards.
 *
 * Caller pattern (the publish pipeline wires this in):
 *
 *   const profile = getEadProfile(tenant.descriptiveStandard);
 *   const xml = buildEad3(fondsRows, repos, profile, createDate);
 *
 * @version v0.4.0
 */

import type { Standard } from "../../../standards/types";
import type { EadProfile } from "../../types";
import { ISADG_EAD_PROFILE } from "./isadg";
import { DACS_EAD_PROFILE } from "./dacs";
import { RAD_EAD_PROFILE } from "./rad";

/**
 * Closed registry of EAD3 profiles. Adding a fourth standard later =
 * adding a profile module under `app/lib/export/ead/profiles/` and an
 * entry here. The grep keystone (`tests/standards/no-hardcoded-standards.test.ts`)
 * allowlists this file because the literal triple appears here as
 * legitimate object keys, identical to the standards registry.
 */
const PROFILES: Readonly<Record<Standard, EadProfile>> = {
  isadg: ISADG_EAD_PROFILE,
  dacs: DACS_EAD_PROFILE,
  rad: RAD_EAD_PROFILE,
};

/**
 * Resolve the EAD3 profile for a standard. Throws on unknown — an
 * unknown standard is a schema-invariant violation
 * (`tenants.descriptive_standard` CHECK enforces NOT NULL when
 * `kind = 'tenant'`); the caller should never pass a value the schema
 * cannot have produced. Silently defaulting would mask schema corruption
 * and emit ISAD-shaped EAD3 for what should be a DACS- or RAD-shaped
 * document.
 */
export function getEadProfile(standard: Standard): EadProfile {
  const profile = PROFILES[standard];
  if (!profile) {
    throw new Error(`Unknown descriptive standard: ${standard}`);
  }
  return profile;
}

/* @version v0.4.0 */
