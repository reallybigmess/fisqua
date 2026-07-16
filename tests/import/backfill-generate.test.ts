/**
 * Tests — backfill SQL generator (Module 4)
 *
 * Pins the two required properties of the emitted SQL: it is idempotent
 * (`INSERT OR IGNORE` on the deterministic PK) and a no-op when the
 * acting user is absent (`CROSS JOIN (SELECT id FROM users WHERE email =
 * …)`), with `user_id` never hard-coded. Also checks JSON detail is
 * single-quote-escaped and NULL targets render as SQL NULL.
 *
 * @version v0.4.2
 */
import { describe, it, expect } from "vitest";
import { generateStatements, partitionRows } from "../../scripts/backfill/generate";
import { PHASE_13_CREATED_AT_MS } from "../../scripts/backfill/ids";
import type { AuthorityOperationRow } from "../../scripts/backfill/types";

const row = (o: Partial<AuthorityOperationRow>): AuthorityOperationRow => ({
  id: "id-1",
  federation_id: "fed",
  record_type: "entity",
  operation: "resolve",
  source_id: "uuid-1",
  target_id: null,
  detail: { origin: "pipeline-backfill" },
  created_at: PHASE_13_CREATED_AT_MS,
  ...o,
});

describe("backfill/generate generateStatements", () => {
  it("emits idempotent INSERT OR IGNORE", () => {
    const [sql] = generateStatements([row({})]);
    expect(sql).toContain("INSERT OR IGNORE INTO authority_operations");
  });

  it("resolves user_id by email at apply time (no hard-coded id)", () => {
    const [sql] = generateStatements([row({})]);
    expect(sql).toContain("CROSS JOIN (SELECT id FROM users WHERE email = 'juan@neogranadina.org')");
    expect(sql).toContain("u.id");
    // user_id must not appear as a literal value in the VALUES tuple.
    expect(sql).not.toMatch(/VALUES[\s\S]*'backfill-rehearsal-user'/);
  });

  it("renders a NULL target as SQL NULL and escapes JSON detail", () => {
    const [sql] = generateStatements([
      row({ detail: { note: "d'Anconia" }, target_id: null }),
    ]);
    expect(sql).toContain("NULL");
    expect(sql).toContain("d''Anconia"); // single quote doubled
  });

  it("carries the Phase-13 constant, not a run date", () => {
    const [sql] = generateStatements([row({})]);
    expect(sql).toContain(String(PHASE_13_CREATED_AT_MS));
  });

  it("splits on the 64 KB headroom budget (D1 cap is ~100 KB)", () => {
    const many: AuthorityOperationRow[] = [];
    for (let i = 0; i < 5000; i++) {
      many.push(row({ id: `id-${i}`, source_id: `uuid-${i}`, detail: { origin: "pipeline-backfill", reasoning: "x".repeat(80) } }));
    }
    const stmts = generateStatements(many);
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(65_000);
  });
});

describe("backfill/generate partitionRows", () => {
  const contested = new Set(["uuid-contested"]);

  it("quarantines rows whose source touches a contested production UUID", () => {
    const rows = [
      row({ id: "a", source_id: "uuid-contested" }),
      row({ id: "b", source_id: "uuid-clean" }),
    ];
    const { clean, deferred } = partitionRows(rows, contested);
    expect(clean.map((r) => r.id)).toEqual(["b"]);
    expect(deferred.map((r) => r.id)).toEqual(["a"]);
  });

  it("quarantines rows whose target touches a contested production UUID", () => {
    const rows = [
      row({ id: "m", operation: "merge", source_id: "acc-08032", target_id: "uuid-contested" }),
      row({ id: "n", operation: "merge", source_id: "acc-00001", target_id: "uuid-clean" }),
    ];
    const { clean, deferred } = partitionRows(rows, contested);
    expect(deferred.map((r) => r.id)).toEqual(["m"]);
    expect(clean.map((r) => r.id)).toEqual(["n"]);
  });

  it("keeps everything when nothing is contested", () => {
    const rows = [row({ id: "a" }), row({ id: "b", target_id: "uuid-x" })];
    const { clean, deferred } = partitionRows(rows, new Set());
    expect(clean).toHaveLength(2);
    expect(deferred).toHaveLength(0);
  });
});

// Version: v0.4.2
