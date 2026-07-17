/**
 * Tests — import identifier discipline (spec §3)
 *
 * Pure resolution: reference-code presence, in-file duplicates (every
 * colliding row rejected — never first-wins), parent resolution across both
 * hierarchy patterns (in-file container trees AND items into existing
 * containers), topological ordering tolerant of forward references, cascade
 * rejection of children of rejected parents, and cycle detection. Every identifier failure blocks its row into a named
 * reject; nothing here degrades (that is the transforms' concern).
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  resolveIdentifiers,
  descriptionLevels,
  isDescriptionLevel,
  type IdentifierRowInput,
} from "../../app/lib/import/identifiers";

const NONE = new Set<string>();

function row(
  rowNumber: number,
  referenceCode: string | null,
  parentReferenceCode: string | null = null,
): IdentifierRowInput {
  return { rowNumber, referenceCode, parentReferenceCode };
}

describe("resolveIdentifiers - reference code presence", () => {
  it("rejects a blank reference code and keeps the rest", () => {
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "A"), row(2, ""), row(3, "  ")],
      NONE,
    );
    expect(ordered.map((r) => r.referenceCode)).toEqual(["A"]);
    expect(rejects).toHaveLength(2);
    expect(rejects.every((r) => r.reason === "missing_reference_code")).toBe(true);
    expect(rejects.map((r) => r.rowNumber)).toEqual([2, 3]);
  });
});

describe("resolveIdentifiers - in-file duplicates reject ALL colliding rows", () => {
  it("rejects every row sharing a duplicated code, naming the other rows", () => {
    // Never first-wins: file order is not evidence of which duplicate is
    // correct, so none survives (spec S3's never-guess posture).
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "A"), row(2, "B"), row(3, "A")],
      NONE,
    );
    expect(ordered.map((r) => r.referenceCode)).toEqual(["B"]);
    expect(rejects).toHaveLength(2);
    expect(rejects).toContainEqual({
      rowNumber: 1,
      reason: "duplicate_reference_code",
      referenceCode: "A",
      detail: { rows: [3] },
    });
    expect(rejects).toContainEqual({
      rowNumber: 3,
      reason: "duplicate_reference_code",
      referenceCode: "A",
      detail: { rows: [1] },
    });
  });

  it("a triple collision rejects all three, each naming the other two", () => {
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "A"), row(2, "A"), row(3, "A")],
      NONE,
    );
    expect(ordered).toHaveLength(0);
    expect(rejects.map((r) => r.detail?.rows)).toEqual([[2, 3], [1, 3], [1, 2]]);
  });

  it("a child of a duplicated in-file code is rejected too (ambiguous parent)", () => {
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "A"), row(2, "A"), row(3, "child", "A")],
      NONE,
    );
    expect(ordered).toHaveLength(0);
    const child = rejects.find((r) => r.referenceCode === "child")!;
    expect(child.reason).toBe("unresolvable_parent");
  });
});

describe("resolveIdentifiers - hierarchy: container trees from one file", () => {
  it("orders parents before children with forward references tolerated", () => {
    // Child declared BEFORE its parent in the file.
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "child", "parent"), row(2, "parent", null)],
      NONE,
    );
    expect(rejects).toHaveLength(0);
    expect(ordered.map((r) => r.referenceCode)).toEqual(["parent", "child"]);
    expect(ordered[1].parentSource).toBe("in_file");
  });

  it("orders a multi-level tree top-down", () => {
    const { ordered } = resolveIdentifiers(
      [
        row(1, "leaf", "mid"),
        row(2, "mid", "root"),
        row(3, "root", null),
      ],
      NONE,
    );
    expect(ordered.map((r) => r.referenceCode)).toEqual(["root", "mid", "leaf"]);
  });
});

describe("resolveIdentifiers - hierarchy: items into existing containers", () => {
  it("resolves a parent that exists only in the database", () => {
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "item", "EXISTING-FONDS")],
      new Set(["EXISTING-FONDS"]),
    );
    expect(rejects).toHaveLength(0);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].parentSource).toBe("existing");
  });
});

describe("resolveIdentifiers - unresolvable parents and cascades", () => {
  it("rejects a row whose parent resolves nowhere", () => {
    const { ordered, rejects } = resolveIdentifiers([row(1, "item", "ghost")], NONE);
    expect(ordered).toHaveLength(0);
    expect(rejects[0]).toMatchObject({
      reason: "unresolvable_parent",
      detail: { parentReferenceCode: "ghost" },
    });
  });

  it("cascades: a child of a rejected parent is itself rejected", () => {
    // parent's own parent is a ghost -> parent rejected -> child cascades.
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "parent", "ghost"), row(2, "child", "parent")],
      NONE,
    );
    expect(ordered).toHaveLength(0);
    const reasons = rejects.map((r) => r.reason).sort();
    expect(reasons).toEqual(["unresolvable_parent", "unresolvable_parent"]);
    const child = rejects.find((r) => r.referenceCode === "child")!;
    expect(child.detail).toMatchObject({ parentRejected: "parent" });
  });
});

describe("resolveIdentifiers - cycles", () => {
  it("rejects a two-node cycle as parent_cycle", () => {
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "A", "B"), row(2, "B", "A")],
      NONE,
    );
    expect(ordered).toHaveLength(0);
    expect(rejects.map((r) => r.reason)).toEqual(["parent_cycle", "parent_cycle"]);
  });

  it("rejects a self-cycle", () => {
    const { ordered, rejects } = resolveIdentifiers([row(1, "A", "A")], NONE);
    expect(ordered).toHaveLength(0);
    expect(rejects[0].reason).toBe("parent_cycle");
  });

  it("keeps an acyclic sibling while rejecting the cycle", () => {
    const { ordered, rejects } = resolveIdentifiers(
      [row(1, "ok", null), row(2, "A", "B"), row(3, "B", "A")],
      NONE,
    );
    expect(ordered.map((r) => r.referenceCode)).toEqual(["ok"]);
    expect(rejects.map((r) => r.referenceCode).sort()).toEqual(["A", "B"]);
  });
});

describe("descriptionLevels - derived, not hardcoded", () => {
  it("exposes the platform level set and validates membership", () => {
    expect(descriptionLevels()).toContain("item");
    expect(descriptionLevels()).toContain("fonds");
    expect(isDescriptionLevel("item")).toBe(true);
    expect(isDescriptionLevel("expediente")).toBe(false);
  });
});
