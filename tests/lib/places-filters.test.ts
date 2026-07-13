/**
 * Tests — places filter-control helpers
 *
 * Pins the control-row semantics the combined places surface drives
 * through URL params: the external-identifier tri-state cycle (any →
 * has → missing → any, with an explicit clear back to any), the
 * any-filter-active check that shows the Reset control, and the reset
 * itself, which must return the URL to the bare route by removing
 * every filter param plus the pagination cursor.
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import {
  nextTriState,
  isAnyFilterActive,
  clearFilterParams,
  FILTER_PARAM_NAMES,
} from "../../app/lib/places-filters";

describe("nextTriState", () => {
  it("cycles any → has → missing → any", () => {
    expect(nextTriState(null)).toBe("has");
    expect(nextTriState("has")).toBe("missing");
    expect(nextTriState("missing")).toBeNull();
  });
});

describe("isAnyFilterActive", () => {
  it("is false on the bare route", () => {
    expect(isAnyFilterActive(new URLSearchParams())).toBe(false);
  });

  it("is true for each filter param individually", () => {
    for (const name of FILTER_PARAM_NAMES) {
      const sp = new URLSearchParams();
      sp.set(name, name === "q" ? "tunja" : "true");
      expect(isAnyFilterActive(sp)).toBe(true);
    }
  });

  it("treats an empty param value as inactive", () => {
    expect(isAnyFilterActive(new URLSearchParams("?tgn="))).toBe(false);
  });
});

describe("clearFilterParams", () => {
  it("clears every filter and the cursor back to the bare route", () => {
    const sp = new URLSearchParams(
      "?q=tunja&missingCoords=true&showMerged=true&placeType=city&tgn=has&hgis=missing&whg=has&cursor=Tunja%7Cabc",
    );
    const cleared = clearFilterParams(sp);
    expect(cleared.toString()).toBe("");
  });

  it("does not mutate the input params", () => {
    const sp = new URLSearchParams("?q=tunja");
    clearFilterParams(sp);
    expect(sp.get("q")).toBe("tunja");
  });
});
