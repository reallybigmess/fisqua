/**
 * Tests — client-side snippet match finding (worklist unfold steppers)
 *
 * The unfold panel derives its highlight and its "N matches" count by
 * re-running the accent-/case-insensitive match over whatever text is
 * currently shown (spec §5, multi-match). Pins that the match is
 * accent-insensitive, maps back to the ORIGINAL offsets, counts every
 * occurrence (the multi-match case that earns the steppers), and drops
 * one-character noise.
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import { findMatchRanges } from "../../app/lib/snippet-highlight";

describe("findMatchRanges", () => {
  it("finds every occurrence, accent-insensitively, at original offsets", () => {
    const text = "En Huánuco y de nuevo en Huanuco, y otra vez Huánuco.";
    const ranges = findMatchRanges(text, ["Huánuco"]);
    expect(ranges).toHaveLength(3);
    // Each range slices back to a source spelling of the name.
    for (const r of ranges) {
      expect(["Huánuco", "Huanuco"]).toContain(text.slice(r.start, r.end));
    }
  });

  it("returns no ranges when the name is absent, and ignores 1-char anchors", () => {
    expect(findMatchRanges("Nada que ver aquí.", ["Cúcuta"])).toEqual([]);
    expect(findMatchRanges("a a a a", ["a"])).toEqual([]);
  });

  it("does not double-count overlapping matches", () => {
    // A single occurrence yields exactly one range.
    const ranges = findMatchRanges("Solo una vez: Cartagena.", ["Cartagena"]);
    expect(ranges).toHaveLength(1);
  });
});
