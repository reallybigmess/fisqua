/**
 * Tests — intent-scoped pending state for the journey's busy buttons
 *
 * Several forms post to the SAME journey route (accept / undo / run /
 * commit), so a button may only show busy while the in-flight submission
 * carries ITS intent. `isPendingIntent` is that seam: pinned here for the
 * submitting phase, the post-action loading phase (the redirect — the
 * button stays busy until the next page renders), the idle case, and the
 * wrong-intent case.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { isPendingIntent } from "../../app/components/imports/busy-submit";

function form(intent: string): FormData {
  const f = new FormData();
  f.set("intent", intent);
  return f;
}

describe("isPendingIntent — busy only for the submitting intent", () => {
  it("is pending while submitting with the matching intent", () => {
    expect(isPendingIntent("submitting", form("run"), "run")).toBe(true);
  });

  it("stays pending through the post-action redirect (loading)", () => {
    expect(isPendingIntent("loading", form("commit"), "commit")).toBe(true);
  });

  it("is not pending when idle", () => {
    expect(isPendingIntent("idle", form("run"), "run")).toBe(false);
  });

  it("is not pending for a DIFFERENT intent's submission", () => {
    expect(isPendingIntent("submitting", form("accept"), "run")).toBe(false);
    expect(isPendingIntent("submitting", form("run"), "commit")).toBe(false);
  });

  it("is not pending for a plain link navigation (no form data)", () => {
    expect(isPendingIntent("loading", undefined, "run")).toBe(false);
  });
});
