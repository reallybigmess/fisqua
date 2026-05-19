/**
 * Repository Formatter
 *
 * This module deals with formatting the repositories index for the
 * published frontend: every enabled repository, its display metadata,
 * the list of root descriptions it holds, and computed counts derived
 * from the set of descriptions that are being published in the same
 * run.
 *
 * @version v0.3.0
 */

import type { ExportRepository, ExportDescription } from "./types";

/**
 * Format repositories with nested root_descriptions and computed counts.
 *
 * This no longer takes the full set of formatted descriptions.
 * Memory does not scale with the dataset:
 *   - description counts are precomputed via a lightweight GROUP BY query
 *   - root_descriptions are passed in already formatted (the small set of
 *     fonds-level rows, one per fonds — at most a few dozen total)
 */
export function formatRepositories(
  repos: Array<{
    id: string;
    code: string;
    name: string;
    shortName: string | null;
    countryCode: string | null;
    country: string | null;
    city: string | null;
    address: string | null;
    website: string | null;
    rightsText: string | null;
    displayTitle: string | null;
    subtitle: string | null;
    heroImageUrl: string | null;
  }>,
  descriptionCountByRepoCode: Map<string, number>,
  formattedRoots: ExportDescription[]
): ExportRepository[] {
  return repos.map((repo) => {
    const repoRoots = formattedRoots.filter(
      (d) => d.repository_code === repo.code
    );

    // Strip ocr_text from root_descriptions.
    const rootsWithoutOcr = repoRoots.map((d) => {
      const { ocr_text: _, ...rest } = d;
      return rest;
    });

    return {
      id: repo.id,
      code: repo.code,
      name: repo.name,
      short_name: repo.shortName,
      country_code: repo.countryCode,
      country: repo.country,
      city: repo.city,
      address: repo.address,
      website: repo.website,
      description_count: descriptionCountByRepoCode.get(repo.code) ?? 0,
      image_reproduction_text: repo.rightsText ?? "",
      display_title: repo.displayTitle ?? null,
      subtitle: repo.subtitle ?? null,
      hero_image_url: repo.heroImageUrl ?? null,
      root_descriptions: rootsWithoutOcr,
    };
  });
}
