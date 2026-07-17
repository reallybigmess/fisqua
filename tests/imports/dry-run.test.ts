/**
 * Tests - import dry-run runner (spec section 4)
 *
 * End-to-end over the real D1 harness with an in-memory staging store: run
 * the pipeline against a staged CSV, write the report and rejects
 * artefacts, and stamp the upload's report pointer. Pins the count
 * discipline (every count is a reduction over the same verdicts), the
 * create/update/skip classification against a real existence read, and the
 * rejects CSV carrying the ORIGINAL columns verbatim plus row number and
 * reason. Fixtures are REAL SBMAL rows over the verbatim DACS headers.
 *
 * The staging store is a plain in-memory object passed straight to the
 * runner (the real miniflare R2 binding cannot be written under the
 * Workers pool - the isolated-storage teardown bug), so no vi.mock needed.
 *
 * @version v0.6.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
  DACS_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createTestRepository } from "../helpers/repositories";
import { createTestDescription } from "../helpers/descriptions";
import { parseProfileBindings } from "../../app/lib/import/profile-schema";
import { parseCsv } from "../../app/lib/import/csv";
import { createUpload } from "../../app/lib/import/uploads.server";
import { stagingKey, type StagingStore } from "../../app/lib/import/staging.server";
import {
  runDryRun,
  fetchExistingReferenceCodes,
  EXISTING_CODES_CHUNK,
  EXISTENCE_QUERY_FIXED_PARAMS,
} from "../../app/lib/import/dry-run.server";
import {
  makeSbmalCsv,
  SBMAL_REAL_ROWS,
  SBMAL_DACS_BINDINGS,
  withBom,
} from "./fixtures";

const enc = new TextEncoder();
const dec = new TextDecoder();

function memStore(): { store: StagingStore; map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  const toBytes = (b: any): Uint8Array =>
    typeof b === "string" ? enc.encode(b) : b instanceof Uint8Array ? b : new Uint8Array(b);
  const store: StagingStore = {
    async put(key, body) {
      map.set(key, toBytes(body));
    },
    async getBytes(key) {
      return map.get(key) ?? null;
    },
    async head(key) {
      const b = map.get(key);
      return b ? { size: b.byteLength } : null;
    },
    async exists(key) {
      return map.has(key);
    },
    async delete(key) {
      map.delete(key);
    },
  };
  return { store, map };
}

function db() {
  return drizzle(env.DB);
}

function bindings() {
  const parsed = parseProfileBindings(SBMAL_DACS_BINDINGS);
  if (!parsed.success) throw new Error("fixture bindings invalid");
  return parsed.data;
}

async function stage(
  tenantId: string,
  csv: string,
): Promise<{ store: StagingStore; map: Map<string, Uint8Array>; uploadId: string }> {
  const { store, map } = memStore();
  const user = await createTestUser({ isAdmin: true, tenantId });
  const uploadId = crypto.randomUUID();
  const bytes = withBom(csv);
  const artifactKey = stagingKey.upload(tenantId, uploadId);
  await store.put(artifactKey, bytes);
  const parsed = parseCsv(csv);
  await createUpload(db(), {
    id: uploadId,
    tenantId,
    userId: user.id,
    filename: "sbmal.csv",
    artifactKey,
    byteSize: bytes.byteLength,
    rowCount: parsed.rowCount,
    headers: parsed.headers,
  });
  return { store, map, uploadId };
}

async function upload(tenantId: string, uploadId: string) {
  const { getUpload } = await import("../../app/lib/import/uploads.server");
  return (await getUpload(db(), tenantId, uploadId))!;
}

describe("runDryRun - happy path (isadg)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("classifies every real row as a create, writes both artefacts, stamps the pointer", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const { store, map, uploadId } = await stage(tenantId, makeSbmalCsv(SBMAL_REAL_ROWS));

    const { report, reportKey, rejectKey } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 3, bindings: bindings() },
      standard: "isadg",
      updateExisting: false,
    });

    expect(report.counts.total).toBe(8);
    expect(report.counts.creates).toBe(8);
    expect(report.counts.rejects).toBe(0);

    // Artefacts written to staging.
    expect(map.has(reportKey)).toBe(true);
    expect(map.has(rejectKey)).toBe(true);
    expect(reportKey).toBe(stagingKey.report(tenantId, uploadId));

    // Pointer stamped on the upload row.
    const row = await upload(tenantId, uploadId);
    expect(row.reportArtifact).toBe(reportKey);
    expect(row.profileId).toBe("p1");
    expect(row.profileVersion).toBe(3);
  });
});

describe("runDryRun - create/update/skip against a real existence read", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  async function seedExistingCmd1(tenantId: string) {
    const repo = await createTestRepository({ tenantId });
    await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      descriptionLevel: "item",
    });
  }

  it("updates the existing code when update is on", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    await seedExistingCmd1(tenantId);
    const { store, uploadId } = await stage(tenantId, makeSbmalCsv(SBMAL_REAL_ROWS));

    const { report } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: bindings() },
      standard: "isadg",
      updateExisting: true,
    });
    expect(report.counts.updates).toBe(1);
    expect(report.counts.creates).toBe(7);
    expect(report.counts.skips).toBe(0);
  });

  it("skips the existing code when update is off (create-only re-import)", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    await seedExistingCmd1(tenantId);
    const { store, uploadId } = await stage(tenantId, makeSbmalCsv(SBMAL_REAL_ROWS));

    const { report } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: bindings() },
      standard: "isadg",
      updateExisting: false,
    });
    expect(report.counts.skips).toBe(1);
    expect(report.counts.creates).toBe(7);
    expect(report.counts.updates).toBe(0);
  });
});

describe("runDryRun - rejects artefact carries original columns verbatim", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("names rejects by reason and preserves the original row in the CSV", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    // Real rows plus two deliberate defects (the mockup's approach): a blank
    // reference code and an in-file duplicate. Original data stays verbatim.
    const defective = [
      ...SBMAL_REAL_ROWS,
      { ...SBMAL_REAL_ROWS[0], Reference_Code: "" }, // blank id
      { ...SBMAL_REAL_ROWS[1] }, // duplicate of CMD 2
    ];
    const { store, map, uploadId } = await stage(tenantId, makeSbmalCsv(defective));

    const { report, rejectKey } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: bindings() },
      standard: "isadg",
      updateExisting: false,
    });

    // Duplicates reject BOTH colliding CMD 2 rows (never first-wins), so
    // 10 rows land as 7 creates + 3 rejects.
    expect(report.counts.total).toBe(10);
    expect(report.counts.creates).toBe(7);
    expect(report.counts.rejects).toBe(3);
    expect(report.counts.rejectsByReason).toMatchObject({
      missing_reference_code: 1,
      duplicate_reference_code: 2,
    });

    // Count discipline: the reason tallies sum to the reject count.
    const reasonSum = Object.values(report.counts.rejectsByReason).reduce((a, b) => a + b, 0);
    expect(reasonSum).toBe(report.counts.rejects);

    // The rejects CSV carries the original header row plus _row_number/_reason,
    // and the rejected rows' ORIGINAL cells verbatim.
    const rejectsCsv = dec.decode(map.get(rejectKey)!);
    const parsed = parseCsv(rejectsCsv);
    expect(parsed.headers).toContain("Reference_Code");
    expect(parsed.headers).toContain("_row_number");
    expect(parsed.headers).toContain("_reason");
    // Both duplicate rows preserve CMD 2's real title verbatim. The reason
    // cell names the colliding rows (design §5): `duplicate_reference_code:
    // rows …`, keeping the machine-readable code first so the column stays
    // groupable.
    const titleIdx = parsed.headers.indexOf("Title");
    const reasonIdx = parsed.headers.indexOf("_reason");
    const dupLines = parsed.rows.filter((r) =>
      r[reasonIdx].startsWith("duplicate_reference_code"),
    );
    expect(dupLines).toHaveLength(2);
    for (const line of dupLines) {
      expect(line[titleIdx]).toBe("Mexico. 2/4/1640.");
      expect(line[reasonIdx]).toMatch(/^duplicate_reference_code: rows \d+/);
    }
  });

  it("suffixes the reserved column names when the source file already uses them", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    // A source file that already carries a `_row_number` column: the
    // reserved name yields (underscore-suffixed) so the original column
    // passes through verbatim and the output stays unambiguous.
    const rows = [
      { ...SBMAL_REAL_ROWS[0], _row_number: "original-cell" } as Record<string, string>,
      { ...SBMAL_REAL_ROWS[1], Reference_Code: "", _row_number: "kept-verbatim" } as Record<string, string>,
    ];
    const csv = makeSbmalCsv(rows as any, ["_row_number"]);
    const { store, map, uploadId } = await stage(tenantId, csv);

    const { rejectKey } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: bindings() },
      standard: "isadg",
      updateExisting: false,
    });

    const parsed = parseCsv(dec.decode(map.get(rejectKey)!));
    // The source `_row_number` column survives once, verbatim; the report's
    // own row-number column is the suffixed reserved name.
    expect(parsed.headers.filter((h) => h === "_row_number")).toHaveLength(1);
    expect(parsed.headers).toContain("_row_number_");
    expect(parsed.headers).toContain("_reason");
    const srcIdx = parsed.headers.indexOf("_row_number");
    const reservedIdx = parsed.headers.indexOf("_row_number_");
    expect(parsed.rows[0][srcIdx]).toBe("kept-verbatim");
    expect(parsed.rows[0][reservedIdx]).toBe("2");
  });
});

describe("runDryRun - DACS validator rejects a required-field gap", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("rejects real item rows lacking extent under DACS", async () => {
    const tenantId = DACS_TEST_TENANT_ID;
    const { store, uploadId } = await stage(tenantId, makeSbmalCsv(SBMAL_REAL_ROWS));

    const { report } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: bindings() },
      standard: "dacs",
      updateExisting: false,
    });
    expect(report.counts.rejects).toBe(8);
    expect(report.counts.rejectsByReason.missing_required_field).toBe(8);
  });
});

describe("runDryRun - parent_change_ignored warning (never re-parent, never silent)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("warns by name when an update row's CSV parent differs from the record's current parent", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    // Existing hierarchy: CMD 1 filed under CONTAINER A; CONTAINER B also
    // exists. Placeholder container codes are test infrastructure, not
    // archival metadata.
    const containerA = await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CONTAINER A",
      descriptionLevel: "fonds",
    });
    await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CONTAINER B",
      descriptionLevel: "fonds",
    });
    await createTestDescription({
      tenantId,
      repositoryId: repo.id,
      referenceCode: "CMD 1",
      descriptionLevel: "item",
      parentId: containerA.id,
    });

    // The file updates CMD 1 but files it under CONTAINER B.
    const rows = [
      { ...SBMAL_REAL_ROWS[0], Parent_Ref: "CONTAINER B" },
    ] as unknown as Parameters<typeof makeSbmalCsv>[0];
    const parentBindings = [
      ...SBMAL_DACS_BINDINGS,
      { source: "Parent_Ref", target: "parent" },
    ];
    const parsedBindings = parseProfileBindings(parentBindings);
    if (!parsedBindings.success) throw new Error("fixture bindings invalid");
    const { store, uploadId } = await stage(tenantId, makeSbmalCsv(rows, ["Parent_Ref"]));

    const { report } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: parsedBindings.data },
      standard: "isadg",
      updateExisting: true,
    });

    // The row still updates — the warning is a degradation report, not a
    // reject (the asymmetry rule) — and the divergence is named by code.
    expect(report.counts.updates).toBe(1);
    expect(report.counts.rejects).toBe(0);
    expect(report.counts.warningsByCode.parent_change_ignored).toBe(1);
  });
});

describe("fetchExistingReferenceCodes - D1 bound-parameter discipline", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("pins the invariant: chunk size + fixed params never exceeds D1's 100", () => {
    // D1 caps bound parameters at 100 per statement; each existence chunk
    // binds its codes plus the tenant id. The workers-pool D1 shim does not
    // enforce the production limit, so THIS arithmetic — not the
    // integration run below — is the real guard against a regression.
    expect(
      EXISTING_CODES_CHUNK + EXISTENCE_QUERY_FIXED_PARAMS,
    ).toBeLessThanOrEqual(100);
  });

  it("resolves more than one chunk's worth of codes (integration)", async () => {
    const tenantId = DEFAULT_TEST_TENANT_ID;
    const repo = await createTestRepository({ tenantId });
    // 120 seeded descriptions -> a 150-code query spans two chunks. Codes
    // are test-infrastructure identifiers, not archival metadata.
    const seeded: string[] = [];
    for (let i = 0; i < 120; i++) {
      const code = `VOL-${String(i + 1).padStart(3, "0")}`;
      seeded.push(code);
      await createTestDescription({
        tenantId,
        repositoryId: repo.id,
        referenceCode: code,
        descriptionLevel: "item",
      });
    }
    const queried = [
      ...seeded,
      ...Array.from({ length: 30 }, (_, i) => `MISSING-${i + 1}`),
    ];
    expect(queried.length).toBeGreaterThan(EXISTING_CODES_CHUNK);

    const existing = await fetchExistingReferenceCodes(db(), tenantId, queried);
    expect(existing.size).toBe(120);
    expect(existing.has("VOL-001")).toBe(true);
    expect(existing.has("VOL-120")).toBe(true);
    expect(existing.has("MISSING-1")).toBe(false);
  });
});

describe("runDryRun - reject reasons name fields and the parent (design §5)", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("names the missing fields and the rejected parent in the report and CSV", async () => {
    const tenantId = DACS_TEST_TENANT_ID;
    // A title-only collection over one verbatim SBMAL item, under DACS: the
    // collection rejects on its own required-field gap; the item inherits it.
    const parentBinding = parseProfileBindings([
      ...SBMAL_DACS_BINDINGS,
      { source: "Parent_Reference_Code", target: "parent" },
    ]);
    if (!parentBinding.success) throw new Error("bindings invalid");
    const csv = makeSbmalCsv(
      [
        { Reference_Code: "TEST-COLL", Title: "Container (test parent)", Format: "collection" },
        { ...SBMAL_REAL_ROWS[0], Parent_Reference_Code: "TEST-COLL" },
      ] as any,
      ["Parent_Reference_Code"],
    );
    const { store, map, uploadId } = await stage(tenantId, csv);

    const { report, rejectKey } = await runDryRun({
      db: db(),
      store,
      tenantId,
      upload: await upload(tenantId, uploadId),
      profile: { id: "p1", version: 1, bindings: parentBinding.data },
      standard: "dacs",
      updateExisting: false,
    });

    const coll = report.rejects.find((r) => r.reason === "missing_required_field")!;
    expect((coll.detail as any).requiredMissing).toContain("extent");
    const child = report.rejects.find((r) => r.reason === "parent_rejected")!;
    expect((child.detail as any).parentReferenceCode).toBe("TEST-COLL");

    // The CSV reason cell names the same detail (design §5).
    const parsed = parseCsv(dec.decode(map.get(rejectKey)!));
    const reasonIdx = parsed.headers.indexOf("_reason");
    const reasons = parsed.rows.map((r) => r[reasonIdx]);
    expect(reasons.some((r) => /^missing_required_field: .*extent/.test(r))).toBe(true);
    expect(reasons.some((r) => r === "parent_rejected: TEST-COLL")).toBe(true);
  });
});
