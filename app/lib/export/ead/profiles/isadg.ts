/**
 * ISAD(G) EAD3 Profile
 *
 * This profile deals with shaping EAD3 output for tenants whose
 * `descriptiveStandard` is ISAD(G) (General International Standard
 * Archival Description, 2nd ed.).
 * Per-level mandatoriness is imported from `app/lib/standards/isadg.ts`
 * (the single source of truth) — this file declares only the
 * EAD-specific wrapping/placement choices on top.
 *
 * Element placement reflects ISAD(G):
 *   - 3.4.1 Administrative/biographical history → emitted under `<notestmt>`
 *     rather than as a top-level `<bioghist>`. ISAD(G) places biographical
 *     and administrative history in the "Notes" area, not the "Context"
 *     area DACS uses.
 *   - 3.2.4 Immediate source of acquisition → emitted as `<acqinfo>` when
 *     `acquisitionInfo` is populated.
 *   - 3.4 Notes area / 3.5 Allied materials area: Preferred citation is
 *     not part of ISAD(G) (it is a DACS § 7.1.5 element) — left off here.
 *   - 3.3.4 System of arrangement: present in ISAD(G) as `arrangement`
 *     narrative; profile gates it OFF and lets the standard `<arrangement>`
 *     emission cover the same column. Toggling it ON would double-emit.
 *
 * Adding a fourth standard later = adding a sibling profile module under
 * `app/lib/export/ead/profiles/` and one entry in `registry.ts`.
 *
 * @version v0.4.0
 */

import { ISADG_CONFIG } from "../../../standards/isadg";
import type { EadProfile } from "../../types";

export const ISADG_EAD_PROFILE: EadProfile = {
  standard: "isadg",
  requiredFieldsForLevel: ISADG_CONFIG.requiredFieldsForLevel,
  bioghistPlacement: "notes",
  unitdateWrapping: "ranged",
  includeAdminBiogHistory: false,
  includePreferredCitation: false,
  includeAcquisitionInfo: true,
  includeSystemOfArrangement: false,
};

/* @version v0.4.0 */
