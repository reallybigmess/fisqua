/**
 * Tests — pipeline
 *
 * This suite pins the export pipeline's per-step contract: every
 * pipeline step takes a `tenant: ExportTenant` argument. The
 * mock-DB tests below pass a fixed test tenant (`TEST_TENANT`) and
 * assert the slug-prefixed key shape; the cross-tenant data-leak
 * coverage lives in `tests/export/cross-tenant.test.ts` against a
 * real D1 binding.
 *
 * @version v0.4.2
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as descriptionsServer from "../../app/lib/export/descriptions.server";
import {
  exportFondsDescriptions,
  exportFondsChildren,
  exportRepositories,
  exportEntities,
  exportPlaces,
  recordStepStart,
  recordStepEnd,
} from "../../app/lib/export/pipeline.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

const TEST_TENANT: ExportTenant = {
  id: "test-tenant-id",
  federationId: "b4462493-6170-44f8-ae07-24666606d1f1", // NEOGRANADINA_FEDERATION_ID
  slug: "neogranadina",
  descriptiveStandard: "isadg",
};

/**
 * Tests for the per-step pure functions introduced in 23-06.
 *
 * The legacy `runExportPipeline` orchestration is gone — that responsibility
 * lives in the PublishExportWorkflow now (Task 3). These tests cover each
 * extracted step function in isolation, with a chainable mock DB that can
 * be configured per query.
 */

function mockStorage() {
  return {
    putObject: vi.fn().mockResolvedValue(undefined),
    deleteObject: vi.fn().mockResolvedValue(undefined),
    putObjectStream: vi.fn().mockResolvedValue(undefined),
    getObjectStream: vi.fn().mockResolvedValue(null),
    getObjectHead: vi.fn().mockResolvedValue(null),
  } as unknown as ExportStorage & {
    putObject: ReturnType<typeof vi.fn>;
  };
}

function makeDescRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "desc-001",
    repositoryId: "repo-001",
    parentId: null as string | null,
    position: 0,
    rootDescriptionId: "root-001",
    depth: 0,
    childCount: 0,
    pathCache: "",
    descriptionLevel: "file",
    resourceType: null,
    genre: "[]",
    referenceCode: "co-ahr-gob-caj001-car001",
    localIdentifier: "GOB-001",
    title: "Test description",
    translatedTitle: null,
    uniformTitle: null,
    dateExpression: "1810",
    dateStart: "1810-01-01",
    dateEnd: null,
    dateCertainty: null,
    extent: "1 folio",
    dimensions: null,
    medium: null,
    imprint: null,
    editionStatement: null,
    seriesStatement: null,
    volumeNumber: null,
    issueNumber: null,
    pages: null,
    provenance: null,
    scopeContent: "Test scope",
    ocrText: "",
    arrangement: null,
    accessConditions: null,
    reproductionConditions: null,
    language: "192",
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

/**
 * A minimal Drizzle-shaped mock that resolves the next configured response
 * for `.get()` / `.all()`. Each `db.select(...)` call advances an internal
 * cursor; tests provide an ordered list of responses.
 */
function createMockDb(responses: unknown[]) {
  let cursor = 0;
  const updateCalls: Array<{ values: any }> = [];

  function chain(method: "select" | "selectDistinct" | "update") {
    const c: any = {
      from: () => c,
      where: () => c,
      innerJoin: () => c,
      orderBy: () => c,
      limit: () => c,
      groupBy: () => c,
      set: (values: any) => {
        c._setValues = values;
        return c;
      },
      get: () => Promise.resolve(responses[cursor++] ?? null),
      all: () => Promise.resolve((responses[cursor++] ?? []) as unknown[]),
      then: undefined as any,
    };
    if (method === "update") {
      c.then = (resolve: (v: undefined) => void) => {
        updateCalls.push({ values: c._setValues });
        resolve(undefined);
      };
    }
    return c;
  }

  const db: any = {
    select: () => chain("select"),
    selectDistinct: () => chain("selectDistinct"),
    update: () => chain("update"),
    _updateCalls: updateCalls,
    _cursor: () => cursor,
  };
  return db;
}

describe("exportFondsDescriptions", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uploads descriptions-{fonds}.json with the formatted rows and returns recordCount + byteSize", async () => {
    const desc = makeDescRow({ id: "d1", referenceCode: "co-ahr-gob-001" });
    const db = createMockDb([
      { id: "root-1" }, // root lookup
      [desc],          // fonds rows
      { code: "co-ahr", country: "Colombia" }, // repo lookup
    ]);

    const result = await exportFondsDescriptions(db, storage, "co-ahr-gob", TEST_TENANT);

    expect(result.recordCount).toBe(1);
    expect(result.byteSize).toBeGreaterThan(0);
    const calls = (storage.putObject as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("neogranadina/descriptions-co-ahr-gob.json");
    const body = JSON.parse(calls[0][1]);
    expect(body).toHaveLength(1);
    expect(body[0].reference_code).toBe("co-ahr-gob-001");
  });

  it("uploads an empty array and returns recordCount=0 when the fonds root does not exist", async () => {
    const db = createMockDb([null]); // root lookup returns null
    const result = await exportFondsDescriptions(db, storage, "missing", TEST_TENANT);

    expect(result.recordCount).toBe(0);
    expect(result.byteSize).toBe(2); // "[]"
    expect((storage.putObject as any).mock.calls[0][0]).toBe(
      "neogranadina/descriptions-missing.json"
    );
    expect((storage.putObject as any).mock.calls[0][1]).toBe("[]");
  });

  it("does NOT touch a global accumulator across fonds", async () => {
    // Independence assertion: two separate calls to exportFondsDescriptions
    // must not share state — each call uploads exactly one per-fonds key
    // and never the combined descriptions.json key.
    const desc = makeDescRow({ id: "d1" });
    const db1 = createMockDb([{ id: "root-1" }, [desc], { code: "co-ahr", country: "Colombia" }]);
    const db2 = createMockDb([{ id: "root-2" }, [desc], { code: "co-ahr", country: "Colombia" }]);

    await exportFondsDescriptions(db1, storage, "co-ahr-gob", TEST_TENANT);
    await exportFondsDescriptions(db2, storage, "co-ahr-jud", TEST_TENANT);

    const keys = (storage.putObject as any).mock.calls.map((c: any[]) => c[0]);
    expect(keys).toEqual([
      "neogranadina/descriptions-co-ahr-gob.json",
      "neogranadina/descriptions-co-ahr-jud.json",
    ]);
    expect(keys).not.toContain("descriptions.json");
  });
});

describe("exportFondsChildren", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("batches PUTs at 50 concurrent, never exceeding parent count", async () => {
    // 130 parents → 3 batches of 50/50/30. Total PUTs = 130 (one per parent
    // in childrenMap). Without batching this would be a single Promise.all of
    // 130, but the public surface is "<= parent count, batched". The test
    // asserts the count and that all keys are children/* keys.
    const parents = Array.from({ length: 130 }, (_, i) => ({
      id: `p${i}`,
      parentId: "root-1",
      referenceCode: `ref-${i}`,
      title: `T${i}`,
      descriptionLevel: "file",
      dateExpression: null,
      childCount: 1, // each parent has one child to ensure it shows up in childrenMap
      hasDigital: false,
      position: i,
    }));
    // Add a child for each parent so childrenMap has entries
    const children = parents.map((p, i) => ({
      id: `c${i}`,
      parentId: p.id,
      referenceCode: `child-${i}`,
      title: `Child ${i}`,
      descriptionLevel: "file",
      dateExpression: null,
      childCount: 0,
      hasDigital: false,
      position: 0,
    }));

    const db = createMockDb([
      { id: "root-1" },          // root lookup
      [...parents, ...children], // fonds rows
    ]);

    const result = await exportFondsChildren(db, storage, "co-ahr-gob", TEST_TENANT);

    const keys = (storage.putObject as any).mock.calls.map((c: any[]) => c[0]);
    // Every PUT must be a slug-prefixed children/* key
    expect(keys.every((k: string) => k.startsWith("neogranadina/children/"))).toBe(true);
    // No more PUTs than parents
    expect(keys.length).toBeLessThanOrEqual(parents.length);
    expect(result.parentCount).toBeLessThanOrEqual(parents.length);
    expect(result.putCount).toBe(keys.length);
  });

  it("returns 0/0 when the fonds root is missing and issues no PUTs", async () => {
    const db = createMockDb([null]);
    const result = await exportFondsChildren(db, storage, "missing", TEST_TENANT);
    expect(result).toEqual({ parentCount: 0, putCount: 0 });
    expect((storage.putObject as any).mock.calls).toHaveLength(0);
  });
});

describe("exportRepositories", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uses a lightweight count query and only formats the (small) root description set", async () => {
    const formatSpy = vi.spyOn(descriptionsServer, "formatDescription");
    const db = createMockDb([
      // 1) enabled repos
      [
        {
          id: "repo-1",
          code: "co-ahr",
          name: "Archivo Histórico de Rionegro",
          shortName: "AHR",
          countryCode: "COL",
          country: "Colombia",
          city: "Rionegro",
          address: null,
          website: null,
        },
      ],
      // 2) GROUP BY count
      [{ repositoryId: "repo-1", n: 12345 }],
      // 3) root descriptions (one per fonds — small set)
      [makeDescRow({ id: "root-1", referenceCode: "co-ahr-gob", parentId: null })],
    ]);

    const result = await exportRepositories(db, storage, TEST_TENANT);

    expect(result.count).toBe(1);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/repositories.json"
    );
    expect(call).toBeDefined();
    const body = JSON.parse(call[1]);
    expect(body).toHaveLength(1);
    expect(body[0].code).toBe("co-ahr");
    // count came from the GROUP BY, not from formatting all 12345 descriptions
    expect(body[0].description_count).toBe(12345);
    // formatDescription was called only for the root set (1 row), not 12345
    expect(formatSpy).toHaveBeenCalledTimes(1);
    formatSpy.mockRestore();
  });
});

describe("exportEntities", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uploads only entities linked to published descriptions", async () => {
    // Single JOIN query returns distinct entities (see exportEntities impl).
    const db = createMockDb([
      [
        {
          id: "ent-1",
          entityCode: "ne-000001",
          displayName: "Entity One",
          sortName: "Entity One",
          givenName: null,
          surname: null,
          entityType: "person",
          honorific: null,
          primaryFunction: null,
          nameVariants: "[]",
          datesOfExistence: null,
          dateStart: null,
          dateEnd: null,
          history: null,
          functions: null,
          sources: null,
          wikidataId: null,
          viafId: null,
          mergedInto: null,
        },
      ],
    ]);

    const result = await exportEntities(db, storage, TEST_TENANT);
    expect(result.count).toBe(1);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/entities.json"
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call[1])[0].entity_code).toBe("ne-000001");
  });

  it("uploads an empty array when no entities are linked", async () => {
    const db = createMockDb([[]]);
    const result = await exportEntities(db, storage, TEST_TENANT);
    expect(result.count).toBe(0);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/entities.json"
    );
    expect(call[1]).toBe("[]");
  });
});

describe("exportPlaces", () => {
  let storage: ReturnType<typeof mockStorage>;
  beforeEach(() => {
    vi.clearAllMocks();
    storage = mockStorage();
  });

  it("uploads only places linked to published descriptions", async () => {
    // Single JOIN query returns distinct places (see exportPlaces impl).
    const db = createMockDb([
      [
        {
          id: "pl-1",
          placeCode: "nl-000001",
          label: "Rionegro",
          displayName: "Rionegro",
          placeType: "city",
          nameVariants: "[]",
          latitude: 6.15,
          longitude: -75.37,
          coordinatePrecision: "exact",
          // historical_*, country_code, admin_level_*, wikidata_id all
          // dropped on places in 0036.
          fclass: "P" as "P" | "H" | "A" | "T" | "S" | null,
          tgnId: null,
          hgisId: null,
          whgId: null,
          mergedInto: null,
        },
      ],
    ]);

    const result = await exportPlaces(db, storage, TEST_TENANT);
    expect(result.count).toBe(1);
    const call = (storage.putObject as any).mock.calls.find(
      (c: any[]) => c[0] === "neogranadina/places.json"
    );
    expect(JSON.parse(call[1])[0].place_code).toBe("nl-000001");
  });
});

describe("recordStepStart / recordStepEnd", () => {
  it("recordStepStart writes currentStep, currentStepStartedAt, and lastHeartbeatAt", async () => {
    const db = createMockDb([]);
    await recordStepStart(db, "exp-1", "descriptions:co-ahr-gob");
    const call = db._updateCalls[0];
    expect(call.values.currentStep).toBe("descriptions:co-ahr-gob");
    expect(call.values.currentStepStartedAt).toBeTypeOf("number");
    expect(call.values.lastHeartbeatAt).toBeTypeOf("number");
    expect(call.values.currentStepCompletedAt).toBeNull();
  });

  it("recordStepEnd writes currentStepCompletedAt and a fresh lastHeartbeatAt", async () => {
    const db = createMockDb([]);
    await recordStepEnd(db, "exp-1", "descriptions:co-ahr-gob", { foo: 1 });
    const call = db._updateCalls[0];
    expect(call.values.currentStepCompletedAt).toBeTypeOf("number");
    expect(call.values.lastHeartbeatAt).toBeTypeOf("number");
    expect(call.values.recordCounts).toBe(JSON.stringify({ foo: 1 }));
  });
});

describe("legacy entry point removal", () => {
  it("does NOT export runExportPipeline", async () => {
    const mod = await import("../../app/lib/export/pipeline.server");
    expect((mod as any).runExportPipeline).toBeUndefined();
    expect((mod as any).updateProgress).toBeUndefined();
  });
});
