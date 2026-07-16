/**
 * Backfill — deterministic identifiers and era constants
 *
 * This module deals with the stable-identity primitives the provenance
 * backfill (authorities spec §10) leans on so that re-running `generate`
 * produces byte-identical SQL and re-applying it is a true no-op.
 *
 * `uuidv5` is an RFC 4122 v5 (SHA-1, namespaced) implementation with no
 * third-party dependency — the row builder derives every
 * `authority_operations.id` from a namespaced key string
 * (`resolve:<pipelineEntityId>`, `merge:<pass>:<absorbed>:<head>`, …), so
 * the same decision always hashes to the same PK. Combined with
 * `INSERT OR IGNORE` in the generator, that makes the whole backfill
 * idempotent: a partially-applied run can be re-applied and only the
 * missing rows land.
 *
 * The era constants are deliberately NOT the run date. `audit_log.json`
 * and every per-pass audit file were measured to carry NO timestamp of
 * any kind (no `date`/`time`/`pass` field on any of the 91,187
 * decisions), so a pipeline pass date is unrecoverable — see the module
 * header of `rows.ts`. `PHASE_13_CREATED_AT_MS` is therefore the single
 * documented constant §10 permits: 2026-04-16T00:00:00Z, the earliest
 * `entities.created_at` observed in the Phase-13 production import
 * (measured range 2026-04-16 … 2026-04-22). Every backfilled row carries
 * it, distinguishing these rows from live steward operations (whose
 * `created_at` is the wall clock at the write site) as clearly as the
 * `detail.origin` marker does.
 *
 * @version v0.4.2
 */

import { createHash } from "node:crypto";

/**
 * Fixed namespace UUID for the provenance backfill. Any valid UUID works
 * as a v5 namespace; this literal is frozen so identifiers stay stable
 * across regenerations. Changing it would remint every PK and break
 * idempotent re-application — do not change it.
 */
export const BACKFILL_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341";

/**
 * The single documented Phase-13-era timestamp (epoch ms) stamped on
 * every backfilled row. 2026-04-16T00:00:00Z — the earliest
 * `entities.created_at` in the production import. NEVER the backfill run
 * date. `authority_operations.created_at` is epoch ms (spec §3), unlike
 * `entities.created_at` which is epoch seconds.
 */
export const PHASE_13_CREATED_AT_MS = Date.UTC(2026, 3, 16, 0, 0, 0, 0);

/** Email that resolves the acting user at apply time (0056 pattern). */
export const BACKFILL_USER_EMAIL = "juan@neogranadina.org";

/** `detail.origin` marker separating backfilled rows from live ops. */
export const BACKFILL_ORIGIN = "pipeline-backfill";

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`Not a UUID: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

/** Format 16 bytes as a canonical lowercase UUID string. */
function bytesToUuid(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
    `${h.slice(16, 20)}-${h.slice(20, 32)}`
  );
}

/**
 * RFC 4122 v5 UUID: SHA-1 over (namespace bytes ‖ name), with the version
 * and variant bits stamped. Deterministic for a given (namespace, name).
 */
export function uuidv5(name: string, namespace: string = BACKFILL_NAMESPACE): string {
  const ns = uuidToBytes(namespace);
  const digest = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

// Version: v0.4.2
