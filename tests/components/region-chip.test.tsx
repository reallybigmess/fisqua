/**
 * Tests — region chip i18n + class helpers
 *
 * This suite pins the two pure helpers that back the region-chip
 * display: `computeChipLabelArgs` (builds the `t(...)` invocation
 * shape — key, vars, defaultValue) and `computeChipClassName` (the
 * Tailwind class composition that carries the chip's status
 * variant). The label helper carries a Colombian-Spanish
 * `defaultValue` ("Región · p. N" with the U+00B7 middle dot) so
 * the chip renders correctly even before the locale key is
 * registered upstream.
 *
 * No React rendering — the helpers are pure functions returning
 * scalars or struct args, and the i18n contract (key + vars +
 * defaultValue) is exactly what's pinned here so a future refactor
 * cannot silently drop the middle-dot separator or change the page
 * interpolation contract.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import {
  computeChipLabelArgs,
  computeChipClassName,
} from "../../app/components/comments/region-chip";

describe("computeChipLabelArgs", () => {
  it("returns the 'regions:chip.label' key with the page interpolation var --", () => {
    const args = computeChipLabelArgs(3);
    expect(args.key).toBe("regions:chip.label");
    expect(args.vars).toEqual({ page: 3 });
  });

  it("produces a Colombian-Spanish default value until the locale key is registered", () => {
    const args = computeChipLabelArgs(7);
    // "Región · p. 7" -- middle dot U+00B7 per CONTEXT.
    expect(args.defaultValue).toBe("Región · p. 7");
    expect(args.defaultValue).toContain("Región");
    expect(args.defaultValue).toContain("p. 7");
  });

  it("uses the raw pageNumber for the page var (no conversion)", () => {
    expect(computeChipLabelArgs(1).vars.page).toBe(1);
    expect(computeChipLabelArgs(42).vars.page).toBe(42);
  });
});

describe("computeChipClassName", () => {
  it("uses stone-100 background and stone-200 border tokens", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("bg-stone-100");
    expect(cls).toContain("border-stone-200");
  });

  it("uses stone-600 text at sans 10px bold --,", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("text-stone-600");
    expect(cls).toContain("text-10");
    expect(cls).toContain("font-bold");
    expect(cls).toContain("font-sans");
  });

  it("renders as an inline-flex with gap-1 and small padding", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("inline-flex");
    expect(cls).toContain("items-center");
    expect(cls).toContain("gap-1");
    expect(cls).toContain("px-2");
    expect(cls).toContain("py-1");
    expect(cls).toContain("rounded");
  });

  it("includes a focus ring tied to the indigo accent --", () => {
    const cls = computeChipClassName();
    expect(cls).toContain("focus:ring-indigo/40");
  });
});

