/**
 * RAD EAD3 Profile
 *
 * This profile deals with shaping EAD3 output for tenants whose
 * `descriptiveStandard` is RAD (Rules for Archival Description,
 * Canadian Council of Archives 2008).
 * Per-level mandatoriness is imported from `app/lib/standards/rad.ts`
 * (RAD_REQUIRED_BY_LEVEL — RAD's six elements mandatory at every
 * level plus per-level adds; see the assumption caveat in that file).
 * This profile declares only the EAD-specific wrapping/placement
 * choices on top.
 *
 * Element placement reflects RAD:
 *   - "Custodial History" (RAD §1.7) → narrative under `<archdesc>` via
 *     `<bioghist>` for the admin/biog half. RAD treats custodial history
 *     as a context element rather than a notes element; placement is
 *     "context" (parallel to DACS, distinct from ISAD(G)).
 *   - "System of arrangement" (RAD §1.8) → emitted as `<arrangement>`
 *     when `systemOfArrangement` is populated. RAD §1.8B Note that
 *     arrangement is a separate, non-collapsible element at fonds level;
 *     the profile gates it ON.
 *   - "Custodial history / Source of acquisition" → `<acqinfo>` when
 *     `acquisitionInfo` is populated.
 *   - Preferred citation: not part of canonical RAD; left OFF here.
 *
 * `unitdateWrapping: "single"` follows the AtoM-RAD intersection
 * convention (single date string per `<unitdate>`); RNG validation
 * surfaces any drift.
 *
 * @version v0.4.0
 */

import { RAD_CONFIG } from "../../../standards/rad";
import type { EadProfile } from "../../types";

export const RAD_EAD_PROFILE: EadProfile = {
  standard: "rad",
  requiredFieldsForLevel: RAD_CONFIG.requiredFieldsForLevel,
  bioghistPlacement: "context",
  unitdateWrapping: "single",
  includeAdminBiogHistory: true,
  includePreferredCitation: false,
  includeAcquisitionInfo: true,
  includeSystemOfArrangement: true,
};

/* @version v0.4.0 */
