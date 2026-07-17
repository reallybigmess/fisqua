/**
 * Tests — readiness-check aggregation + gating (design §§3.2-3.4, §8)
 *
 * Pure over `validate()` output: a real-shape hierarchy (a title-only
 * collection container over two verbatim SBMAL item rows that are missing
 * extent under DACS, plus a duplicate reference-code pair) must aggregate
 * into the expected problem classes, counts, and forward cascades. The two
 * item rows are byte-verbatim SBMAL records; the container and duplicate
 * rows carry self-evidently synthetic placeholder codes/titles — never
 * invented archival metadata.
 *
 * Gating pins the dry-run gate: locked with pending decisions, unlocked at
 * zero pending, trivially unlocked when no decision findings exist.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { parseCsv } from "../../app/lib/import/csv";
import { validate } from "../../app/lib/import/validate";
import {
  computeFindings,
  missingRequiredClassKey,
  type DecisionFinding,
  type BlockingFinding,
} from "../../app/lib/import/check";
import { gateState, type CheckDecision } from "../../app/lib/import/check.server";
import { parseProfileBindings } from "../../app/lib/import/profile-schema";
import { makeSbmalCsv, SBMAL_REAL_ROWS, SBMAL_DACS_BINDINGS } from "./fixtures";

const PARENT_HEADER = "Parent_Reference_Code";

function bindings() {
  const parsed = parseProfileBindings([
    ...SBMAL_DACS_BINDINGS,
    { source: PARENT_HEADER, target: "parent" },
  ]);
  if (!parsed.success) throw new Error("fixture bindings invalid");
  return parsed.data;
}

/**
 * A container tree: one title-only collection over CMD 1 and CMD 2 (both
 * verbatim, both missing extent under DACS), plus a duplicate pair. Container
 * and duplicate codes are synthetic scaffolding.
 */
function hierarchyResult() {
  const rows = [
    { Reference_Code: "TEST-COLL", Title: "Container (test parent)", Format: "collection" },
    { ...SBMAL_REAL_ROWS[0], [PARENT_HEADER]: "TEST-COLL" },
    { ...SBMAL_REAL_ROWS[1], [PARENT_HEADER]: "TEST-COLL" },
    { Reference_Code: "TEST-DUP", Title: "Duplicate row A (test)" },
    { Reference_Code: "TEST-DUP", Title: "Duplicate row B (test)" },
  ] as Record<string, string>[];
  const { headers, rows: parsed } = parseCsv(makeSbmalCsv(rows as any, [PARENT_HEADER]));
  return validate({
    standard: "dacs",
    bindings: bindings(),
    headers,
    rows: parsed,
    existingReferenceCodes: new Set(),
    updateExisting: false,
  });
}

describe("computeFindings — decision aggregation over a real-shape hierarchy", () => {
  it("groups a title-only collection and the item extent gap as separate classes", () => {
    const result = hierarchyResult();
    const findings = computeFindings({ result, rowIdentifiers: result.rowIdentifiers });
    const decisions = findings.filter((f): f is DecisionFinding => f.kind === "decision");
    expect(decisions).toHaveLength(2);

    // The collection carries its title only — six required describing fields
    // are blank, and its two item descendants reject with it (forward cascade).
    const collection = decisions.find((d) => d.level === "collection")!;
    expect(collection.count).toBe(1);
    expect(collection.referenceCode).toBe("TEST-COLL");
    expect(collection.cascadeCount).toBe(2);
    expect(collection.fields).toEqual([
      "accessConditions",
      "creatorDisplay",
      "dateExpression",
      "extent",
      "language",
      "scopeContent",
    ]);
    expect(collection.classKeys).toContain(missingRequiredClassKey("collection", "extent"));
    expect(collection.classKeys).toHaveLength(6);

    // Both items are missing extent; items are leaves, so no forward cascade.
    const items = decisions.find((d) => d.level === "item")!;
    expect(items.count).toBe(2);
    expect(items.fields).toEqual(["extent"]);
    expect(items.classKeys).toEqual([missingRequiredClassKey("item", "extent")]);
    expect(items.cascadeCount).toBe(0);
  });

  it("surfaces the duplicate reference-code pair as a blocking finding, not a decision", () => {
    const result = hierarchyResult();
    const findings = computeFindings({ result, rowIdentifiers: result.rowIdentifiers });
    const blocking = findings.filter((f): f is BlockingFinding => f.kind === "blocking");
    const dup = blocking.find((b) => b.blockingKind === "duplicate_reference_code")!;
    expect(dup).toBeDefined();
    expect(dup.referenceCode).toBe("TEST-DUP");
    expect(dup.count).toBe(2);
    expect(dup.rows).toEqual([4, 5]);
    expect(dup.cascadeCount).toBe(0);
    // No decision finding carries the duplicate class — identifier discipline
    // is never an accept option (design §3.2).
    const decisionKeys = findings
      .filter((f) => f.kind === "decision")
      .flatMap((f) => (f as DecisionFinding).classKeys);
    expect(decisionKeys.some((k) => k.includes("TEST-DUP"))).toBe(false);
  });

  it("excludes non-degradable rows from decision counts — cards promise only what acceptance saves", () => {
    // Three items missing extent under DACS: CMD 1 verbatim, plus a row with
    // an over-length title (synthetic defect scaffolding) — a non-degradable
    // defect acceptance never relieves — which also parents CMD 2, so its
    // subtree must not be claimed by any decision card.
    const rows = [
      { ...SBMAL_REAL_ROWS[0] },
      {
        Reference_Code: "TEST-BAD",
        Title: "x".repeat(2001),
        Date_Expressed: "1800",
      },
      { ...SBMAL_REAL_ROWS[1], [PARENT_HEADER]: "TEST-BAD" },
    ] as Record<string, string>[];
    const { headers, rows: parsed } = parseCsv(makeSbmalCsv(rows as any, [PARENT_HEADER]));
    const result = validate({
      standard: "dacs",
      bindings: bindings(),
      headers,
      rows: parsed,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    const findings = computeFindings({ result, rowIdentifiers: result.rowIdentifiers });

    // The item/extent decision card counts ONLY CMD 1: the defect row is
    // excluded (its own defect), and CMD 2 is excluded (it cascade-rejects
    // under the defect row whatever is decided). No cascade is claimed.
    const decisions = findings.filter((f): f is DecisionFinding => f.kind === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].level).toBe("item");
    expect(decisions[0].count).toBe(1);
    expect(decisions[0].sampleRows).toEqual([1]);
    expect(decisions[0].cascadeCount).toBe(0);

    // The defect row surfaces as an invalid_values blocking finding, its
    // cascade covering the subtree that rejects with it.
    const invalid = findings.find(
      (f): f is BlockingFinding =>
        f.kind === "blocking" && f.blockingKind === "invalid_values",
    )!;
    expect(invalid.rows).toEqual([2]);
    expect(invalid.count).toBe(1);
    expect(invalid.cascadeCount).toBe(1);

    // Accepting every decision class achieves EXACTLY the card's count as
    // creates: CMD 1 creates; the defect row still rejects value_too_long
    // and CMD 2 still cascade-rejects under it.
    const accepted = validate({
      standard: "dacs",
      bindings: bindings(),
      headers,
      rows: parsed,
      existingReferenceCodes: new Set(),
      updateExisting: false,
      acceptedClasses: new Set(decisions.flatMap((d) => d.classKeys)),
    });
    const creates = accepted.verdicts.filter((v) => v.verdict === "create");
    expect(creates).toHaveLength(decisions[0].count);
    expect(creates[0].referenceCode).toBe("CMD 1");
    expect(
      accepted.verdicts.find((v) => v.referenceCode === "TEST-BAD")!.reason,
    ).toBe("value_too_long");
    expect(
      accepted.verdicts.find((v) => v.referenceCode === "CMD 2")!.reason,
    ).toBe("parent_rejected");
  });

  it("names the source columns to fill when a binding map is supplied", () => {
    const result = hierarchyResult();
    const findings = computeFindings({
      result,
      rowIdentifiers: result.rowIdentifiers,
      targetToSource: { extent: "Extent", scopeContent: "Scope_and_Content" },
    });
    const items = findings.find(
      (f): f is DecisionFinding => f.kind === "decision" && f.level === "item",
    )!;
    expect(items.sourceColumns).toEqual(["Extent"]);
  });
});

describe("gateState — the dry-run gate (design §3.4)", () => {
  function decisionEntry(f: DecisionFinding): CheckDecision {
    return {
      key: f.key,
      classKeys: f.classKeys,
      level: f.level,
      fields: f.fields,
      count: f.count,
      cascadeCount: f.cascadeCount,
      acceptedBy: "user-1",
      acceptedAt: 0,
    };
  }

  it("locks with pending decisions and unlocks only when every one is accepted", () => {
    const result = hierarchyResult();
    const findings = computeFindings({ result, rowIdentifiers: result.rowIdentifiers });
    const decisions = findings.filter((f): f is DecisionFinding => f.kind === "decision");

    const none = gateState(findings, [], 1);
    expect(none.decisionsTotal).toBe(2);
    expect(none.decisionsMade).toBe(0);
    expect(none.unlocked).toBe(false);
    expect(none.pending).toHaveLength(2);

    const one = gateState(findings, [decisionEntry(decisions[0])], 1);
    expect(one.decisionsMade).toBe(1);
    expect(one.unlocked).toBe(false);
    expect(one.pending).toHaveLength(1);

    const all = gateState(findings, decisions.map(decisionEntry), 1);
    expect(all.decisionsMade).toBe(2);
    expect(all.unlocked).toBe(true);
    expect(all.pending).toHaveLength(0);
  });

  it("trivially unlocks a file with no decision findings", () => {
    // Under ISAD(G) the same verbatim rows create cleanly — no required gap.
    const { headers, rows } = parseCsv(makeSbmalCsv(SBMAL_REAL_ROWS));
    const result = validate({
      standard: "isadg",
      bindings: (() => {
        const p = parseProfileBindings(SBMAL_DACS_BINDINGS);
        if (!p.success) throw new Error("bad");
        return p.data;
      })(),
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    const findings = computeFindings({ result, rowIdentifiers: result.rowIdentifiers });
    expect(findings.filter((f) => f.kind === "decision")).toHaveLength(0);
    const state = gateState(findings, [], 1);
    expect(state.decisionsTotal).toBe(0);
    expect(state.unlocked).toBe(true);
  });
});
