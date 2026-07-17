/**
 * Tests for Sidebar Navigation
 *
 * This test suite is the capability-aware coverage layered on the existing
 * role-permutation cases. The signature of `getSidebarSections` grows a
 * second parameter — a `SidebarTenant` carrying the five capability-flag
 * booleans — so the sidebar can hide whole nav branches whose capability
 * is off on the requesting tenant. Each existing case here passes a
 * default `makeTenant()` (all five capabilities ON, mirroring
 * Neogranadina).
 *
 * As of the 2026-07-10 module-section ruling (phase 3a) Entities and
 * Places move out of Records management into their own `Authorities`
 * section, gated on `authoritiesEnabled`. The assertions below track
 * that structure: Records management holds descriptions / repositories /
 * vocabularies / publish; Authorities holds entities / places.
 *
 * The `imports` capability (migration 0061) adds its own gated
 * `Imports` section, off by default; the cases near the end pin its
 * visibility.
 *
 * @version v0.6.0
 */

import { describe, it, expect } from "vitest";
import {
  getSidebarSections,
  type SidebarUser,
  type SidebarTenant,
} from "./sidebar";

function makeUser(overrides: Partial<SidebarUser> = {}): SidebarUser {
  return {
    isAdmin: false,
    isSuperAdmin: false,
    isCollabAdmin: false,
    isArchiveUser: false,
    isUserManager: false,
    isCataloguer: false,
    hasAnyProjectMembership: false,
    ...overrides,
  };
}

/**
 * Build a `SidebarTenant` with the historical five capabilities ON
 * and `imports` OFF by default — the Neogranadina shape (imports is
 * opt-in, off platform-wide by migration 0061). Override individual
 * flags to flip a single capability in a test case.
 */
function makeTenant(overrides: Partial<SidebarTenant> = {}): SidebarTenant {
  return {
    crowdsourcingEnabled: true,
    vocabularyHubEnabled: true,
    publishPipelineEnabled: true,
    multiRepositoryEnabled: true,
    authoritiesEnabled: true,
    importsEnabled: false,
    ...overrides,
  };
}

function labels(sections: ReturnType<typeof getSidebarSections>) {
  return sections.map((s) => s.labelKey ?? "<home>");
}

function paths(sections: ReturnType<typeof getSidebarSections>, labelKey: string) {
  const section = sections.find((s) => s.labelKey === labelKey);
  return section ? section.items.map((i) => i.path) : [];
}

function allPaths(sections: ReturnType<typeof getSidebarSections>): string[] {
  return sections.flatMap((s) => s.items.map((i) => i.path));
}

describe("getSidebarSections", () => {
  it("superadmin sees all sections including Promote, Publish and Authorities", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
      "/admin/cataloguing/promote",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/entities/duplicates",
    ]);
  });

  it("archive admin only (isAdmin) sees Home + Collab Cat + Records Management + Authorities (no Publish), no manage items", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/entities/duplicates",
    ]);
  });

  it("collab admin only sees Home + Collab Cat (with manage items, no Promote)", () => {
    const sections = getSidebarSections(
      makeUser({ isCollabAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([]);
    expect(paths(sections, "sidebar:authorities")).toEqual([]);
  });

  it("member-only user sees Home + Collab Cat (only My projects)", () => {
    const sections = getSidebarSections(
      makeUser({ hasAnyProjectMembership: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
    ]);
  });

  it("no-access user sees only Home", () => {
    const sections = getSidebarSections(makeUser(), makeTenant());
    expect(labels(sections)).toEqual(["<home>"]);
  });

  it("isAdmin + isCollabAdmin sees merged section with manage items + Authorities", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true, isCollabAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/entities/duplicates",
    ]);
  });

  // ---------------------------------------------------------------------
  // Capability-off cases
  //
  // For every disabled capability, pair a maximally-capable user
  // (superadmin, all six role flags) with a tenant that has just that
  // one capability turned off, and assert the corresponding nav surface
  // disappears entirely. The other four capabilities stay on so we
  // know the gate is precise — flipping one capability does not
  // collateral-damage another.
  // ---------------------------------------------------------------------

  it("hides Collaborative Cataloguing section when crowdsourcing is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true, isCataloguer: true }),
      makeTenant({ crowdsourcingEnabled: false }),
    );
    // The whole cataloguing branch is hidden. Records management still
    // renders because vocabulary_hub / publish_pipeline / multi_repository
    // remain ON.
    expect(labels(sections)).not.toContain(
      "sidebar:collaborative_cataloguing",
    );
    expect(allPaths(sections)).not.toContain("/proyectos");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/projects");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/team");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/promote");
    // Records management is intact.
    expect(paths(sections, "sidebar:records_management")).toContain(
      "/admin/descriptions",
    );
  });

  it("hides /admin/vocabularies when vocabulary_hub is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ vocabularyHubEnabled: false }),
    );
    expect(allPaths(sections)).not.toContain("/admin/vocabularies");
    // The other records-management entries still render.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/publish",
    ]);
    // Authorities is unaffected.
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/entities/duplicates",
    ]);
  });

  it("hides /admin/publish and /admin/promote when publish_pipeline is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ publishPipelineEnabled: false }),
    );
    expect(allPaths(sections)).not.toContain("/admin/publish");
    expect(allPaths(sections)).not.toContain("/admin/cataloguing/promote");
    // Records management still has its non-publish entries.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
    ]);
    // Collaborative cataloguing keeps its non-promote entries.
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
    ]);
  });

  it("shows /admin/repositories regardless of the multi_repository flag", () => {
    // The capability gates repository OPERATIONS (create beyond the first,
    // delete of the last), never the surface: a single-repository tenant
    // still reads and edits its one repository.
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ multiRepositoryEnabled: false }),
    );
    expect(allPaths(sections)).toContain("/admin/repositories");
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
  });

  it("attaches the duplicates badge to the Possible duplicates item", () => {
    const sections = getSidebarSections(
      makeUser({ isAdmin: true }),
      makeTenant(),
      { duplicates: 4 },
    );
    const authorities = sections.find(
      (sec) => sec.labelKey === "sidebar:authorities",
    );
    const dup = authorities?.items.find(
      (i) => i.path === "/admin/entities/duplicates",
    );
    expect(dup?.badge).toBe(4);
    expect(dup?.labelKey).toBe("sidebar:possible_duplicates");
  });

  it("shows the Imports section only when imports is on", () => {
    const off = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    // Default tenant has imports off — no Imports section, and the
    // existing section set is unchanged.
    expect(labels(off)).not.toContain("sidebar:imports");
    expect(allPaths(off)).not.toContain("/admin/imports");

    const on = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(labels(on)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
      "sidebar:imports",
    ]);
    expect(paths(on, "sidebar:imports")).toEqual(["/admin/imports"]);
  });

  it("hides the Imports section for a non-admin even when imports is on", () => {
    // A member-only user never reaches the admin block that carries
    // the Imports section, regardless of the capability flag.
    const sections = getSidebarSections(
      makeUser({ hasAnyProjectMembership: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(labels(sections)).not.toContain("sidebar:imports");
    expect(allPaths(sections)).not.toContain("/admin/imports");
  });

  it("imports capability does not collateral-affect other sections", () => {
    // Turning imports on adds only the Imports section; Records
    // management and Authorities render unchanged.
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ importsEnabled: true }),
    );
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/entities/duplicates",
    ]);
  });

  it("hides the whole Authorities section when authorities is off", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant({ authoritiesEnabled: false }),
    );
    expect(labels(sections)).not.toContain("sidebar:authorities");
    expect(allPaths(sections)).not.toContain("/admin/entities");
    expect(allPaths(sections)).not.toContain("/admin/places");
    // Records management is unaffected.
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
  });

  it("Neogranadina (all caps on) renders the full section set for a superadmin", () => {
    const sections = getSidebarSections(
      makeUser({ isSuperAdmin: true }),
      makeTenant(),
    );
    expect(labels(sections)).toEqual([
      "<home>",
      "sidebar:collaborative_cataloguing",
      "sidebar:records_management",
      "sidebar:authorities",
    ]);
    expect(paths(sections, "sidebar:collaborative_cataloguing")).toEqual([
      "/proyectos",
      "/admin/cataloguing/projects",
      "/admin/cataloguing/team",
      "/admin/cataloguing/promote",
    ]);
    expect(paths(sections, "sidebar:records_management")).toEqual([
      "/admin/descriptions",
      "/admin/repositories",
      "/admin/vocabularies",
      "/admin/publish",
    ]);
    expect(paths(sections, "sidebar:authorities")).toEqual([
      "/admin/entities",
      "/admin/places",
      "/admin/entities/duplicates",
    ]);
  });
});
