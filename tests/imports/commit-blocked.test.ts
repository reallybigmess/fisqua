/**
 * Tests — the commit button's disabled-reason priority
 *
 * A disabled control must name its reason: the Import pane renders the
 * FIRST unmet condition beneath the commit button, and this pure helper
 * is that single priority order. Pinned: each condition in priority,
 * the enabled (null) case, and that `noRepositories` is still returned
 * (the pane suppresses its line — the teaching notice covers it — but
 * the priority itself stays total).
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { commitBlockedReason } from "../../app/lib/import/commit-blocked";

const READY = {
  staged: true,
  hasReport: true,
  profileStale: false,
  hasRepositories: true,
  attested: true,
};

describe("commitBlockedReason — first unmet condition wins", () => {
  it("returns null when every condition is met (button enabled)", () => {
    expect(commitBlockedReason(READY)).toBeNull();
  });

  it("notStaged outranks everything", () => {
    expect(
      commitBlockedReason({
        staged: false,
        hasReport: false,
        profileStale: true,
        hasRepositories: false,
        attested: false,
      }),
    ).toBe("notStaged");
  });

  it("noReport outranks profileStale, repositories, and attestation", () => {
    expect(
      commitBlockedReason({
        ...READY,
        hasReport: false,
        profileStale: true,
        hasRepositories: false,
        attested: false,
      }),
    ).toBe("noReport");
  });

  it("profileStale outranks repositories and attestation", () => {
    expect(
      commitBlockedReason({ ...READY, profileStale: true, hasRepositories: false, attested: false }),
    ).toBe("profileStale");
  });

  it("noRepositories outranks attestation (the pane suppresses its line)", () => {
    expect(commitBlockedReason({ ...READY, hasRepositories: false, attested: false })).toBe(
      "noRepositories",
    );
  });

  it("attest is the last gate", () => {
    expect(commitBlockedReason({ ...READY, attested: false })).toBe("attest");
  });
});
