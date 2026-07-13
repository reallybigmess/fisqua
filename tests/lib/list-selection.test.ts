/**
 * Tests — list row selection helper
 *
 * Pins the pure selection semantics behind the two-row merge entry
 * point (spec §4): toggling adds an absent id, removes a present one,
 * and never mutates the input set (React state discipline — a mutated
 * set would defeat the re-render and the bulk-merge toolbar would not
 * appear/disappear with the checkboxes).
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import { toggleSelection } from "../../app/lib/list-selection";

describe("toggleSelection", () => {
  it("adds an id that is not selected", () => {
    const next = toggleSelection(new Set(), "a");
    expect(next.has("a")).toBe(true);
    expect(next.size).toBe(1);
  });

  it("removes an id that is already selected", () => {
    const next = toggleSelection(new Set(["a", "b"]), "a");
    expect(next.has("a")).toBe(false);
    expect(next.has("b")).toBe(true);
    expect(next.size).toBe(1);
  });

  it("never mutates the input set", () => {
    const prev = new Set(["a"]);
    const added = toggleSelection(prev, "b");
    const removed = toggleSelection(prev, "a");
    expect(prev.size).toBe(1);
    expect(prev.has("a")).toBe(true);
    expect(added).not.toBe(prev);
    expect(removed).not.toBe(prev);
  });

  it("reaches the two-selected state the merge deep link requires", () => {
    let sel = new Set<string>();
    sel = toggleSelection(sel, "loser-id");
    sel = toggleSelection(sel, "survivor-id");
    expect(Array.from(sel)).toEqual(["loser-id", "survivor-id"]);
    expect(sel.size).toBe(2);
  });
});
