/**
 * Tests — combined
 *
 * This suite pins the combined-export contract: `writeDescriptionsIndex`
 * takes a `tenant: ExportTenant` argument, and per-fonds entry keys and
 * the index file itself are slug-prefixed to match the per-fonds R2
 * layout that `exportFondsDescriptions` writes.
 *
 * @version v0.4.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  writeDescriptionsIndex,
  FondsBodyTooLargeError,
  type DescriptionsIndex,
} from "../../app/lib/export/combined.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

const TEST_TENANT: ExportTenant = {
  id: "test-tenant-id",
  federationId: "b4462493-6170-44f8-ae07-24666606d1f1", // NEOGRANADINA_FEDERATION_ID
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

function mockStorage() {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    putObjectStream: vi.fn().mockResolvedValue(undefined),
    getObjectStream: vi.fn().mockResolvedValue(null),
    getObjectHead: vi.fn().mockResolvedValue(null),
  } as unknown as ExportStorage;
}

describe("writeDescriptionsIndex", () => {
  let storage: ExportStorage;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("writes descriptions-index.json with per-fonds entries and a total record count", async () => {
    const result = await writeDescriptionsIndex(
      storage,
      ["co-ahr-gob", "co-ahr-jud", "co-ahr-not"],
      {
        "co-ahr-gob": 45341,
        "co-ahr-jud": 5848,
        "co-ahr-not": 3181,
      },
      TEST_TENANT
    );

    expect(result).toEqual({ totalRecordCount: 54370, fondsCount: 3 });

    const call = (storage.putObject as any).mock.calls[0];
    expect(call[0]).toBe("neogranadina/descriptions-index.json");

    const parsed = JSON.parse(call[1]) as DescriptionsIndex;
    expect(parsed.version).toBe(1);
    expect(parsed.total_record_count).toBe(54370);
    expect(parsed.fonds).toHaveLength(3);
    expect(parsed.fonds[0]).toEqual({
      fonds_code: "co-ahr-gob",
      key: "neogranadina/descriptions-co-ahr-gob.json",
      record_count: 45341,
    });
    // generated_at is an ISO string
    expect(() => new Date(parsed.generated_at).toISOString()).not.toThrow();
  });

  it("defaults missing record counts to 0", async () => {
    const result = await writeDescriptionsIndex(
      storage,
      ["f1", "f2"],
      { f1: 100 }, // f2 not provided
      TEST_TENANT
    );

    expect(result.totalRecordCount).toBe(100);
    const parsed = JSON.parse(
      (storage.putObject as any).mock.calls[0][1]
    ) as DescriptionsIndex;
    expect(parsed.fonds[1].record_count).toBe(0);
  });

  it("produces an empty index when no fonds are selected", async () => {
    const result = await writeDescriptionsIndex(storage, [], {}, TEST_TENANT);
    expect(result).toEqual({ totalRecordCount: 0, fondsCount: 0 });
    const parsed = JSON.parse(
      (storage.putObject as any).mock.calls[0][1]
    ) as DescriptionsIndex;
    expect(parsed.fonds).toEqual([]);
  });

  it("retains FondsBodyTooLargeError as a named export (reserved for future streaming impl)", () => {
    const err = new FondsBodyTooLargeError("co-ahr-gob", 999, 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("FondsBodyTooLargeError");
    expect(err.fondsCode).toBe("co-ahr-gob");
    expect(err.size).toBe(999);
    expect(err.limit).toBe(500);
  });
});
