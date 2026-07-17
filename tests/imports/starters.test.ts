/**
 * Tests — starter profiles + the generated canonical template (phase 7)
 *
 * Two concerns, both pure (no D1): the four external-format starters
 * (AtoM ISAD(G) CSV, AGN FUID, EAP, MEAP) and the generated canonical
 * Fisqua template.
 *
 * Per starter: a dry-run over its OWN template fixture (verbatim headers
 * from the research docs, synthetic rows) proves header binding resolves
 * cleanly — every binding source is present (no unbound bindings), every
 * bound header is read (not flagged unrecognised), the intentionally
 * unmapped columns ARE flagged (documenting the evidence-traced gaps), and
 * every row lands a sane `create` verdict. Offer legality and structural
 * validity are pinned too.
 *
 * Canonical template: the drift guard (generated headers must match the
 * pinned per-standard snapshot, or the version must move with them), the
 * direct-copy projection, and a fully symmetric dry-run (zero unbound, zero
 * unrecognised).
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { parseCsv } from "../../app/lib/import/csv";
import { validate } from "../../app/lib/import/validate";
import {
  parseProfileBindings,
  type ProfileBindings,
} from "../../app/lib/import/profile-schema";
import { isValidTarget } from "../../app/lib/import/target-fields";
import {
  STARTER_DEFINITIONS,
  getStarterDefinition,
  startersForStandard,
} from "../../app/lib/import/starters";
import {
  CANONICAL_HEADER_SNAPSHOT,
  CANONICAL_STARTER_KEY,
  CANONICAL_TEMPLATE_VERSION,
  canonicalTemplateCsv,
  generateCanonicalBindings,
  generateCanonicalHeaders,
} from "../../app/lib/import/canonical-template";
import type { Standard } from "../../app/lib/standards/types";
import {
  makeAtomCsv,
  SAMPLE_ATOM_STARTER_ROWS,
  makeEapCsv,
  SAMPLE_EAP_ROWS,
  makeMeapCsv,
  SAMPLE_MEAP_ROWS,
  makeFuidCsv,
  SAMPLE_FUID_ROWS,
} from "./fixtures";

function bindingsOf(key: string): ProfileBindings {
  const def = getStarterDefinition(key);
  if (!def) throw new Error(`no starter definition: ${key}`);
  const parsed = parseProfileBindings(def.bindings);
  if (!parsed.success) {
    throw new Error(
      `starter ${key} bindings invalid: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

function dryRun(standard: Standard, bindings: ProfileBindings, csv: string) {
  const { headers, rows } = parseCsv(csv);
  return validate({
    standard,
    bindings,
    headers,
    rows,
    existingReferenceCodes: new Set(),
    updateExisting: false,
  });
}

// ---------------------------------------------------------------------------
// Structural + offer legality
// ---------------------------------------------------------------------------

describe("starter definitions - structural validity", () => {
  it("every starter's bindings parse and every target is valid for its standards", () => {
    for (const def of STARTER_DEFINITIONS) {
      const parsed = parseProfileBindings(def.bindings);
      expect(parsed.success, `${def.key} bindings parse`).toBe(true);
      for (const standard of def.standards) {
        for (const b of def.bindings) {
          expect(
            isValidTarget(standard, b.target),
            `${def.key}: ${b.target} valid for ${standard}`,
          ).toBe(true);
        }
      }
    }
  });

  it("stamps a stable key, version, and default name on each", () => {
    for (const def of STARTER_DEFINITIONS) {
      expect(def.key).toMatch(/^[a-z0-9-]+$/);
      expect(def.version).toBeGreaterThanOrEqual(1);
      expect(def.defaultName.length).toBeGreaterThan(0);
    }
  });
});

describe("startersForStandard - offer legality", () => {
  it("offers all four external starters for isadg", () => {
    const keys = startersForStandard("isadg").map((s) => s.key).sort();
    expect(keys).toEqual(["agn-fuid", "atom-isadg-csv", "eap-listing", "meap-object"]);
  });

  it("offers only MEAP (item-level, cross-standard) for dacs", () => {
    expect(startersForStandard("dacs").map((s) => s.key)).toEqual(["meap-object"]);
  });

  it("offers no external starter for rad", () => {
    expect(startersForStandard("rad")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-starter dry-runs against their own verbatim templates
// ---------------------------------------------------------------------------

describe("AtoM ISAD(G) starter - dry-run over the AtoM template", () => {
  const result = dryRun("isadg", bindingsOf("atom-isadg-csv"), makeAtomCsv(SAMPLE_ATOM_STARTER_ROWS));

  it("binds every source header (no unbound bindings)", () => {
    expect(result.headerBinding.unboundBindings).toEqual([]);
  });

  it("imports FLAT: every row creates, none reject, no parent linkage inferred", () => {
    // parentId references legacyId (arbitrary migration keys), not the
    // reference code — the starter leaves it unbound, so rows whose
    // legacyId differs from identifier (this fixture) must still all land
    // as root-level creates rather than unresolvable_parent rejects.
    expect(result.verdicts).toHaveLength(SAMPLE_ATOM_STARTER_ROWS.length);
    expect(result.verdicts.every((v) => v.verdict === "create")).toBe(true);
    expect(result.ordered.every((r) => r.parentReferenceCode === null)).toBe(true);
    expect(result.ordered.every((r) => r.parentSource === null)).toBe(true);
  });

  it("reads its bound headers and flags only the intentionally unmapped ones", () => {
    const unrecognised = result.headerBinding.unrecognisedHeaders;
    // Bound headers are never unrecognised.
    for (const h of ["identifier", "title", "levelOfDescription", "eventStartDates"]) {
      expect(unrecognised).not.toContain(h);
    }
    // parentId (parent-by-legacyId resolution does not exist in v1), the
    // access points (authorities, link-never-mint), and qubitParentSlug
    // are documented as unbound — they must surface as unrecognised.
    for (const h of ["parentId", "qubitParentSlug", "subjectAccessPoints", "culture"]) {
      expect(unrecognised).toContain(h);
    }
  });
});

describe("AGN FUID starter - dry-run over the FUID template", () => {
  const result = dryRun("isadg", bindingsOf("agn-fuid"), makeFuidCsv(SAMPLE_FUID_ROWS));

  it("binds every source header (no unbound bindings)", () => {
    expect(result.headerBinding.unboundBindings).toEqual([]);
  });

  it("classifies every conservation unit as a create at file level", () => {
    expect(result.verdicts.every((v) => v.verdict === "create")).toBe(true);
    for (const v of result.verdicts) {
      // The constant transform ignores the CÓDIGO cell it rides on —
      // every row is `file` whatever the code says.
      expect(v.record?.descriptionLevel).toBe("file");
    }
  });

  it("keeps a populated Otro carrier in extent, never in the level", () => {
    const withOtro = result.verdicts.find((v) => v.referenceCode === "1.3");
    expect(withOtro?.verdict).toBe("create");
    expect(withOtro?.record?.descriptionLevel).toBe("file");
    expect(withOtro?.record?.extent).toBe(
      "Otro: Legajo de ejemplo 3; Folios: 12",
    );
  });

  it("flags only the documented unmapped columns (Final, frequency)", () => {
    expect(result.headerBinding.unrecognisedHeaders.sort()).toEqual(
      ["FRECUENCIA DE CONSULTA", "Final"].sort(),
    );
  });
});

describe("EAP starter - dry-run over the 51-column Description worksheet", () => {
  const result = dryRun("isadg", bindingsOf("eap-listing"), makeEapCsv(SAMPLE_EAP_ROWS));

  it("binds every source header (no unbound bindings)", () => {
    expect(result.headerBinding.unboundBindings).toEqual([]);
  });

  it("classifies the Collection and File rows as creates (flat, no parent key)", () => {
    expect(result.verdicts.every((v) => v.verdict === "create")).toBe(true);
    const levels = result.verdicts.map((v) => v.record?.descriptionLevel).sort();
    expect(levels).toEqual(["collection", "file"]);
  });

  it("reads its bound headers and leaves access points unbound", () => {
    const unrecognised = result.headerBinding.unrecognisedHeaders;
    for (const h of ["Original Reference", "Level", "Title (In English)", "Languages of Material"]) {
      expect(unrecognised).not.toContain(h);
    }
    for (const h of [
      "Related Subjects",
      "Scripts of Material",
      "Title (Transliterated)",
      "Restriction End Date",
      "Reason for Restriction",
    ]) {
      expect(unrecognised).toContain(h);
    }
  });
});

describe("MEAP starter - dry-run over the 36-column Template tab", () => {
  it("binds cleanly and creates item-level rows under isadg", () => {
    const result = dryRun("isadg", bindingsOf("meap-object"), makeMeapCsv(SAMPLE_MEAP_ROWS));
    expect(result.headerBinding.unboundBindings).toEqual([]);
    expect(result.verdicts.every((v) => v.verdict === "create")).toBe(true);
    for (const v of result.verdicts) {
      expect(v.record?.descriptionLevel).toBe("item");
    }
  });

  it("also creates cleanly under dacs (the cross-standard item-level fit)", () => {
    const result = dryRun("dacs", bindingsOf("meap-object"), makeMeapCsv(SAMPLE_MEAP_ROWS));
    expect(result.headerBinding.unboundBindings).toEqual([]);
    expect(result.verdicts.every((v) => v.verdict === "create")).toBe(true);
  });

  it("leaves the isadg-only and authority columns unbound", () => {
    const result = dryRun("isadg", bindingsOf("meap-object"), makeMeapCsv(SAMPLE_MEAP_ROWS));
    const unrecognised = result.headerBinding.unrecognisedHeaders;
    for (const h of ["Local identifier", "* Title", "* Extent", "* Resource Type"]) {
      expect(unrecognised).not.toContain(h);
    }
    for (const h of ["Dimensions", "* Genre", "* Subject.topic", "Alt Title"]) {
      expect(unrecognised).toContain(h);
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical template — drift, projection, symmetric round-trip
// ---------------------------------------------------------------------------

describe("canonical template - generated projection of the union schema", () => {
  const STANDARDS: Standard[] = ["isadg", "dacs", "rad"];

  it("matches the pinned snapshot for every standard (drift guard)", () => {
    // If this fails, the union schema changed: update CANONICAL_HEADER_SNAPSHOT
    // AND bump CANONICAL_TEMPLATE_VERSION together (lockstep, spec §8).
    for (const standard of STANDARDS) {
      expect(generateCanonicalHeaders(standard)).toEqual([
        ...CANONICAL_HEADER_SNAPSHOT[standard],
      ]);
    }
    expect(CANONICAL_TEMPLATE_VERSION).toBe(2);
  });

  it("projects every header to a direct-copy binding (source === target)", () => {
    for (const standard of STANDARDS) {
      const bindings = generateCanonicalBindings(standard);
      const headers = generateCanonicalHeaders(standard);
      expect(bindings.map((b) => b.source)).toEqual(headers);
      expect(bindings.every((b) => b.source === b.target)).toBe(true);
      expect(bindings.every((b) => b.transform === undefined)).toBe(true);
      // The projection is a valid, persistable profile for its standard.
      const parsed = parseProfileBindings(bindings);
      expect(parsed.success, `${standard} canonical bindings parse`).toBe(true);
    }
  });

  it("emits a headers-only CSV keyed by the canonical starter key", () => {
    const csv = canonicalTemplateCsv("isadg");
    const { headers, rowCount } = parseCsv(csv);
    expect(headers).toEqual(generateCanonicalHeaders("isadg"));
    expect(rowCount).toBe(0);
    expect(CANONICAL_STARTER_KEY).toBe("fisqua-canonical");
  });

  it("dry-runs a filled template with zero unbound and zero unrecognised headers", () => {
    // A fresh archive fills the Fisqua-native template; only the required
    // item-level fields need values, the rest stay blank (blank means absent).
    const bindings = parseProfileBindings(generateCanonicalBindings("isadg"));
    if (!bindings.success) throw new Error("canonical bindings invalid");
    const csv =
      generateCanonicalHeaders("isadg").join(",") +
      "\r\n" +
      // referenceCode,...,descriptionLevel,...,dateExpression,... filled via a map
      canonicalRow("isadg", {
        referenceCode: "EX-1",
        title: "Example title",
        descriptionLevel: "item",
        dateExpression: "1850",
      }) +
      "\r\n";
    const { headers, rows } = parseCsv(csv);
    const result = validate({
      standard: "isadg",
      bindings: bindings.data,
      headers,
      rows,
      existingReferenceCodes: new Set(),
      updateExisting: false,
    });
    expect(result.headerBinding.unboundBindings).toEqual([]);
    expect(result.headerBinding.unrecognisedHeaders).toEqual([]);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].verdict).toBe("create");
  });
});

/** Build one canonical-template data row aligned to the generated headers. */
function canonicalRow(standard: Standard, values: Record<string, string>): string {
  return generateCanonicalHeaders(standard)
    .map((h) => {
      const v = values[h] ?? "";
      return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    })
    .join(",");
}
