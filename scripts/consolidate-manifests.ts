#!/usr/bin/env npx tsx
/**
 * IIIF Manifest Consolidation
 *
 * This script is a one-time job that copies every volume's IIIF manifest
 * from the legacy `zasqua-iiif-tiles` R2 bucket into the new dedicated
 * `zasqua-manifests` bucket with a flat key structure --
 * `{reference-code}.json` -- so the viewer can resolve a manifest URL
 * in a single lookup rather than traversing the tiles bucket's
 * directory tree.
 *
 * For each manifest the script reads `homepage[0].id` to pull the
 * reference code out of the viewer URL (falling back to the manifest's
 * own id). Dry-run mode (`--dry-run`) lists the planned copies without
 * touching R2 so the operator can eyeball the set before committing.
 *
 * Prerequisites: `wrangler` authenticated and the target bucket
 * already created in the Cloudflare dashboard.
 *
 * @version v0.3.1
 */
import { execSync } from "child_process";

const SOURCE_BUCKET = "zasqua-iiif-tiles";
const TARGET_BUCKET = "zasqua-manifests";
const dryRun = process.argv.includes("--dry-run");

interface R2Object {
  key: string;
  size: number;
  etag: string;
}

interface R2ListResult {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrangler(args: string): string {
  return execSync(`npx wrangler ${args}`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024, // 50 MB for large listings
  });
}

/**
 * List all objects in an R2 bucket, handling pagination.
 * Filters for keys ending in /manifest.json.
 */
function listManifests(): R2Object[] {
  const allObjects: R2Object[] = [];
  let cursor: string | undefined;
  let page = 1;

  do {
    const cursorArg = cursor ? ` --cursor "${cursor}"` : "";
    const raw = wrangler(`r2 object list ${SOURCE_BUCKET}${cursorArg}`);

    let result: R2ListResult;
    try {
      result = JSON.parse(raw);
    } catch {
      // wrangler may output non-JSON warnings before the JSON
      const jsonStart = raw.indexOf("{");
      if (jsonStart === -1) {
        console.error(`Failed to parse listing page ${page}`);
        break;
      }
      result = JSON.parse(raw.slice(jsonStart));
    }

    const manifests = result.objects.filter((o) =>
      o.key.endsWith("/manifest.json")
    );
    allObjects.push(...manifests);

    console.log(
      `  Page ${page}: ${result.objects.length} objects, ${manifests.length} manifests`
    );

    cursor = result.truncated ? result.cursor : undefined;
    page++;
  } while (cursor);

  return allObjects;
}

/**
 * Download an object from R2 as a string.
 */
function getObject(bucket: string, key: string): string {
  // wrangler r2 object get writes to stdout
  return wrangler(`r2 object get ${bucket}/${key} --pipe`);
}

/**
 * Upload a string to R2.
 */
function putObject(bucket: string, key: string, body: string): void {
  // Write body to a temp file, then upload
  const tmpFile = `/tmp/consolidate-manifest-${Date.now()}.json`;
  require("fs").writeFileSync(tmpFile, body, "utf-8");
  try {
    wrangler(
      `r2 object put ${bucket}/${key} --file "${tmpFile}" --content-type "application/ld+json"`
    );
  } finally {
    try {
      require("fs").unlinkSync(tmpFile);
    } catch {
      // ignore cleanup failures
    }
  }
}

/**
 * Extract reference code from a IIIF v3 manifest JSON.
 *
 * Tries:
 * 1. homepage[0].id URL: https://fisqua.org/viewer/{ref-code} (pre-rename manifests still use catalogacion.zasqua.org/viewer/{ref-code} and are caught by the regex since both share the {ref-code} tail)
 * 2. manifest id URL: https://.../{ref-code}.json or https://.../{ref-code}/manifest.json
 * 3. Falls back to the directory name from the source key
 */
function extractReferenceCode(
  manifest: any,
  sourceKey: string
): string | null {
  // Strategy 1: homepage URL
  const homepageUrl = manifest.homepage?.[0]?.id;
  if (homepageUrl) {
    const match = homepageUrl.match(/zasqua\.org\/(?:viewer\/)?([^/]+)\/?$/);
    if (match) return match[1];
  }

  // Strategy 2: manifest id URL
  const manifestId = manifest.id;
  if (manifestId) {
    // Try {ref-code}.json pattern
    const jsonMatch = manifestId.match(/\/([^/]+)\.json$/);
    if (jsonMatch) return jsonMatch[1];
    // Try {ref-code}/manifest.json pattern
    const dirMatch = manifestId.match(/\/([^/]+)\/manifest\.json$/);
    if (dirMatch) return dirMatch[1];
  }

  // Strategy 3: source key directory
  const parts = sourceKey.split("/");
  if (parts.length >= 2) {
    return parts[parts.length - 2]; // directory before manifest.json
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Manifest consolidation: ${SOURCE_BUCKET} -> ${TARGET_BUCKET}`);
  if (dryRun) {
    console.log("  DRY RUN -- no objects will be copied\n");
  }
  console.log();

  // Step 1: List all manifests in source bucket
  console.log("Listing manifests in source bucket...");
  const manifests = listManifests();
  console.log(`\nFound ${manifests.length} manifest(s)\n`);

  if (manifests.length === 0) {
    console.log("Nothing to consolidate.");
    return;
  }

  // Step 2: Process each manifest
  let copied = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < manifests.length; i++) {
    const obj = manifests[i];
    const progress = `[${i + 1}/${manifests.length}]`;

    try {
      // Download manifest
      const raw = getObject(SOURCE_BUCKET, obj.key);
      let manifestJson: any;
      try {
        manifestJson = JSON.parse(raw);
      } catch {
        // wrangler may prepend status output
        const jsonStart = raw.indexOf("{");
        if (jsonStart === -1) {
          console.log(`${progress} SKIP ${obj.key} -- not valid JSON`);
          skipped++;
          continue;
        }
        manifestJson = JSON.parse(raw.slice(jsonStart));
      }

      // Extract reference code
      const refCode = extractReferenceCode(manifestJson, obj.key);
      if (!refCode) {
        console.log(
          `${progress} SKIP ${obj.key} -- could not extract reference code`
        );
        skipped++;
        continue;
      }

      const targetKey = `${refCode}.json`;

      if (dryRun) {
        console.log(`${progress} WOULD COPY ${obj.key} -> ${targetKey}`);
      } else {
        console.log(`${progress} Copying ${obj.key} -> ${targetKey}`);
        putObject(TARGET_BUCKET, targetKey, JSON.stringify(manifestJson));
      }
      copied++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${progress} FAILED ${obj.key} -- ${msg}`);
      failed++;
    }
  }

  // Step 3: Summary
  console.log(
    `\nDone: ${copied} copied, ${failed} failed, ${skipped} skipped`
  );
  if (dryRun) {
    console.log("(dry run -- no objects were actually copied)");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
