/**
 * Description Workflow State Machine
 *
 * This module deals with the per-entry workflow that governs how a
 * description moves from `unassigned` through cataloguing, review, and
 * approval — the description-side analogue of the volume-level
 * segmentation workflow in `./workflow.ts`. Where segmentation tracks
 * whole volumes through their digitisation lifecycle, this state
 * machine tracks each individual entry inside a volume as a cataloguer
 * drafts a description, hands it to a reviewer, and either lands it as
 * approved or bounces it back for another pass.
 *
 * The functions exported here are pure: they decide whether a given
 * role may move an entry from one `DescriptionStatus` to another, and
 * enumerate the legal next states for the workflow UI. They do not
 * touch the database — server-side transition execution (audit
 * writes, denormalised-field updates, notification triggers) lives in
 * `./description.server.ts`, which calls into this module for the
 * validity decision before mutating any rows.
 *
 * @version v0.4.1
 */

import type { WorkflowRole } from "./workflow";
import type { ResourceTypeEs } from "./validation/enums";

export type DescriptionStatus =
  | "unassigned"
  | "assigned"
  | "in_progress"
  | "described"
  | "reviewed"
  | "approved"
  | "sent_back";

/**
 * The description-form fields an autosave may carry. This is the
 * SINGLE registry for the client payload builder and the server's
 * write allowlist — the two surfaces used to declare it separately,
 * and a field present on one side but not the other saves silently
 * into nowhere (the title-field incident: the editor's save pill
 * cycled while `entries.title` never changed). Pure and client-safe;
 * `description.server.ts` re-exports both names for server callers.
 */
export type DescriptionFields = {
  title?: string | null;
  translatedTitle?: string | null;
  resourceType?: ResourceTypeEs | null;
  dateExpression?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  extent?: string | null;
  scopeContent?: string | null;
  language?: string | null;
  descriptionNotes?: string | null;
  internalNotes?: string | null;
};

/**
 * Column keys the description autosave is allowed to touch, on both
 * sides of the wire. Listed explicitly (rather than derived from
 * `Object.keys` on an incoming payload) so the server writer cannot
 * be coaxed into writing arbitrary columns by a caller that smuggles
 * extra keys in. The `satisfies` clause pins the tuple to the type:
 * adding a field to one without the other fails the compile.
 */
export const DESCRIPTION_FIELD_KEYS = [
  "title",
  "translatedTitle",
  "resourceType",
  "dateExpression",
  "dateStart",
  "dateEnd",
  "extent",
  "scopeContent",
  "language",
  "descriptionNotes",
  "internalNotes",
] as const satisfies ReadonlyArray<keyof DescriptionFields>;

// The satisfies clause above only pins tuple ⊆ type. This alias pins
// the other direction: a field added to DescriptionFields but missing
// from the tuple makes the Exclude non-never and fails the compile.
type _AssertNever<T extends never> = T;
export type _AllDescriptionFieldsListed = _AssertNever<
  Exclude<keyof DescriptionFields, (typeof DESCRIPTION_FIELD_KEYS)[number]>
>;

const DESC_TRANSITIONS: Record<
  WorkflowRole,
  Partial<Record<DescriptionStatus, DescriptionStatus[]>>
> = {
  cataloguer: {
    assigned: ["in_progress"],
    in_progress: ["described"],
    sent_back: ["in_progress"],
  },
  reviewer: {
    described: ["reviewed", "sent_back"],
  },
  lead: {
    unassigned: ["assigned"],
    assigned: ["in_progress", "described", "reviewed", "approved"],
    in_progress: ["assigned", "described", "reviewed", "approved"],
    described: ["in_progress", "reviewed", "approved", "sent_back"],
    reviewed: ["described", "approved", "sent_back"],
    approved: ["reviewed", "described"],
    sent_back: ["in_progress", "described"],
  },
};

/**
 * Get the list of valid target description statuses for a given current
 * status and role.
 */
export function getValidDescriptionTransitions(
  currentStatus: DescriptionStatus,
  role: WorkflowRole
): DescriptionStatus[] {
  return DESC_TRANSITIONS[role]?.[currentStatus] ?? [];
}

/**
 * Check whether a specific description status transition is valid for a
 * given role.
 */
export function canDescriptionTransition(
  currentStatus: DescriptionStatus,
  targetStatus: DescriptionStatus,
  role: WorkflowRole
): boolean {
  return getValidDescriptionTransitions(currentStatus, role).includes(targetStatus);
}

/**
 * Description status styles -- distinct colour palette from segmentation.
 * Each status maps to Tailwind bg and text classes using Figma design tokens.
 */
export const DESCRIPTION_STATUS_STYLES: Record<
  DescriptionStatus,
  { bg: string; text: string }
> = {
  unassigned: { bg: "bg-[#E7E5E4]", text: "text-[#78716C]" },
  assigned: { bg: "bg-[#DDE3EE]", text: "text-[#1F2E4D]" },
  in_progress: { bg: "bg-[#F5E6C7]", text: "text-[#8B5E14]" },
  described: { bg: "bg-[#E1ECDF]", text: "text-[#3E5C45]" },
  reviewed: { bg: "bg-[#DCEAE6]", text: "text-[#3E7A6E]" },
  approved: { bg: "bg-[#DCEAE6]", text: "text-[#3E7A6E]" },
  sent_back: { bg: "bg-[#DDE3EE]", text: "text-[#1F2E4D]" },
};

/**
 * i18n label keys for description statuses. Use with t(`description:status.${key}`).
 */
export const DESCRIPTION_STATUS_LABELS: Record<DescriptionStatus, string> = {
  unassigned: "status.unassigned",
  assigned: "status.assigned",
  in_progress: "status.in_progress",
  described: "status.described",
  reviewed: "status.reviewed",
  approved: "status.approved",
  sent_back: "status.sent_back",
};
