/**
 * Tests — promotion server orchestrator
 *
 * This suite pins the three top-level orchestrator helpers behind
 * promotion: `promoteEntries` (the bulk-promote action that drives
 * a list of approved entries through field-mapping, manifest
 * generation, and R2 upload all in one batch), `getPromotableEntries`
 * (the loader the operator's promote-volume page consumes to
 * surface entries with `description_status='approved'`), and
 * `getVolumesWithPromotableEntries` (the dashboard-side roll-up).
 *
 * The atomicity contract here is what backstops the operator's
 * mental model: promoting a volume either fully promotes every
 * approved entry on it or none, so the operator never has to
 * reason about a partial state. The cases mock the R2 bucket
 * binding (no real network) and exercise the batch composition,
 * with one mocked failure scenario pinning the all-or-nothing
 * rollback.
 *
 * @version v0.4.0
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  promoteEntries,
  getPromotableEntries,
  getVolumesWithPromotableEntries,
} from "../../app/lib/promote/promote.server";
import { DEFAULT_TEST_TENANT_ID } from "../helpers/db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockBucket(): R2Bucket {
  return {
    put: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    head: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

/** Build a minimal entry row matching the entries table shape */
function makeEntryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-001",
    volumeId: "vol-001",
    parentId: null,
    position: 0,
    startPage: 1,
    startY: 0,
    endPage: null,
    endY: null,
    type: "item",
    title: "Test Document",
    modifiedBy: null,
    descriptionStatus: "approved",
    assignedDescriber: null,
    assignedDescriptionReviewer: null,
    translatedTitle: null,
    resourceType: "texto",
    dateExpression: null,
    dateStart: null,
    dateEnd: null,
    extent: null,
    scopeContent: null,
    language: null,
    descriptionNotes: null,
    internalNotes: null,
    descriptionLevel: "item",
    promotedDescriptionId: null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

function makeParentDescription(overrides: Record<string, unknown> = {}) {
  return {
    id: "desc-parent",
    repositoryId: "repo-001",
    parentId: null,
    position: 0,
    rootDescriptionId: "desc-root",
    depth: 2,
    childCount: 3,
    pathCache: "Archive > Volume",
    descriptionLevel: "file",
    resourceType: null,
    genre: "[]",
    referenceCode: "AHRB-001",
    localIdentifier: "AHRB-001",
    title: "Volume 1",
    translatedTitle: null,
    uniformTitle: null,
    dateExpression: null,
    dateStart: null,
    dateEnd: null,
    dateCertainty: null,
    extent: null,
    dimensions: null,
    medium: null,
    imprint: null,
    editionStatement: null,
    seriesStatement: null,
    volumeNumber: null,
    issueNumber: null,
    pages: null,
    provenance: null,
    scopeContent: null,
    ocrText: "",
    arrangement: null,
    accessConditions: null,
    reproductionConditions: null,
    language: null,
    locationOfOriginals: null,
    locationOfCopies: null,
    // related_materials dropped in 0036 (0% populated).
    findingAids: null,
    sectionTitle: null,
    notes: null,
    internalNotes: null,
    creatorDisplay: null,
    placeDisplay: null,
    iiifManifestUrl: null,
    hasDigital: false,
    isPublished: true,
    createdBy: null,
    updatedBy: null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

function makeVolume(overrides: Record<string, unknown> = {}) {
  return {
    id: "vol-001",
    projectId: "proj-001",
    name: "Volume 1",
    referenceCode: "AHRB-001",
    manifestUrl: "https://iiif.zasqua.org/vol1/manifest.json",
    pageCount: 10,
    status: "approved",
    assignedTo: null,
    assignedReviewer: null,
    reviewComment: null,
    createdAt: 1700000000,
    updatedAt: 1700000000,
    ...overrides,
  };
}

function makeVolumePageRow(position: number) {
  return {
    id: `vp-${position}`,
    volumeId: "vol-001",
    position,
    imageUrl: `https://iiif.zasqua.org/vol1/${position}`,
    width: 2000,
    height: 3000,
    label: `img ${position}`,
    createdAt: 1700000000,
  };
}

/**
 * Create a mock Drizzle DB that routes queries based on the table name.
 *
 * This is a lightweight mock for unit tests. The real integration tests
 * would use miniflare D1 bindings. For this level of testing, we mock
 * the query builder to return predefined data.
 */
function createMockDb(options: {
  entries?: any[];
  descriptions?: any[];
  volumes?: any[];
  volumePages?: any[];
  parentDescription?: any;
  maxPosition?: number;
}) {
  const {
    entries: entryRows = [],
    descriptions: descRows = [],
    volumes: volumeRows = [],
    volumePages: pageRows = [],
    parentDescription,
    maxPosition = -1,
  } = options;

  const insertedDescriptions: any[] = [];
  const updatedEntries: any[] = [];
  let parentChildCountDelta = 0;

  // Track which table is being queried to return appropriate mock data
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockImplementation((table: any) => {
      const tableName = table?.[Symbol.for("drizzle:Name")] ?? table?._.config?.name ?? "";
      return {
        where: vi.fn().mockImplementation((condition: any) => {
          // Route based on table
          if (tableName === "entries" || table === (globalThis as any).__entriesTable) {
            return {
              all: vi.fn().mockResolvedValue(entryRows),
              get: vi.fn().mockResolvedValue(entryRows[0] ?? null),
              orderBy: vi.fn().mockReturnValue({
                all: vi.fn().mockResolvedValue(entryRows),
              }),
            };
          }
          if (tableName === "descriptions" || table === (globalThis as any).__descriptionsTable) {
            // Check if this is a reference code uniqueness check or parent lookup
            if (parentDescription) {
              return {
                all: vi.fn().mockResolvedValue(descRows),
                get: vi.fn().mockResolvedValue(parentDescription),
              };
            }
            return {
              all: vi.fn().mockResolvedValue(descRows),
              get: vi.fn().mockResolvedValue(descRows[0] ?? null),
            };
          }
          if (tableName === "volumes" || table === (globalThis as any).__volumesTable) {
            return {
              all: vi.fn().mockResolvedValue(volumeRows),
              get: vi.fn().mockResolvedValue(volumeRows[0] ?? null),
            };
          }
          if (tableName === "volume_pages" || table === (globalThis as any).__volumePagesTable) {
            return {
              orderBy: vi.fn().mockReturnValue({
                all: vi.fn().mockResolvedValue(pageRows),
              }),
              all: vi.fn().mockResolvedValue(pageRows),
            };
          }
          return {
            all: vi.fn().mockResolvedValue([]),
            get: vi.fn().mockResolvedValue(null),
            orderBy: vi.fn().mockReturnValue({
              all: vi.fn().mockResolvedValue([]),
            }),
          };
        }),
        all: vi.fn().mockImplementation(() => {
          if (tableName === "volumes" || table === (globalThis as any).__volumesTable) {
            return Promise.resolve(volumeRows);
          }
          return Promise.resolve([]);
        }),
        orderBy: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue([]),
        }),
      };
    }),
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((vals: any) => {
        insertedDescriptions.push(vals);
        return Promise.resolve();
      }),
    })),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockImplementation((vals: any) => ({
        where: vi.fn().mockImplementation(() => {
          if (vals.promotedDescriptionId) {
            updatedEntries.push(vals);
          }
          if (vals.childCount) {
            parentChildCountDelta++;
          }
          return Promise.resolve();
        }),
      })),
    })),
    batch: vi.fn().mockResolvedValue([]),
    _inserted: insertedDescriptions,
    _updatedEntries: updatedEntries,
    _parentChildCountDelta: () => parentChildCountDelta,
  };

  return db as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("promoteEntries", () => {
  let bucket: R2Bucket;

  beforeEach(() => {
    bucket = createMockBucket();
  });

  it("rejects entries that do not belong to the specified volume ()", async () => {
    const entry = makeEntryRow({ id: "e1", volumeId: "other-volume" });
    const db = createMockDb({
      entries: [entry],
      volumes: [makeVolume()],
      parentDescription: makeParentDescription(),
      volumePages: [makeVolumePageRow(1)],
    });

    const result = await promoteEntries({
      db,
      manifestsBucket: bucket,
      entries: [{ entryId: "e1", referenceCode: "AHRB-001-d001" }],
      volumeId: "vol-001",
      userId: "user-001",
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      manifestBaseUrl: "https://manifests.zasqua.org",
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain("does not belong");
  });

  it("skips already-promoted entries", async () => {
    const entry = makeEntryRow({
      id: "e1",
      descriptionStatus: "promoted",
      promotedDescriptionId: "desc-existing",
    });
    const db = createMockDb({
      entries: [entry],
      volumes: [makeVolume()],
      parentDescription: makeParentDescription(),
      volumePages: [makeVolumePageRow(1)],
    });

    const result = await promoteEntries({
      db,
      manifestsBucket: bucket,
      entries: [{ entryId: "e1", referenceCode: "AHRB-001-d001" }],
      volumeId: "vol-001",
      userId: "user-001",
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      manifestBaseUrl: "https://manifests.zasqua.org",
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("Already promoted");
    expect(result.promoted).toHaveLength(0);
  });

  it("rejects duplicate reference codes (Pitfall 5)", async () => {
    const entry = makeEntryRow({ id: "e1" });
    const db = createMockDb({
      entries: [entry],
      descriptions: [{ referenceCode: "AHRB-001-d001" }],
      volumes: [makeVolume()],
      parentDescription: makeParentDescription(),
      volumePages: [makeVolumePageRow(1)],
    });

    const result = await promoteEntries({
      db,
      manifestsBucket: bucket,
      entries: [{ entryId: "e1", referenceCode: "AHRB-001-d001" }],
      volumeId: "vol-001",
      userId: "user-001",
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      manifestBaseUrl: "https://manifests.zasqua.org",
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain("Duplicate reference code");
  });

  it("validates reference code format ()", async () => {
    const result = await promoteEntries({
      db: createMockDb({ entries: [] }),
      manifestsBucket: bucket,
      entries: [{ entryId: "e1", referenceCode: "invalid code!@#" }],
      volumeId: "vol-001",
      userId: "user-001",
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      manifestBaseUrl: "https://manifests.zasqua.org",
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("Invalid reference code format");
  });

  it("rejects batches exceeding MAX_BATCH_SIZE ()", async () => {
    const largeEntries = Array.from({ length: 201 }, (_, i) => ({
      entryId: `e${i}`,
      referenceCode: `ref-${i}`,
    }));

    await expect(
      promoteEntries({
        db: createMockDb({ entries: [] }),
        manifestsBucket: bucket,
        entries: largeEntries,
        volumeId: "vol-001",
        userId: "user-001",
        tenantId: DEFAULT_TEST_TENANT_ID,
        standard: "isadg",
        manifestBaseUrl: "https://manifests.zasqua.org",
      })
    ).rejects.toThrow("exceeds maximum");
  });

  it("rejects entries with type other than item", async () => {
    const entry = makeEntryRow({ id: "e1", type: "blank" });
    const db = createMockDb({
      entries: [entry],
      volumes: [makeVolume()],
      parentDescription: makeParentDescription(),
      volumePages: [makeVolumePageRow(1)],
    });

    const result = await promoteEntries({
      db,
      manifestsBucket: bucket,
      entries: [{ entryId: "e1", referenceCode: "AHRB-001-d001" }],
      volumeId: "vol-001",
      userId: "user-001",
      tenantId: DEFAULT_TEST_TENANT_ID,
      standard: "isadg",
      manifestBaseUrl: "https://manifests.zasqua.org",
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain("Only item entries");
  });
});

describe("getPromotableEntries", () => {
  it("returns separate arrays for promotable and already-promoted", async () => {
    const promotable = [makeEntryRow({ id: "e1", descriptionStatus: "approved" })];
    const alreadyPromoted = [
      makeEntryRow({
        id: "e2",
        descriptionStatus: "promoted",
        promotedDescriptionId: "d1",
      }),
    ];

    // For this simple query test, mock the db to return different results
    // based on the where condition
    let callCount = 0;
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => ({
          orderBy: vi.fn().mockReturnValue({
            all: vi.fn().mockImplementation(() => {
              callCount++;
              return Promise.resolve(callCount === 1 ? promotable : alreadyPromoted);
            }),
          }),
        })),
      }),
    };

    const result = await getPromotableEntries(mockDb as any, DEFAULT_TEST_TENANT_ID, "vol-001");
    expect(result.promotable).toHaveLength(1);
    expect(result.alreadyPromoted).toHaveLength(1);
    expect(result.promotable[0].id).toBe("e1");
    expect(result.alreadyPromoted[0].id).toBe("e2");
  });
});

describe("getVolumesWithPromotableEntries", () => {
  it("returns only volumes with promotable entry count > 0", async () => {
    const volumes = [
      { id: "v1", name: "Vol 1", referenceCode: "REF-001" },
      { id: "v2", name: "Vol 2", referenceCode: "REF-002" },
    ];

    // getVolumesWithPromotableEntries now tenant-scopes the volume scan,
    // so BOTH the volumes query and each per-volume entry-count query end
    // in `.where(...).all()`. Track the shared where().all() call order:
    // call 1 = the volumes list; calls 2+ = per-volume promotable counts
    // (v1 -> 5, v2 -> 0).
    let whereAllCall = 0;
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn().mockImplementation(() => {
            whereAllCall++;
            if (whereAllCall === 1) return Promise.resolve(volumes);
            return Promise.resolve([{ count: whereAllCall === 2 ? 5 : 0 }]);
          }),
        }),
      }),
    };

    const result = await getVolumesWithPromotableEntries(mockDb as any, DEFAULT_TEST_TENANT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("v1");
    expect(result[0].promotableCount).toBe(5);
  });
});
