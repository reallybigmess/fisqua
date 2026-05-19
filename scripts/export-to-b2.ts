#!/usr/bin/env npx tsx
/**
 * Dual-Write Transition — R2 to B2
 *
 * This script is a bridge for the transition period between the legacy
 * Django backend (which writes its export to Backblaze B2) and Fisqua
 * (which writes its export to Cloudflare R2). While both systems co-exist,
 * the public frontend continues to build from B2, so every Fisqua
 * export has to be mirrored to B2 until the frontend is cut over.
 *
 * The script expects the caller to have already pulled the export
 * files locally via `wrangler r2 object get` (so authentication with
 * R2 stays in the operator's existing wrangler session), then uploads
 * every file under the local directory to the B2 bucket using the
 * S3-compatible API. Once the frontend is repointed at R2 this script
 * can be removed.
 *
 * Environment variables `B2_KEY_ID`, `B2_APP_KEY`, and `B2_ENDPOINT`
 * authenticate against the B2 S3 endpoint.
 *
 * @version v0.3.1
 *
 * Original docblock kept below for CLI usage examples:
 *
 * During the transition from zasqua-backend (Django) to Fisqua
 * (Cloudflare Workers), both systems export to their own storage. This
 * script bridges the gap by uploading Fisqua's R2 export files to B2
 * so the existing frontend build pipeline continues to work.
 *
 * Usage:
 *   # First, download from R2 to a local directory:
 *   mkdir -p .export/children
 *   npx wrangler r2 object get zasqua-export/descriptions-index.json --file .export/descriptions-index.json
 *   npx wrangler r2 object get zasqua-export/repositories.json --file .export/repositories.json
 *   npx wrangler r2 object get zasqua-export/entities.json --file .export/entities.json
 *   npx wrangler r2 object get zasqua-export/places.json --file .export/places.json
 *   # Download per-fonds description files listed in descriptions-index.json
 *   # Download children/*.json files
 *
 *   # Then upload to B2:
 *   B2_KEY_ID=xxx B2_APP_KEY=yyy B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
 *     npx tsx scripts/export-to-b2.ts .export/
 *
 * Environment variables:
 *   B2_KEY_ID    — Backblaze B2 application key ID
 *   B2_APP_KEY   — Backblaze B2 application key
 *   B2_ENDPOINT  — Backblaze B2 S3-compatible endpoint
 */
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const BUCKET = "zasqua-export";

interface DescriptionsIndex {
  version: number;
  generated_at: string;
  total_record_count: number;
  fonds: Array<{
    fonds_code: string;
    key: string;
    record_count: number;
  }>;
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return val;
}

function contentType(filename: string): string {
  return filename.endsWith(".json") ? "application/json" : "application/octet-stream";
}

async function uploadFile(
  client: S3Client,
  localPath: string,
  key: string
): Promise<void> {
  const body = readFileSync(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType(key),
    })
  );
  const sizeKB = (body.length / 1024).toFixed(1);
  console.log(`  Uploaded ${key} (${sizeKB} KB)`);
}

async function main(): Promise<void> {
  const exportDir = process.argv[2];
  if (!exportDir) {
    console.error("Usage: npx tsx scripts/export-to-b2.ts <export-dir>");
    console.error("Example: npx tsx scripts/export-to-b2.ts .export/");
    process.exit(1);
  }

  if (!existsSync(exportDir)) {
    console.error(`Export directory not found: ${exportDir}`);
    process.exit(1);
  }

  const keyId = requireEnv("B2_KEY_ID");
  const appKey = requireEnv("B2_APP_KEY");
  const endpoint = requireEnv("B2_ENDPOINT");

  const client = new S3Client({
    endpoint,
    region: "us-west-004",
    credentials: {
      accessKeyId: keyId,
      secretAccessKey: appKey,
    },
  });

  console.log(`Uploading export files from ${exportDir} to B2 bucket ${BUCKET}\n`);

  // Step 1: Concatenate per-fonds description files into combined descriptions.json
  const indexPath = join(exportDir, "descriptions-index.json");
  if (!existsSync(indexPath)) {
    console.error(`descriptions-index.json not found in ${exportDir}`);
    process.exit(1);
  }

  const index: DescriptionsIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
  console.log(`Found ${index.fonds.length} fonds in descriptions-index.json`);

  const allDescriptions: unknown[] = [];
  for (const entry of index.fonds) {
    const fondsPath = join(exportDir, entry.key);
    if (!existsSync(fondsPath)) {
      console.warn(`  WARNING: ${entry.key} not found, skipping`);
      continue;
    }
    const fondsData = JSON.parse(readFileSync(fondsPath, "utf-8"));
    if (Array.isArray(fondsData)) {
      allDescriptions.push(...fondsData);
      console.log(`  Read ${fondsData.length} descriptions from ${entry.key}`);
    }
  }

  console.log(`\nCombined ${allDescriptions.length} descriptions total`);

  // Upload combined descriptions.json (the format B2/frontend expects)
  const combinedBody = Buffer.from(JSON.stringify(allDescriptions));
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: "descriptions.json",
      Body: combinedBody,
      ContentType: "application/json",
    })
  );
  const combinedSizeKB = (combinedBody.length / 1024).toFixed(1);
  console.log(`  Uploaded descriptions.json (${combinedSizeKB} KB)\n`);

  // Step 2: Upload other top-level files
  const topLevelFiles = [
    "repositories.json",
    "entities.json",
    "places.json",
  ];

  for (const filename of topLevelFiles) {
    const filePath = join(exportDir, filename);
    if (existsSync(filePath)) {
      await uploadFile(client, filePath, filename);
    } else {
      console.log(`  Skipped ${filename} (not found)`);
    }
  }

  // Step 3: Upload children/*.json
  const childrenDir = join(exportDir, "children");
  if (existsSync(childrenDir)) {
    const childFiles = readdirSync(childrenDir).filter((f) =>
      f.endsWith(".json")
    );
    console.log(`\nUploading ${childFiles.length} children files...`);
    for (const file of childFiles) {
      await uploadFile(client, join(childrenDir, file), `children/${file}`);
    }
  } else {
    console.log("\n  No children/ directory found, skipping");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
