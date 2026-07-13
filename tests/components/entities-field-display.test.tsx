/**
 * Tests — admin FieldDisplay presence predicate
 *
 * This suite pins the pure predicate `isDisplayableFieldValue` behind
 * the shared admin `FieldDisplay` helper
 * (`app/components/admin/field-display.tsx`). The contract: `null`,
 * `undefined`, and the empty string count as "no value" and fall back
 * to the em-dash placeholder; every other value -- including the
 * falsy-but-real numeric `0` -- counts as present and renders. The
 * predicate is now the single source both `entities.$id` and
 * `places.$id` share.
 *
 * No React rendering, no jsdom -- the predicate is a single boolean.
 * Same Workers-pool pure-function pattern as
 * `tests/components/flag-badge.test.tsx`.
 *
 * @version v0.4.1
 */
import { describe, it, expect } from "vitest";
import { isDisplayableFieldValue } from "../../app/components/admin/field-display";

describe("isDisplayableFieldValue", () => {
  it("returns true for numeric 0 -- the falsy-0 regression case", () => {
    expect(isDisplayableFieldValue(0)).toBe(true);
  });

  it("returns true for a negative number", () => {
    expect(isDisplayableFieldValue(-1)).toBe(true);
  });

  it("returns true for a non-empty string", () => {
    expect(isDisplayableFieldValue("Bogotá")).toBe(true);
  });

  it("returns true for the string \"0\"", () => {
    expect(isDisplayableFieldValue("0")).toBe(true);
  });

  it("returns false for null", () => {
    expect(isDisplayableFieldValue(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isDisplayableFieldValue(undefined)).toBe(false);
  });

  it("returns false for the empty string", () => {
    expect(isDisplayableFieldValue("")).toBe(false);
  });
});
