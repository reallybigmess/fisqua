/**
 * DACS EAD3 Profile
 *
 * This profile deals with shaping EAD3 output for tenants whose
 * `descriptiveStandard` is DACS (Describing Archives: A Content
 * Standard, SAA 2nd ed.). DACS is the profile the layer 2 shape-lint
 * suite targets — it must surface the
 * DACS Single-Level Minimum element set at every `<archdesc>`, since
 * DACS is the standard with a concrete downstream aggregator
 * commitment (ArchivesGrid / DPLA via OAI-PMH).
 *
 * Per-level mandatoriness is imported from `app/lib/standards/dacs.ts`
 * (DACS_REQUIRED_BY_LEVEL → 10 elements at fonds level per DACS § 1.4)
 * — this file declares only the EAD-specific wrapping/placement
 * choices on top.
 *
 * Element placement reflects DACS:
 *   - § 2.7 Administrative/biographical history → emitted as `<bioghist>`
 *     directly under `<archdesc>`. DACS treats biographical history as a
 *     CONTEXT element, not a notes element.
 *   - § 5 Acquisition and appraisal → `<acqinfo>` (single-level optimum).
 *   - § 7.1.5 Preferred citation → `<prefercite>` (single-level optimum,
 *     surfaced when `preferredCitation` column is populated).
 *   - § 3.2 System of arrangement → emitted via the standard
 *     `<arrangement>` block; the profile-level toggle stays OFF to avoid
 *     double-emitting alongside the systemOfArrangement column.
 *
 * `unitdateWrapping: "single"` reflects DACS § 2.4: dates are emitted
 * as a single string per `<unitdate>` rather than wrapped in a range
 * element. RNG validation catches any drift.
 *
 * @version v0.4.0
 */

import { DACS_CONFIG } from "../../../standards/dacs";
import type { EadProfile } from "../../types";

export const DACS_EAD_PROFILE: EadProfile = {
  standard: "dacs",
  requiredFieldsForLevel: DACS_CONFIG.requiredFieldsForLevel,
  bioghistPlacement: "context",
  unitdateWrapping: "single",
  includeAdminBiogHistory: true,
  includePreferredCitation: true,
  includeAcquisitionInfo: true,
  includeSystemOfArrangement: false,
};

/* @version v0.4.0 */
