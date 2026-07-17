/**
 * Tests — import target fields per descriptive standard
 *
 * This suite pins that bindable targets derive from the tenant's
 * standard (not a hardcoded list): `referenceCode` is always present,
 * the linker placeholders are excluded, the structural pseudo-targets
 * are appended, and DACS and ISAD(G) expose their own column sets.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  allowedTargetFields,
  isValidTarget,
  REQUIRED_TARGET,
  STRUCTURAL_TARGETS,
  SUPPLEMENTARY_TARGETS,
} from "../../app/lib/import/target-fields";

describe("allowedTargetFields", () => {
  it("always includes the required referenceCode target", () => {
    for (const std of ["isadg", "dacs", "rad"] as const) {
      expect(allowedTargetFields(std)).toContain(REQUIRED_TARGET);
    }
  });

  it("appends the structural pseudo-targets", () => {
    const fields = allowedTargetFields("isadg");
    for (const s of STRUCTURAL_TARGETS) expect(fields).toContain(s);
  });

  it("excludes the linker placeholders (link-never-mint)", () => {
    const fields = allowedTargetFields("isadg");
    expect(fields).not.toContain("entities");
    expect(fields).not.toContain("places");
  });

  it("deduplicates columns", () => {
    const fields = allowedTargetFields("isadg");
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("exposes standard-specific columns", () => {
    // scopeContent is an ISAD(G) content-area field.
    expect(isValidTarget("isadg", "scopeContent")).toBe(true);
    // A clearly non-existent column is rejected.
    expect(isValidTarget("isadg", "notAColumn")).toBe(false);
  });

  it("makes dateCertainty bindable for every standard (standard-independent)", () => {
    // DACS has no section field for dateCertainty — it only reaches
    // allowedTargetFields via SUPPLEMENTARY_TARGETS. ISAD(G) and RAD
    // already declare it as a section field; either path must expose it.
    for (const std of ["isadg", "dacs", "rad"] as const) {
      expect(isValidTarget(std, "dateCertainty")).toBe(true);
    }
  });

  it("appends the supplementary targets without duplicating a standard's own field", () => {
    for (const s of SUPPLEMENTARY_TARGETS) {
      expect(isValidTarget("dacs", s)).toBe(true);
    }
    const fields = allowedTargetFields("isadg");
    expect(new Set(fields).size).toBe(fields.length);
  });
});
