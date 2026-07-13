/**
 * Tests — linked-descriptions worklist URL state
 *
 * Pins the parse/validation rules the detail pages' worklist drives
 * through URL params: off-menu page sizes clamp to the default 25,
 * unknown sorts fall back to date, page numbers floor at 1, and — the
 * behavioural contract — changing any filter resets pagination to page
 * one while paging itself does not.
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import {
  parseWorklistParams,
  setWorklistParam,
  WORKLIST_SIZES,
} from "../../app/lib/worklist-params";

describe("parseWorklistParams", () => {
  it("returns the defaults on a bare URL", () => {
    expect(parseWorklistParams(new URLSearchParams())).toEqual({
      dq: "",
      role: null,
      repo: null,
      sort: "date",
      size: 25,
      page: 1,
    });
  });

  it("passes the repository id through raw and resets paging on repo change", () => {
    expect(
      parseWorklistParams(new URLSearchParams("?repo=repo-ahrb")).repo,
    ).toBe("repo-ahrb");
    expect(parseWorklistParams(new URLSearchParams()).repo).toBeNull();
    const next = setWorklistParam(
      new URLSearchParams("?dpage=5&role=venue"),
      "repo",
      "repo-ahrb",
    );
    expect(next.get("repo")).toBe("repo-ahrb");
    expect(next.get("dpage")).toBeNull();
    expect(next.get("role")).toBe("venue");
  });

  it("accepts every menu size and clamps off-menu sizes to 25", () => {
    for (const s of WORKLIST_SIZES) {
      expect(
        parseWorklistParams(new URLSearchParams(`?size=${s}`)).size,
      ).toBe(s);
    }
    for (const bad of ["37", "0", "-25", "abc", "1000"]) {
      expect(
        parseWorklistParams(new URLSearchParams(`?size=${bad}`)).size,
      ).toBe(25);
    }
  });

  it("falls back to date for unknown sorts and floors page at 1", () => {
    expect(
      parseWorklistParams(new URLSearchParams("?sort=bogus")).sort,
    ).toBe("date");
    expect(
      parseWorklistParams(new URLSearchParams("?sort=code")).sort,
    ).toBe("code");
    expect(parseWorklistParams(new URLSearchParams("?dpage=0")).page).toBe(1);
    expect(parseWorklistParams(new URLSearchParams("?dpage=-3")).page).toBe(1);
    expect(parseWorklistParams(new URLSearchParams("?dpage=4")).page).toBe(4);
    expect(
      parseWorklistParams(new URLSearchParams("?dpage=2.5")).page,
    ).toBe(1);
  });

  it("trims the search and passes the role through raw", () => {
    const p = parseWorklistParams(
      new URLSearchParams("?dq=%20cabildo%20&role=venue"),
    );
    expect(p.dq).toBe("cabildo");
    expect(p.role).toBe("venue");
  });
});

describe("setWorklistParam", () => {
  it("resets pagination when any filter changes", () => {
    const sp = new URLSearchParams("?dpage=7&role=venue");
    for (const [name, value] of [
      ["dq", "tunja"],
      ["role", "mentioned"],
      ["sort", "title"],
      ["size", "100"],
    ] as const) {
      const next = setWorklistParam(sp, name, value);
      expect(next.get("dpage")).toBeNull();
      expect(next.get(name)).toBe(value);
    }
  });

  it("keeps the page when paging itself", () => {
    const next = setWorklistParam(new URLSearchParams("?role=venue"), "dpage", "3");
    expect(next.get("dpage")).toBe("3");
    expect(next.get("role")).toBe("venue");
  });

  it("removes a param on null and never mutates the input", () => {
    const sp = new URLSearchParams("?role=venue&dpage=2");
    const next = setWorklistParam(sp, "role", null);
    expect(next.get("role")).toBeNull();
    expect(sp.get("role")).toBe("venue");
  });
});
