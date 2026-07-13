/**
 * Tests — relationship-role label completeness
 *
 * This suite pins that every relationship-role vocabulary value carries a
 * real, non-empty label in BOTH locales, in the namespaces that actually
 * render role labels. It is the structural fix for the Zasqua-class defect
 * called out in the roles survey (`2026-07-10-zasqua-maps-roles-survey.md`
 * §"Defect to avoid importing"): a label vocab that silently diverges from
 * the backend enum, letting unmatched codes fall through to raw-code
 * display. Here that can't happen quietly — a role added to
 * `ENTITY_ROLES`/`PLACE_ROLES` without its label fails this suite.
 *
 * Namespaces checked (each in en AND es):
 *  - `entities`         — ENTITY_ROLES (authority detail worklist pills)
 *  - `places`           — PLACE_ROLES  (authority detail worklist pills)
 *  - `descriptions_admin` (locale file `descriptions.ts`) — ENTITY_ROLES
 *      + PLACE_ROLES (the EntityLinker/PlaceLinker pickers and badges),
 *      plus the `role_group_<key>` optgroup labels for ENTITY_ROLE_GROUPS.
 *
 * Companion to `tests/i18n-completeness.test.ts` (en↔es key symmetry) and
 * `tests/lib/role-vocabulary.test.ts` (the enum ↔ canonical-set pin).
 *
 * @version v0.4.3
 */
import { describe, it, expect } from "vitest";
import en from "../app/locales/en";
import es from "../app/locales/es";
import {
  ENTITY_ROLES,
  PLACE_ROLES,
  ENTITY_ROLE_GROUPS,
} from "../app/lib/validation/enums";

const bundles = { en, es } as Record<string, Record<string, Record<string, unknown>>>;

function label(locale: string, namespace: string, key: string): unknown {
  return bundles[locale]?.[namespace]?.[key];
}

function expectLabel(locale: string, namespace: string, key: string) {
  const value = label(locale, namespace, key);
  expect(
    typeof value === "string" && value.length > 0,
    `${locale}.${namespace}.${key} must be a non-empty string`,
  ).toBe(true);
}

describe.each(["en", "es"])("[%s] entities namespace role labels", (locale) => {
  it.each([...ENTITY_ROLES])("has a label for role_%s", (role) => {
    expectLabel(locale, "entities", `role_${role}`);
  });
});

describe.each(["en", "es"])("[%s] places namespace role labels", (locale) => {
  it.each([...PLACE_ROLES])("has a label for role_%s", (role) => {
    expectLabel(locale, "places", `role_${role}`);
  });
});

describe.each(["en", "es"])(
  "[%s] descriptions_admin namespace (linker picker) role labels",
  (locale) => {
    it.each([...ENTITY_ROLES])("has an entity label for role_%s", (role) => {
      expectLabel(locale, "descriptions_admin", `role_${role}`);
    });

    it.each([...PLACE_ROLES])("has a place label for role_%s", (role) => {
      expectLabel(locale, "descriptions_admin", `role_${role}`);
    });

    it.each(ENTITY_ROLE_GROUPS.map((g) => g.key))(
      "has an optgroup label for role_group_%s",
      (key) => {
        expectLabel(locale, "descriptions_admin", `role_group_${key}`);
      },
    );
  },
);
