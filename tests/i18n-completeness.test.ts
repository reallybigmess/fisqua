/**
 * Tests — i18n locale completeness
 *
 * This suite is the structural backstop that pins the two-locale
 * symmetry between `app/locales/en` and `app/locales/es`: every
 * leaf key path in the English bundle must exist in the Spanish
 * bundle and vice versa. A regression here means a translation key
 * was added on one side without its counterpart, which would render
 * the i18n key (e.g. `viewer.toolbar.regiones`) literally to the
 * user on the missing-locale side.
 *
 * The recursive `extractKeys` helper walks the nested locale
 * objects and emits dot-notation paths so the diff between the two
 * bundles surfaces as a small, readable list of missing keys
 * rather than a structural-mismatch error. This file lives at the
 * top level (not under `tests/i18n/`) because it cuts across
 * every namespace — adding a `tests/i18n/` directory would imply a
 * narrower scope.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import es from "../app/locales/es";
import en from "../app/locales/en";

/**
 * Recursively extract all leaf keys as dot-notation paths.
 */
function extractKeys(
  obj: Record<string, unknown>,
  prefix = "",
): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null) {
      keys.push(...extractKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * Recursively extract all leaf string values.
 */
function extractValues(obj: Record<string, unknown>): string[] {
  const strings: string[] = [];
  for (const value of Object.values(obj)) {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "object" && value !== null)
      strings.push(...extractValues(value as Record<string, unknown>));
  }
  return strings;
}

const NAMESPACES = [
  "common",
  "auth",
  "dashboard",
  "viewer",
  "workflow",
  "admin",
  "project",
  "description",
  "comments",
  "sidebar",
  "settings",
  "repositories",
  "entities",
  "places",
  "descriptions_admin",
  "publish",
  "promote",
  "no_access",
  "cataloguing_admin",
  "pipeline",
  "team",
  "vocabularies",
  "volume_admin",
  "user_admin",
  "qc_flags",
  "landing",
  "operator",
  "authorities",
  "imports",
] as const;

describe("translation completeness", () => {
  it("every key in es namespace files has a corresponding en key", () => {
    const missing: string[] = [];
    for (const ns of NAMESPACES) {
      const esKeys = extractKeys(
        es[ns] as unknown as Record<string, unknown>,
      );
      const enKeys = new Set(
        extractKeys(en[ns] as unknown as Record<string, unknown>),
      );
      for (const key of esKeys) {
        if (!enKeys.has(key)) {
          missing.push(`${ns}:${key}`);
        }
      }
    }
    expect(missing, `ES keys missing in EN:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  it("every key in en namespace files has a corresponding es key", () => {
    const missing: string[] = [];
    for (const ns of NAMESPACES) {
      const enKeys = extractKeys(
        en[ns] as unknown as Record<string, unknown>,
      );
      const esKeys = new Set(
        extractKeys(es[ns] as unknown as Record<string, unknown>),
      );
      for (const key of enKeys) {
        if (!esKeys.has(key)) {
          missing.push(`${ns}:${key}`);
        }
      }
    }
    expect(missing, `EN keys missing in ES:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  it("no translation value is an empty string", () => {
    const empties: string[] = [];
    for (const ns of NAMESPACES) {
      for (const locale of ["es", "en"] as const) {
        const source = locale === "es" ? es : en;
        const keys = extractKeys(
          source[ns] as unknown as Record<string, unknown>,
        );
        const values = extractValues(
          source[ns] as unknown as Record<string, unknown>,
        );
        // Match keys to values positionally (both use same traversal order)
        values.forEach((val, i) => {
          if (val === "") {
            empties.push(`${locale}/${ns}:${keys[i]}`);
          }
        });
      }
    }
    expect(
      empties,
      `Empty translation values found:\n${empties.join("\n")}`,
    ).toEqual([]);
  });

  it("all namespaces are present in both locales", () => {
    const esNs = Object.keys(es).sort();
    const enNs = Object.keys(en).sort();
    const expected = [...NAMESPACES].sort();
    expect(esNs).toEqual(expected);
    expect(enNs).toEqual(expected);
  });
});

describe("qc_flags namespace structural shape (EN)", () => {
  // These assertions guard the EN namespace in isolation. They pass now
  // and continue to pass once the ES mirror is added; they only fail
  // if the EN contract breaks.
  const ns = en.qc_flags as unknown as Record<string, Record<string, unknown>>;

  it("has top-level dialog, badge, card, and feed sections", () => {
    expect(ns.dialog).toBeDefined();
    expect(ns.badge).toBeDefined();
    expect(ns.card).toBeDefined();
    expect(ns.feed).toBeDefined();
  });

  it("dialog section covers all six problem types with labels + descriptions", () => {
    const pt = ns.dialog.problem_type as Record<string, string>;
    const types = [
      "damaged",
      "repeated",
      "out_of_order",
      "missing",
      "blank",
      "other",
    ];
    for (const k of types) {
      expect(pt[k], `qc_flags:dialog.problem_type.${k}`).toBeTypeOf("string");
      expect(
        pt[`${k}_desc`],
        `qc_flags:dialog.problem_type.${k}_desc`
      ).toBeTypeOf("string");
    }
  });

  it("dialog section has submit, cancel, details, and page labels", () => {
    const d = ns.dialog as unknown as Record<string, unknown>;
    expect(d.title).toBeTypeOf("string");
    expect(d.subtitle).toBeTypeOf("string");
    expect(d.page_label).toBeTypeOf("string");
    expect(d.problem_type_label).toBeTypeOf("string");
    expect(d.description_label).toBeTypeOf("string");
    expect(d.description_placeholder).toBeTypeOf("string");
    expect(d.submit).toBeTypeOf("string");
    expect(d.cancel).toBeTypeOf("string");
  });

  it("badge section covers plural count + per-page aria + no-flags fallback", () => {
    const b = ns.badge as unknown as Record<string, unknown>;
    expect(b.open_count_one).toBeTypeOf("string");
    expect(b.open_count_other).toBeTypeOf("string");
    expect(b.no_flags).toBeTypeOf("string");
    expect(b.per_page_aria_one).toBeTypeOf("string");
    expect(b.per_page_aria_other).toBeTypeOf("string");
  });

  it("card section covers statuses, problem types, resolution actions, reporter/resolver, and resolve button", () => {
    const c = ns.card as unknown as Record<string, unknown>;
    const status = c.status as Record<string, string>;
    expect(status.open).toBeTypeOf("string");
    expect(status.resolved).toBeTypeOf("string");
    expect(status.wontfix).toBeTypeOf("string");

    const problemType = c.problem_type as Record<string, string>;
    for (const k of [
      "damaged",
      "repeated",
      "out_of_order",
      "missing",
      "blank",
      "other",
    ]) {
      expect(problemType[k], `qc_flags:card.problem_type.${k}`).toBeTypeOf(
        "string"
      );
    }

    const action = c.resolution_action as Record<string, string>;
    for (const k of [
      "retake_requested",
      "reordered",
      "marked_duplicate",
      "ignored",
      "other",
    ]) {
      expect(action[k], `qc_flags:card.resolution_action.${k}`).toBeTypeOf(
        "string"
      );
    }

    expect(c.reported_by).toBeTypeOf("string");
    expect(c.resolved_by).toBeTypeOf("string");
    expect(c.resolve_button).toBeTypeOf("string");
  });

  it("feed section has both raised and resolved lifecycle strings", () => {
    const f = ns.feed as unknown as Record<string, unknown>;
    expect(f.raised).toBeTypeOf("string");
    expect(f.resolved).toBeTypeOf("string");
  });
});



