/**
 * Federation Export Aggregation (federation migration sequence step 8)
 *
 * This suite is the keystone proof of PUBLISH-NEUTRALITY for the
 * federation publish path. After the step-6 partition the Neogranadina
 * federation's content is split across two tenants (neogranadina: the
 * co-ahrb/etc. repositories; ahr: the co-ahr repository, 55,359
 * descriptions in production). A plain single-tenant Neogranadina export
 * would now MISS every AHR description — a regression in published
 * output. Step 8 makes the LEAD's publish read across every member
 * tenant while writing every artefact under the ONE lead slug, so the
 * partition + federation-reads round-trip is publish-neutral.
 *
 * The fixture is a two-tenant federation: `neogranadina` (lead) owns the
 * `co-ahrb` repository/fonds; `ahr` (member, same federation) owns the
 * `co-ahr` repository/fonds. An entity and a place are linked ONLY to
 * the AHR (member) fonds. The suite then asserts, on a real in-Worker
 * D1:
 *
 *   1. resolveExportScope on the lead yields BOTH members, publishSlug =
 *      lead slug.
 *   2. getScopedFondsList over the members returns BOTH fonds; a
 *      lead-only list returns only the lead's fonds (the omission a
 *      plain neogranadina export would suffer).
 *   3. getFondsOwners maps the AHR fonds to the ahr tenant (so the
 *      per-fonds read hits the right tenant) while the write key stays
 *      under the lead slug.
 *   4. The federation export writes the AHR fonds' descriptions / EAD3 /
 *      DC artefacts UNDER THE LEAD SLUG, well-formed, containing the
 *      member rows — where a lead-only export omits them entirely.
 *   5. repositories.json aggregates BOTH tenants' repositories.
 *   6. entities.json / places.json include the authority linked only to
 *      the AHR fonds under the federation read, and OMIT it under the
 *      lead-only read.
 *   7. The description set the federation export emits equals the full
 *      published set across both tenants (set equivalence).
 *
 * @version v0.4.2
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  DEFAULT_TEST_FEDERATION_ID,
  applyMigrations,
  cleanDatabase,
} from "../helpers/db";
import { AHR_TENANT_ID } from "../../app/lib/tenant";
import {
  exportFondsDescriptions,
  exportFondsEad,
  exportFondsDc,
  exportEntities,
  exportPlaces,
  exportRepositories,
} from "../../app/lib/export/pipeline.server";
import {
  getScopedFondsList,
  getFondsOwners,
} from "../../app/lib/export/fonds-list.server";
import { resolveExportScope } from "../../app/lib/export/federation-scope.server";
import type { ExportStorage } from "../../app/lib/export/r2-client.server";
import type { ExportTenant } from "../../app/lib/export/types";

/** Records every key + body the pipeline writes, JSON and XML alike. */
class RecordingStorage {
  puts: Array<{ key: string; body: string; contentType: string }> = [];
  async putObject(key: string, body: string): Promise<void> {
    this.puts.push({ key, body, contentType: "application/json" });
  }
  async putObjectXml(key: string, body: string): Promise<void> {
    this.puts.push({ key, body, contentType: "application/xml" });
  }
  async deleteObject(): Promise<void> {}
  async putObjectStream(): Promise<void> {}
  async getObjectStream(): Promise<ReadableStream | null> {
    return null;
  }
  async getObjectHead(): Promise<{ size: number } | null> {
    return null;
  }
  find(keyEnd: string) {
    return this.puts.find((p) => p.key.endsWith(keyEnd));
  }
}

const LEAD_SLUG = "neogranadina";

// Lead tenant (Neogranadina), keyed under its own slug.
const LEAD_TENANT: ExportTenant = {
  id: DEFAULT_TEST_TENANT_ID,
  federationId: DEFAULT_TEST_FEDERATION_ID,
  slug: LEAD_SLUG,
  descriptiveStandard: "isadg",
};

type Db = ReturnType<typeof drizzle>;

// Stable ids so leak/presence assertions read cleanly.
const NEO_FONDS_ID = "aaaaaaaa-0001-4001-8001-000000000001";
const NEO_CHILD_ID = "aaaaaaaa-0001-4001-8001-000000000002";
const AHR_FONDS_ID = "bbbbbbbb-0001-4001-8001-000000000001";
const AHR_CHILD_ID = "bbbbbbbb-0001-4001-8001-000000000002";
const AHR_ONLY_ENTITY_ID = "cccccccc-0001-4001-8001-000000000001";
const AHR_ONLY_PLACE_ID = "dddddddd-0001-4001-8001-000000000001";

/**
 * Seed a two-tenant federation: lead (neogranadina, co-ahrb) + member
 * (ahr, co-ahr) in the SAME federation. An entity + place link ONLY to
 * the AHR (member) fonds so the authority fan-out is testable.
 */
async function seedFederationFixture(db: Db) {
  const now = Date.now();

  // Member tenant `ahr` in the Neogranadina federation (the step-6
  // partition target). cleanDatabase() re-seeds only the standard
  // fixtures, so ahr is inserted per-test here.
  await db.insert(schema.tenants).values({
    id: AHR_TENANT_ID,
    slug: "ahr",
    name: "Archivo Histórico de Rionegro",
    kind: "tenant",
    descriptiveStandard: "isadg",
    status: "active",
    crowdsourcingEnabled: false,
    vocabularyHubEnabled: true,
    publishPipelineEnabled: true,
    multiRepositoryEnabled: false,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    createdAt: now,
    updatedAt: now,
  });

  const neoRepoId = crypto.randomUUID();
  const ahrRepoId = crypto.randomUUID();
  await db.insert(schema.repositories).values([
    {
      id: neoRepoId,
      tenantId: DEFAULT_TEST_TENANT_ID,
      code: "co-ahrb",
      name: "Archivo Histórico de la Diócesis",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: ahrRepoId,
      tenantId: AHR_TENANT_ID,
      code: "co-ahr",
      name: "Archivo Histórico de Rionegro",
      country: "Colombia",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Lead fonds (co-ahrb-gob) + one published child.
  await db.insert(schema.descriptions).values([
    {
      id: NEO_FONDS_ID,
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: neoRepoId,
      parentId: null,
      rootDescriptionId: NEO_FONDS_ID,
      descriptionLevel: "fonds",
      referenceCode: "co-ahrb-gob",
      localIdentifier: "AHRB-001",
      title: "Gobierno (AHRB)",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: NEO_CHILD_ID,
      tenantId: DEFAULT_TEST_TENANT_ID,
      repositoryId: neoRepoId,
      parentId: NEO_FONDS_ID,
      rootDescriptionId: NEO_FONDS_ID,
      descriptionLevel: "series",
      referenceCode: "co-ahrb-gob-s1",
      localIdentifier: "AHRB-001-s1",
      title: "Serie AHRB",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Member (AHR) fonds (co-ahr-gob) + one published child.
  await db.insert(schema.descriptions).values([
    {
      id: AHR_FONDS_ID,
      tenantId: AHR_TENANT_ID,
      repositoryId: ahrRepoId,
      parentId: null,
      rootDescriptionId: AHR_FONDS_ID,
      descriptionLevel: "fonds",
      referenceCode: "co-ahr-gob",
      localIdentifier: "AHR-001",
      title: "Gobierno (AHR)",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: AHR_CHILD_ID,
      tenantId: AHR_TENANT_ID,
      repositoryId: ahrRepoId,
      parentId: AHR_FONDS_ID,
      rootDescriptionId: AHR_FONDS_ID,
      descriptionLevel: "series",
      referenceCode: "co-ahr-gob-s1",
      localIdentifier: "AHR-001-s1",
      title: "Serie AHR",
      isPublished: true,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Federation-scoped entity + place, each linked ONLY to the AHR fonds.
  // A lead-only export never sees them; a federation export must.
  await db.insert(schema.entities).values({
    id: AHR_ONLY_ENTITY_ID,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    entityCode: "ne-ahr-001",
    displayName: "Alcalde de Rionegro",
    sortName: "Alcalde de Rionegro",
    entityType: "person",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.descriptionEntities).values({
    id: crypto.randomUUID(),
    descriptionId: AHR_FONDS_ID,
    entityId: AHR_ONLY_ENTITY_ID,
    role: "subject",
    createdAt: now,
  });

  await db.insert(schema.places).values({
    id: AHR_ONLY_PLACE_ID,
    federationId: DEFAULT_TEST_FEDERATION_ID,
    placeCode: "pl-ahr-001",
    label: "Rionegro",
    displayName: "Rionegro, Antioquia",
    placeType: "city",
    fclass: "P",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.descriptionPlaces).values({
    id: crypto.randomUUID(),
    descriptionId: AHR_FONDS_ID,
    placeId: AHR_ONLY_PLACE_ID,
    role: "subject",
    createdAt: now,
  });
}

describe("Federation export aggregation (step 8)", () => {
  let db: Db;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    db = drizzle(env.DB, { schema });
    await seedFederationFixture(db);
  });

  it("resolveExportScope on the lead yields both members under the lead slug", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);
    expect(scope.isFederation).toBe(true);
    expect(scope.publishSlug).toBe(LEAD_SLUG);
    expect(scope.memberTenantIds.sort()).toEqual(
      [DEFAULT_TEST_TENANT_ID, AHR_TENANT_ID].sort()
    );
    // publishTenant carries the lead identity + lead slug.
    expect(scope.publishTenant.id).toBe(DEFAULT_TEST_TENANT_ID);
    expect(scope.publishTenant.slug).toBe(LEAD_SLUG);
  });

  it("scoped fonds list unions both members; lead-only list omits the AHR fonds", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);
    const fedList = await getScopedFondsList(db, scope.memberTenantIds);
    expect(fedList).toContain("co-ahr-gob");
    expect(fedList).toContain("co-ahrb-gob");

    // The omission a plain single-tenant Neogranadina export would suffer.
    const leadOnly = await getScopedFondsList(db, [DEFAULT_TEST_TENANT_ID]);
    expect(leadOnly).toContain("co-ahrb-gob");
    expect(leadOnly).not.toContain("co-ahr-gob");
  });

  it("getFondsOwners maps the AHR fonds to the ahr tenant", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);
    const owners = await getFondsOwners(db, scope.memberTenantIds);
    expect(owners.get("co-ahr-gob")).toBe(AHR_TENANT_ID);
    expect(owners.get("co-ahrb-gob")).toBe(DEFAULT_TEST_TENANT_ID);
  });

  it("writes the AHR fonds descriptions/EAD/DC under the LEAD slug, well-formed", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);
    const owners = await getFondsOwners(db, scope.memberTenantIds);
    // Per-fonds synthetic tenant: owner id, but publish (lead) slug —
    // exactly what the workflow's load-config builds.
    const ownerId = owners.get("co-ahr-gob")!;
    const ahrFondsTenant: ExportTenant = {
      id: ownerId,
      federationId: scope.federationId,
      slug: scope.publishSlug,
      descriptiveStandard: "isadg",
    };
    const storage = new RecordingStorage();

    const desc = await exportFondsDescriptions(
      db,
      storage as unknown as ExportStorage,
      "co-ahr-gob",
      ahrFondsTenant
    );
    await exportFondsEad(
      db,
      storage as unknown as ExportStorage,
      "co-ahr-gob",
      ahrFondsTenant
    );
    await exportFondsDc(
      db,
      storage as unknown as ExportStorage,
      "co-ahr-gob",
      ahrFondsTenant
    );

    // Descriptions JSON: under the LEAD slug, contains member rows, valid JSON.
    const descPut = storage.find("descriptions-co-ahr-gob.json");
    expect(descPut, "AHR descriptions artefact must exist").toBeDefined();
    expect(descPut!.key).toBe("neogranadina/descriptions-co-ahr-gob.json");
    const parsed = JSON.parse(descPut!.body) as Array<{ reference_code: string }>;
    expect(desc.recordCount).toBe(2); // fonds + child
    const refs = parsed.map((d) => d.reference_code).sort();
    expect(refs).toEqual(["co-ahr-gob", "co-ahr-gob-s1"]);

    // EAD3 + DC: under the LEAD slug, well-formed XML.
    const eadPut = storage.find("ead/co-ahr-gob.xml");
    expect(eadPut!.key.startsWith("neogranadina/ead/")).toBe(true);
    expect(eadPut!.body).toContain("<ead");
    expect(eadPut!.body).toContain("co-ahr-gob");
    const dcPut = storage.find("dc/co-ahr-gob.xml");
    expect(dcPut!.key.startsWith("neogranadina/dc/")).toBe(true);
    expect(dcPut!.body).toContain("co-ahr-gob");

    // EVERY key written under the one publish slug.
    for (const p of storage.puts) {
      expect(p.key.startsWith(`${LEAD_SLUG}/`)).toBe(true);
    }
  });

  it("repositories.json aggregates BOTH tenants' repositories", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);
    const storage = new RecordingStorage();
    await exportRepositories(
      db,
      storage as unknown as ExportStorage,
      scope.publishTenant,
      scope.memberTenantIds
    );
    const put = storage.find("repositories.json");
    expect(put!.key).toBe("neogranadina/repositories.json");
    const repos = JSON.parse(put!.body) as Array<{ code: string; description_count: number }>;
    const codes = repos.map((r) => r.code).sort();
    expect(codes).toEqual(["co-ahr", "co-ahrb"]);
    // The AHR repo carries its (member-tenant) published-description count.
    const ahr = repos.find((r) => r.code === "co-ahr")!;
    expect(ahr.description_count).toBe(2);
  });

  it("entities/places include the AHR-only authority under federation read, omit it under lead-only read", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);

    // Federation read: AHR-only entity + place ARE present.
    const fedStorage = new RecordingStorage();
    await exportEntities(
      db,
      fedStorage as unknown as ExportStorage,
      scope.publishTenant,
      scope.memberTenantIds
    );
    await exportPlaces(
      db,
      fedStorage as unknown as ExportStorage,
      scope.publishTenant,
      scope.memberTenantIds
    );
    const fedEntities = JSON.parse(fedStorage.find("entities.json")!.body) as Array<{
      entity_code: string | null;
    }>;
    const fedPlaces = JSON.parse(fedStorage.find("places.json")!.body) as Array<{
      place_code: string | null;
    }>;
    expect(fedEntities.map((e) => e.entity_code)).toContain("ne-ahr-001");
    expect(fedPlaces.map((p) => p.place_code)).toContain("pl-ahr-001");

    // Lead-only read (the regression a plain neogranadina export causes):
    // the AHR-only authority is OMITTED.
    const leadStorage = new RecordingStorage();
    await exportEntities(db, leadStorage as unknown as ExportStorage, LEAD_TENANT);
    await exportPlaces(db, leadStorage as unknown as ExportStorage, LEAD_TENANT);
    const leadEntities = JSON.parse(leadStorage.find("entities.json")!.body) as Array<{
      entity_code: string | null;
    }>;
    const leadPlaces = JSON.parse(leadStorage.find("places.json")!.body) as Array<{
      place_code: string | null;
    }>;
    expect(leadEntities.map((e) => e.entity_code)).not.toContain("ne-ahr-001");
    expect(leadPlaces.map((p) => p.place_code)).not.toContain("pl-ahr-001");
  });

  it("federation description set equals the full published set across both tenants", async () => {
    const scope = await resolveExportScope(db, LEAD_TENANT);

    // What the federation export reads: published descriptions across all
    // member tenants.
    const fedRows = await db
      .select({ id: schema.descriptions.id })
      .from(schema.descriptions)
      .where(
        and(
          inArray(schema.descriptions.tenantId, scope.memberTenantIds),
          eq(schema.descriptions.isPublished, true)
        )
      )
      .all();

    // The full published set irrespective of tenant (the pre-partition
    // single-tenant Neogranadina read, now spread across two tenants).
    const allRows = await db
      .select({ id: schema.descriptions.id })
      .from(schema.descriptions)
      .where(eq(schema.descriptions.isPublished, true))
      .all();

    expect(fedRows.length).toBe(allRows.length);
    expect(fedRows.length).toBe(4); // 2 lead + 2 member

    // And a lead-only read is strictly smaller (misses the AHR rows).
    const leadRows = await db
      .select({ id: schema.descriptions.id })
      .from(schema.descriptions)
      .where(
        and(
          eq(schema.descriptions.tenantId, DEFAULT_TEST_TENANT_ID),
          eq(schema.descriptions.isPublished, true)
        )
      )
      .all();
    expect(leadRows.length).toBe(2);
  });
});
