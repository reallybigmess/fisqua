/**
 * Tests — workbench action-bar layout contract (UAT regression)
 *
 * Pins the positioning contract exported by
 * `app/components/admin/workbench-action-bar.tsx` after the UAT defect
 * where the merge/split sticky bar rendered as a cramped translucent
 * strip with the app footer's "Fisqua vX.Y.Z" link painting through
 * it. Two mechanisms:
 *
 *   - the bar was `fixed inset-x-0` with `bg-white/95 backdrop-blur`
 *     and NO z-index — the footer is an `absolute` element rendered
 *     AFTER the outlet in the content column, so at equal (auto)
 *     stacking the later-painted footer showed through the translucent
 *     bar; `fixed` also spanned the whole viewport, landing under the
 *     sidebar instead of tracking the content container;
 *   - the inner layout packed label, input, button, summary, and
 *     validation error into one compressed block with no row rhythm.
 *
 * The contract pinned: sticky-in-column (never fixed/viewport-
 * spanning), opaque background (no alpha suffix, no backdrop-blur),
 * an explicit z-index above the footer, a visible border, and a
 * separated meta row. Same Workers-pool pure-contract pattern as
 * `place-maps-layout.test.ts` — no rendering.
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import {
  ACTION_BAR_CLASSES,
  ACTION_BAR_INNER_CLASSES,
  ACTION_BAR_META_ROW_CLASSES,
} from "../../app/components/admin/workbench-action-bar";

describe("workbench action-bar layout contract", () => {
  const classes = ACTION_BAR_CLASSES.split(/\s+/);

  it("is sticky inside the scroll column — never viewport-fixed", () => {
    expect(classes).toContain("sticky");
    expect(classes).toContain("bottom-0");
    // `fixed inset-x-0` spans the viewport: it lands under the sidebar
    // and detaches from the content container's width.
    expect(classes).not.toContain("fixed");
    expect(classes).not.toContain("inset-x-0");
  });

  it("has an opaque background — no alpha, no backdrop-blur", () => {
    expect(classes).toContain("bg-white");
    // A translucent bg (bg-white/NN) lets the footer's version link
    // ghost through the bar regardless of stacking.
    expect(classes.some((c) => c.startsWith("bg-white/"))).toBe(false);
    expect(classes.some((c) => c.startsWith("backdrop-blur"))).toBe(false);
  });

  it("stacks above the app footer with an explicit z-index", () => {
    // The footer is absolute + later in the DOM: at z-auto it paints
    // over the bar. Any explicit positive z-utility wins; below the
    // sidebar overlay's z-30.
    expect(classes.some((c) => /^z-(10|20)$/.test(c))).toBe(true);
  });

  it("reads as a bordered surface, not a bare strip", () => {
    expect(classes).toContain("border");
    expect(classes.some((c) => c.startsWith("border-stone"))).toBe(true);
    expect(classes.some((c) => c.startsWith("shadow"))).toBe(true);
  });

  it("keeps deliberate inner rhythm and a separated meta row", () => {
    const inner = ACTION_BAR_INNER_CLASSES.split(/\s+/);
    expect(inner.some((c) => /^gap-\d/.test(c))).toBe(true);
    expect(inner.some((c) => /^px-\d/.test(c))).toBe(true);
    expect(inner.some((c) => /^py-\d/.test(c))).toBe(true);

    const meta = ACTION_BAR_META_ROW_CLASSES.split(/\s+/);
    // The summary/validation line is visually separated from the input
    // row (the compression defect packed them together).
    expect(meta).toContain("border-t");
    expect(meta.some((c) => /^pt-\d/.test(c))).toBe(true);
  });
});
