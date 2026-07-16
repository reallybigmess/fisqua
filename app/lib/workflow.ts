/**
 * Volume Status Workflow State Machine
 *
 * This module deals with the pure state machine that governs how a
 * volume moves through its segmentation lifecycle —
 * `unstarted → in_progress → segmented → reviewed → approved`, with
 * `sent_back` as the bounce path a reviewer triggers when a volume
 * needs more work. Each role (cataloguer, reviewer, lead) sees its
 * own allowed transitions, so the same status can permit different
 * moves depending on who is asking; this is the canonical place that
 * decision lives, and the server-side helpers in
 * `./workflow.server.ts` route every mutation through here before
 * touching D1.
 *
 * The functions exported here are pure — no DB reads, no React, no
 * side effects — so the pipeline board, the volume header, and the
 * action that actually writes the new status can all call the same
 * predicate and agree on the answer. The description-side analogue
 * lives in `./description-workflow.ts` and follows the same shape;
 * keeping the two state machines separate reflects the fact that
 * segmentation and description proceed at different cadences.
 *
 * @version v0.4.1
 */

import type { ProjectRole, VolumeStatus } from "./validation/enums";

// VolumeStatus is derived from the canonical `VOLUME_STATUSES` array
// (app/lib/validation/enums.ts). Imported locally for the state machine
// below and re-exported so the many modules that import `VolumeStatus`
// from here keep working.
export type { VolumeStatus };

// Project roles, viewed through the workflow lens. Aliased to the
// canonical `ProjectRole` so the role vocabulary has one source.
export type WorkflowRole = ProjectRole;

// Workflow-role precedence, highest first. This is NOT the same as
// PROJECT_ROLES from validation/enums, whose declaration order
// (lead, cataloguer, reviewer) is arbitrary — deriving precedence
// from it would rank cataloguer above reviewer.
export const WORKFLOW_ROLE_PRECEDENCE = [
  "lead",
  "reviewer",
  "cataloguer",
] as const satisfies readonly WorkflowRole[];

/**
 * The user's highest workflow role among the given membership rows,
 * or null with no memberships. A user can hold several roles on one
 * project (project_members has no (project, user) uniqueness), so
 * callers must never read a single row's role — row order is not
 * precedence. Pure and client-safe; the server-side permission
 * helpers re-export it.
 */
export function highestProjectRole(
  memberships: { role: string }[],
): WorkflowRole | null {
  return (
    WORKFLOW_ROLE_PRECEDENCE.find((r) =>
      memberships.some((m) => m.role === r),
    ) ?? null
  );
}

const TRANSITIONS: Record<
  WorkflowRole,
  Partial<Record<VolumeStatus, VolumeStatus[]>>
> = {
  cataloguer: {
    unstarted: ["in_progress"],
    in_progress: ["segmented"],
    sent_back: ["in_progress"],
  },
  reviewer: {
    segmented: ["reviewed"],
    reviewed: ["approved", "sent_back"],
  },
  lead: {
    unstarted: ["in_progress", "segmented", "sent_back", "reviewed", "approved"],
    in_progress: ["unstarted", "segmented", "sent_back", "reviewed", "approved"],
    segmented: ["unstarted", "in_progress", "sent_back", "reviewed", "approved"],
    sent_back: ["unstarted", "in_progress", "segmented", "reviewed", "approved"],
    reviewed: ["unstarted", "in_progress", "segmented", "sent_back", "approved"],
    approved: ["unstarted", "in_progress", "segmented", "sent_back", "reviewed"],
  },
};

/**
 * Get the list of valid target statuses for a given current status and role.
 */
export function getValidTransitions(
  currentStatus: VolumeStatus,
  role: WorkflowRole
): VolumeStatus[] {
  return TRANSITIONS[role]?.[currentStatus] ?? [];
}

/**
 * Check whether a specific status transition is valid for a given role.
 */
export function canTransition(
  currentStatus: VolumeStatus,
  targetStatus: VolumeStatus,
  role: WorkflowRole
): boolean {
  return getValidTransitions(currentStatus, role).includes(targetStatus);
}
