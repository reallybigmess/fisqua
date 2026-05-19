/**
 * METS Export Step
 *
 * This module deals with one fonds' worth of METS XML generation:
 * it queries the digitised descriptions that are either unexported or
 * have been edited since their last export, runs each row through
 * `buildMetsXml`, and uploads the resulting XML files to the METS R2
 * bucket that the IIIF viewer reads from. The dirty-flag pattern
 * keeps each run bounded to a small fraction of the fonds even when
 * the catalogue itself is large.
 *
 * The `tenant` argument ensures every D1 read filters by `tenant.id`
 * and every METS-bucket key is prefixed with `${tenant.slug}/`. The
 * METS bucket is a separate R2
 * binding from EXPORT_BUCKET; the prefix scheme is identical so an
 * operator listing either bucket sees the same human-readable layout.
 *
 * @version v0.4.0
 */

import { eq, and, isNull, gt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { descriptions, repositories } from "../../db/schema";
import { buildMetsXml, type MetsInput, type MetsRepository } from "./mets-builder";
import type { ExportTenant } from "./types";

/**
 * Generate and upload METS XML for dirty digitised descriptions in a fonds.
 *
 * @returns generatedCount (newly exported) and skippedCount (already up to date)
 */
export async function exportFondsMets(
  db: DrizzleD1Database<any>,
  metsBucket: R2Bucket,
  fonds: string,
  tenant: ExportTenant
): Promise<{ generatedCount: number; skippedCount: number }> {
  // Find the root description for this fonds
  const root = await db
    .select({ id: descriptions.id })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.referenceCode, fonds),
        eq(descriptions.tenantId, tenant.id)
      )
    )
    .get();

  if (!root) return { generatedCount: 0, skippedCount: 0 };

  // Count total digitised descriptions in this fonds (for skipped calc)
  const allDigitised = await db
    .select({
      id: descriptions.id,
      lastExportedAt: descriptions.lastExportedAt,
      updatedAt: descriptions.updatedAt,
    })
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.hasDigital, true),
        sql`${descriptions.iiifManifestUrl} IS NOT NULL`
      )
    )
    .all();

  // Filter to dirty descriptions (lastExportedAt IS NULL OR updatedAt > lastExportedAt)
  const dirtyIds = new Set(
    allDigitised
      .filter(
        (r) => r.lastExportedAt === null || r.updatedAt > r.lastExportedAt
      )
      .map((r) => r.id)
  );

  const skippedCount = allDigitised.length - dirtyIds.size;

  if (dirtyIds.size === 0) {
    return { generatedCount: 0, skippedCount };
  }

  // Fetch full description data for dirty rows
  const dirtyRows = await db
    .select()
    .from(descriptions)
    .where(
      and(
        eq(descriptions.tenantId, tenant.id),
        eq(descriptions.rootDescriptionId, root.id),
        eq(descriptions.hasDigital, true),
        sql`${descriptions.iiifManifestUrl} IS NOT NULL`,
        sql`(${descriptions.lastExportedAt} IS NULL OR ${descriptions.updatedAt} > ${descriptions.lastExportedAt})`
      )
    )
    .all();

  // Cache repositories and parent ref codes
  const repoCache = new Map<string, MetsRepository | null>();
  const parentRefCache = new Map<string, string | null>();

  const createDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let generatedCount = 0;

  for (const row of dirtyRows) {
    // Resolve repository
    let repo = repoCache.get(row.repositoryId);
    if (repo === undefined) {
      const repoRow = await db
        .select({
          name: repositories.name,
          city: repositories.city,
          code: repositories.code,
          rightsText: repositories.rightsText,
        })
        .from(repositories)
        .where(
          and(
            eq(repositories.id, row.repositoryId),
            eq(repositories.tenantId, tenant.id)
          )
        )
        .get();
      repo = repoRow ?? null;
      repoCache.set(row.repositoryId, repo);
    }

    // Resolve parent reference code
    let parentRefCode: string | null = null;
    if (row.parentId) {
      if (parentRefCache.has(row.parentId)) {
        parentRefCode = parentRefCache.get(row.parentId)!;
      } else {
        const parent = await db
          .select({ referenceCode: descriptions.referenceCode })
          .from(descriptions)
          .where(
            and(
              eq(descriptions.id, row.parentId),
              eq(descriptions.tenantId, tenant.id)
            )
          )
          .get();
        parentRefCode = parent?.referenceCode ?? null;
        parentRefCache.set(row.parentId, parentRefCode);
      }
    }

    const input: MetsInput = {
      referenceCode: row.referenceCode,
      title: row.title,
      descriptionLevel: row.descriptionLevel,
      dateExpression: row.dateExpression,
      scopeContent: row.scopeContent,
      creatorDisplay: row.creatorDisplay,
      language: row.language,
      extent: row.extent,
      placeDisplay: row.placeDisplay,
      imprint: row.imprint,
      parentReferenceCode: parentRefCode,
      hasDigital: row.hasDigital ?? false,
      iiifManifestUrl: row.iiifManifestUrl,
    };

    const xml = buildMetsXml(input, repo, createDate);

    // Sanitise reference code for R2 key and prefix with the tenant
    // slug so the METS bucket layout matches EXPORT_BUCKET's
    // per-tenant prefix scheme (slug, not UUID).
    const key = `${tenant.slug}/${row.referenceCode.replace(/[?#]/g, "")}.xml`;
    await metsBucket.put(key, xml, {
      httpMetadata: { contentType: "application/xml; charset=utf-8" },
    });

    // Update lastExportedAt so this description is not re-exported next run
    await db
      .update(descriptions)
      .set({ lastExportedAt: Date.now() })
      .where(
        and(
          eq(descriptions.id, row.id),
          eq(descriptions.tenantId, tenant.id)
        )
      );

    generatedCount++;
  }

  return { generatedCount, skippedCount };
}
