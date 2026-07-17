/**
 * Tests — operator-action validators + capability-diff helper
 *
 * This suite is the pure-unit regression net for `app/lib/operator-actions.server.ts`:
 *
 *   1. CreateTenantSchema accepts a full valid payload (defaults
 *      applied when capability flags omitted).
 *   2. The schema rejects reserved slugs through SlugSchema's
 *      existing refinement: `platform`, `www`, `api`, `admin`, `app`.
 *   3. The schema rejects an unknown descriptive_standard.
 *   4. The schema rejects an invalid bootstrap_email.
 *   5. The schema applies the capability defaults when fields are
 *      omitted: crowdsourcing=false, vocabulary_hub=true,
 *      publish_pipeline=true, multi_repository=false, imports=false.
 *   6. diffCapabilities returns [] for a no-op (current === submitted).
 *   7. diffCapabilities returns one entry for a single flip.
 *   8. diffCapabilities returns multiple entries for multi-flip and
 *      reports each flag's `from` and `to` correctly.
 *
 * No DB, no async — these run at compile speed and pin the validation
 * surface that Tasks 2 + 3 build their action handlers on top of.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import {
  CreateTenantSchema,
  diffCapabilities,
} from "../../app/lib/operator-actions.server";

describe("CreateTenantSchema", () => {
  it("accepts a full valid payload", () => {
    const result = CreateTenantSchema.safeParse({
      slug: "ahrb",
      name: "Archivo Histórico Regional de Boyacá",
      descriptiveStandard: "isadg",
      crowdsourcingEnabled: false,
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: false,
      quotaStorageBytes: 10_000_000,
      bootstrapEmail: "Operator@Example.test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Email lowercased by the schema.
      expect(result.data.bootstrapEmail).toBe("operator@example.test");
      expect(result.data.descriptiveStandard).toBe("isadg");
      expect(result.data.quotaStorageBytes).toBe(10_000_000);
    }
  });

  it("rejects a reserved slug (C-06: 'platform' is reserved)", () => {
    const result = CreateTenantSchema.safeParse({
      slug: "platform",
      name: "x",
      descriptiveStandard: "isadg",
      bootstrapEmail: "op@example.test",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      expect(flat.fieldErrors.slug?.some((m) => /reserved/i.test(m))).toBe(
        true,
      );
    }
  });

  it("rejects an unknown descriptive_standard", () => {
    const result = CreateTenantSchema.safeParse({
      slug: "valid-slug",
      name: "x",
      descriptiveStandard: "unknown",
      bootstrapEmail: "op@example.test",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      expect(flat.fieldErrors.descriptiveStandard).toBeDefined();
    }
  });

  it("rejects an invalid bootstrap_email", () => {
    const result = CreateTenantSchema.safeParse({
      slug: "valid-slug",
      name: "x",
      descriptiveStandard: "isadg",
      bootstrapEmail: "not-an-email",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      expect(flat.fieldErrors.bootstrapEmail).toBeDefined();
    }
  });

  it("applies the C-07 capability defaults when fields are omitted", () => {
    const result = CreateTenantSchema.safeParse({
      slug: "valid-slug",
      name: "x",
      descriptiveStandard: "isadg",
      bootstrapEmail: "op@example.test",
      // capability flags + quota deliberately omitted
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.crowdsourcingEnabled).toBe(false);
      expect(result.data.vocabularyHubEnabled).toBe(true);
      expect(result.data.publishPipelineEnabled).toBe(true);
      expect(result.data.multiRepositoryEnabled).toBe(false);
      expect(result.data.importsEnabled).toBe(false);
      expect(result.data.quotaStorageBytes).toBeNull();
    }
  });
});

describe("diffCapabilities", () => {
  const allOff = {
    crowdsourcingEnabled: false,
    vocabularyHubEnabled: false,
    publishPipelineEnabled: false,
    multiRepositoryEnabled: false,
    authoritiesEnabled: false,
    importsEnabled: false,
  };

  it("returns [] when current === submitted (no-op)", () => {
    const current = {
      crowdsourcingEnabled: false,
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: false,
      authoritiesEnabled: false,
      importsEnabled: false,
    };
    expect(diffCapabilities(current, current)).toEqual([]);
  });

  it("returns one entry for a single flip", () => {
    const current = {
      crowdsourcingEnabled: false,
      vocabularyHubEnabled: true,
      publishPipelineEnabled: true,
      multiRepositoryEnabled: false,
      authoritiesEnabled: false,
      importsEnabled: false,
    };
    const submitted = { ...current, vocabularyHubEnabled: false };
    const diff = diffCapabilities(current, submitted);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({
      capability: "vocabulary_hub",
      from: true,
      to: false,
    });
  });

  it("returns multiple entries for a multi-flip", () => {
    const current = allOff;
    const submitted = {
      crowdsourcingEnabled: true,
      vocabularyHubEnabled: true,
      publishPipelineEnabled: false,
      multiRepositoryEnabled: false,
      authoritiesEnabled: false,
      importsEnabled: false,
    };
    const diff = diffCapabilities(current, submitted);
    expect(diff).toHaveLength(2);
    // Each entry reports from + to correctly.
    const byCap = Object.fromEntries(diff.map((d) => [d.capability, d]));
    expect(byCap.crowdsourcing).toEqual({
      capability: "crowdsourcing",
      from: false,
      to: true,
    });
    expect(byCap.vocabulary_hub).toEqual({
      capability: "vocabulary_hub",
      from: false,
      to: true,
    });
  });

  it("reports an imports flip as its own entry", () => {
    const current = allOff;
    const submitted = { ...allOff, importsEnabled: true };
    const diff = diffCapabilities(current, submitted);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({
      capability: "imports",
      from: false,
      to: true,
    });
  });
});

// @version v0.4.0
