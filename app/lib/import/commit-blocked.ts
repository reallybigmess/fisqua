/**
 * Import commit — why the button is disabled, by name
 *
 * A disabled control must name its reason (the module's honesty bar): the
 * Import pane's commit button renders a quiet reason line beneath it while
 * disabled. This helper is the single priority order — the FIRST unmet
 * condition wins, matching the pane's own gating — kept pure so the seam
 * is testable without a render harness.
 *
 * `noRepositories` is still returned (the priority is total), but the pane
 * suppresses its line: the add-a-repository teaching notice already covers
 * that state, and the reason line must never double-render it.
 *
 * @version v0.6.0
 */

export type CommitBlockedReason =
  | "notStaged"
  | "noReport"
  | "profileStale"
  | "noRepositories"
  | "attest";

export interface CommitGateInput {
  staged: boolean;
  hasReport: boolean;
  profileStale: boolean;
  hasRepositories: boolean;
  attested: boolean;
}

/** The first unmet commit condition, or null when the button is enabled. */
export function commitBlockedReason(input: CommitGateInput): CommitBlockedReason | null {
  if (!input.staged) return "notStaged";
  if (!input.hasReport) return "noReport";
  if (input.profileStale) return "profileStale";
  if (!input.hasRepositories) return "noRepositories";
  if (!input.attested) return "attest";
  return null;
}
