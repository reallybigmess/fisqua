/**
 * Import staging store — one interface, R2 and B2 backings
 *
 * This module deals with the object store that holds an import's staged
 * artefacts: the uploaded CSV, its rejects file, and its dry-run report
 * (spec §7.4). One `StagingStore` interface has two backings:
 *
 *   - R2 over the existing `env.BUCKET` binding, every key under an
 *     `imports-staging/` prefix. This is the dev and test backing —
 *     miniflare provides a real in-memory R2 for it.
 *   - B2 over its S3-compatible API, signed with `aws4fetch`'s
 *     `AwsClient`. This is the production backing.
 *
 * Backend selection is EXPLICIT: `env.IMPORTS_STAGING_BACKEND` is `"r2"`
 * (the default when unset) or `"b2"`. Selection never keys off whether
 * credentials are present — local `.dev.vars` carries real B2
 * credentials that dev must not touch, so presence-based selection would
 * silently write dev artefacts into the production bucket.
 *
 * Keys are tenant-first (`{tenantId}/uploads/{uploadId}.csv`) so
 * per-tenant scoping is structural, not a runtime filter that a bug
 * could drop. The R2 backing prepends `imports-staging/`; the B2 backing
 * uses a dedicated bucket and needs no shared-namespace prefix.
 *
 * @version v0.6.0
 */

import { AwsClient } from "aws4fetch";

export type StagingBody = ArrayBuffer | Uint8Array | string;

/** The three artefact families a run stores, tenant-scoped by key. */
export const stagingKey = {
  upload: (tenantId: string, uploadId: string): string =>
    `${tenantId}/uploads/${uploadId}.csv`,
  reject: (tenantId: string, uploadId: string): string =>
    `${tenantId}/rejects/${uploadId}.csv`,
  report: (tenantId: string, uploadId: string): string =>
    `${tenantId}/reports/${uploadId}.json`,
  /**
   * A revert run's report artefact (spec §4). Keyed by RUN id, not upload
   * id: a revert has no upload, and the run-scoped download route reads
   * the key straight off the run's `report_artifact` column.
   */
  revertReport: (tenantId: string, runId: string): string =>
    `${tenantId}/reports/revert-${runId}.json`,
};

export interface StagingStore {
  put(
    key: string,
    body: StagingBody,
    opts?: { contentType?: string },
  ): Promise<void>;
  /** The object's bytes, or null when the key does not exist. */
  getBytes(key: string): Promise<Uint8Array | null>;
  /** Object size in bytes, or null when the key does not exist. */
  head(key: string): Promise<{ size: number } | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** Raised when the B2 backing is selected without complete credentials. */
export class StagingConfigError extends Error {
  readonly code = "staging_config" as const;
  constructor(message: string) {
    super(message);
    this.name = "StagingConfigError";
  }
}

/** Raised when a B2 request comes back with a non-2xx status. */
export class StagingRequestError extends Error {
  readonly code = "staging_request" as const;
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StagingRequestError";
    this.status = status;
  }
}

function asBodyInit(body: StagingBody): ArrayBuffer | string {
  // A Uint8Array is copied to a standalone ArrayBuffer so both backings
  // (R2 put and fetch) see a byte body rather than a view; the type is
  // narrowed to what R2 and fetch share.
  if (body instanceof Uint8Array) {
    return body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as ArrayBuffer;
  }
  if (body instanceof ArrayBuffer) return body;
  return body;
}

/**
 * R2 backing over a shared bucket. Every key lives under
 * `imports-staging/` so import artefacts never collide with the app's
 * other R2 tenants (uploads, manifests, METS).
 */
export class R2StagingStore implements StagingStore {
  private readonly prefix: string;
  constructor(
    private readonly bucket: R2Bucket,
    prefix = "imports-staging/",
  ) {
    this.prefix = prefix;
  }

  private full(key: string): string {
    return this.prefix + key;
  }

  async put(
    key: string,
    body: StagingBody,
    opts?: { contentType?: string },
  ): Promise<void> {
    await this.bucket.put(this.full(key), asBodyInit(body), {
      httpMetadata: opts?.contentType
        ? { contentType: opts.contentType }
        : undefined,
    });
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(this.full(key));
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }

  async head(key: string): Promise<{ size: number } | null> {
    const obj = await this.bucket.head(this.full(key));
    return obj ? { size: obj.size } : null;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bucket.head(this.full(key))) !== null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(this.full(key));
  }
}

export interface B2Config {
  endpoint: string;
  bucket: string;
  keyId: string;
  secretKey: string;
  /** Explicit SigV4 region; when absent it derives from the endpoint host. */
  region?: string;
}

/**
 * The SigV4 credential-scope region for a B2 config. Backblaze encodes
 * the region in the S3 endpoint hostname (`s3.<region>.backblazeb2.com`,
 * e.g. `us-west-004`) and validates it in the credential scope, so a
 * placeholder region fails signing — the region must be real. An
 * explicit `config.region` wins; otherwise the hostname is parsed;
 * neither yielding a region is a configuration error.
 */
export function resolveB2Region(
  config: Pick<B2Config, "endpoint" | "region">,
): string {
  if (config.region && config.region.trim() !== "") return config.region.trim();
  let host: string;
  try {
    host = new URL(config.endpoint).host;
  } catch {
    throw new StagingConfigError(
      `B2 endpoint is not a valid URL: ${config.endpoint}`,
    );
  }
  const match = host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com$/);
  if (!match) {
    throw new StagingConfigError(
      `Cannot derive a SigV4 region from B2 endpoint host "${host}"; set an explicit region`,
    );
  }
  return match[1];
}

/**
 * B2 backing over the S3-compatible API. `AwsClient` signs each request
 * with SigV4; the `fetchImpl` seam lets tests assert the signed request
 * shape without a live network call. The bucket is dedicated, so keys
 * are used verbatim (no shared-namespace prefix).
 */
export class B2StagingStore implements StagingStore {
  private readonly client: AwsClient;
  constructor(
    private readonly config: B2Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new AwsClient({
      accessKeyId: config.keyId,
      secretAccessKey: config.secretKey,
      service: "s3",
      region: resolveB2Region(config),
    });
  }

  private url(key: string): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    return `${base}/${this.config.bucket}/${key}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const signed = await this.client.sign(url, init);
    return this.fetchImpl(signed);
  }

  async put(
    key: string,
    body: StagingBody,
    opts?: { contentType?: string },
  ): Promise<void> {
    const res = await this.send(this.url(key), {
      method: "PUT",
      body: asBodyInit(body),
      headers: opts?.contentType
        ? { "content-type": opts.contentType }
        : undefined,
    });
    if (!res.ok) {
      throw new StagingRequestError(res.status, `B2 PUT ${key} failed`);
    }
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const res = await this.send(this.url(key), { method: "GET" });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new StagingRequestError(res.status, `B2 GET ${key} failed`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.send(this.url(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new StagingRequestError(res.status, `B2 HEAD ${key} failed`);
    }
    const length = res.headers.get("content-length");
    return { size: length ? Number(length) : 0 };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    const res = await this.send(this.url(key), { method: "DELETE" });
    // S3 DELETE is idempotent — a 404 is not an error.
    if (!res.ok && res.status !== 404) {
      throw new StagingRequestError(res.status, `B2 DELETE ${key} failed`);
    }
  }
}

/**
 * Resolve the staging store for the current environment. Reads the
 * explicit `IMPORTS_STAGING_BACKEND` selector — `"b2"` builds the B2
 * backing (and requires all four credentials); anything else, including
 * unset, builds the R2 backing over `env.BUCKET`. `fetchImpl` is a test
 * seam for the B2 path.
 */
export function getStagingStore(env: Env, fetchImpl?: typeof fetch): StagingStore {
  const backend = env.IMPORTS_STAGING_BACKEND === "b2" ? "b2" : "r2";
  if (backend === "b2") {
    const { IMPORTS_STAGING_S3_ENDPOINT, IMPORTS_STAGING_BUCKET, IMPORTS_STAGING_KEY_ID, IMPORTS_STAGING_SECRET_KEY } = env;
    if (
      !IMPORTS_STAGING_S3_ENDPOINT ||
      !IMPORTS_STAGING_BUCKET ||
      !IMPORTS_STAGING_KEY_ID ||
      !IMPORTS_STAGING_SECRET_KEY
    ) {
      throw new StagingConfigError(
        "IMPORTS_STAGING_BACKEND=b2 requires endpoint, bucket, key id, and secret key",
      );
    }
    return new B2StagingStore(
      {
        endpoint: IMPORTS_STAGING_S3_ENDPOINT,
        bucket: IMPORTS_STAGING_BUCKET,
        keyId: IMPORTS_STAGING_KEY_ID,
        secretKey: IMPORTS_STAGING_SECRET_KEY,
      },
      fetchImpl,
    );
  }
  return new R2StagingStore(env.BUCKET);
}
