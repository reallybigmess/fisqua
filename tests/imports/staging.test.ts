/**
 * Tests — import staging store (R2 backing + B2 signed-request shape)
 *
 * The R2 backing runs against a faithful in-memory `R2Bucket` mock (the
 * repo's established pattern — the real miniflare R2 binding cannot be
 * written under the Workers pool because of an isolated-storage teardown
 * bug; see the phase report). It exercises round-trip put/getBytes/head/
 * exists/delete and asserts the `imports-staging/` prefix structurally.
 * The B2 backing runs against an injected fetch that captures the signed
 * request — host, path, method, and the SigV4 Authorization header —
 * with NO network call. Backend selection is asserted to be explicit
 * (default r2, never credential-driven).
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import {
  R2StagingStore,
  B2StagingStore,
  getStagingStore,
  stagingKey,
  resolveB2Region,
  StagingConfigError,
} from "../../app/lib/import/staging.server";

const enc = new TextEncoder();
const dec = new TextDecoder();

// A faithful in-memory R2Bucket covering the surface R2StagingStore uses.
function mockBucket(): { bucket: R2Bucket; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const toBytes = (body: unknown): Uint8Array => {
    if (typeof body === "string") return enc.encode(body);
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    return enc.encode(String(body));
  };
  const bucket = {
    async put(key: string, body: unknown) {
      store.set(key, toBytes(body));
      return {} as unknown;
    },
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          );
        },
      };
    },
    async head(key: string) {
      const bytes = store.get(key);
      return bytes ? { size: bytes.byteLength } : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as R2Bucket;
  return { bucket, store };
}

describe("stagingKey tenant-first scheme", () => {
  it("scopes every artefact family by tenant", () => {
    expect(stagingKey.upload("t1", "u1")).toBe("t1/uploads/u1.csv");
    expect(stagingKey.reject("t1", "u1")).toBe("t1/rejects/u1.csv");
    expect(stagingKey.report("t1", "u1")).toBe("t1/reports/u1.json");
  });
});

describe("R2StagingStore", () => {
  it("round-trips bytes and applies the imports-staging prefix", async () => {
    const { bucket, store } = mockBucket();
    const s = new R2StagingStore(bucket);
    const key = stagingKey.upload("tenant-a", "up-1");

    await s.put(key, enc.encode("a,b\n1,2\n"), { contentType: "text/csv" });
    const bytes = await s.getBytes(key);
    expect(bytes).not.toBeNull();
    expect(dec.decode(bytes!)).toBe("a,b\n1,2\n");

    // The stored key carries the prefix; the bare key is not present.
    expect(store.has("imports-staging/" + key)).toBe(true);
    expect(store.has(key)).toBe(false);
  });

  it("heads, exists, and deletes", async () => {
    const { bucket } = mockBucket();
    const s = new R2StagingStore(bucket);
    const key = stagingKey.upload("tenant-a", "up-2");

    await s.put(key, enc.encode("hello"));
    expect(await s.head(key)).toEqual({ size: 5 });
    expect(await s.exists(key)).toBe(true);
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
    expect(await s.getBytes(key)).toBeNull();
    expect(await s.head(key)).toBeNull();
  });
});

describe("B2StagingStore with an injected fetch", () => {
  const config = {
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    bucket: "fisqua-imports-staging",
    keyId: "004test",
    secretKey: "secret-abc",
  };

  it("signs a PUT with the right host, path, method, and SigV4 header", async () => {
    let captured: Request | null = null;
    const fetchImpl = (async (input: Request) => {
      captured = input;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const s = new B2StagingStore(config, fetchImpl);
    await s.put("tenant-a/uploads/up-1.csv", enc.encode("x"), {
      contentType: "text/csv",
    });

    expect(captured).not.toBeNull();
    const req = captured as unknown as Request;
    expect(req.method).toBe("PUT");
    const url = new URL(req.url);
    expect(url.host).toBe("s3.us-west-004.backblazeb2.com");
    expect(url.pathname).toBe(
      "/fisqua-imports-staging/tenant-a/uploads/up-1.csv",
    );
    // aws4fetch signs with SigV4, and Backblaze validates the region in
    // the credential scope — assert the REAL region derived from the
    // endpoint host, not a placeholder.
    const auth = req.headers.get("authorization");
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(auth).toMatch(/\/us-west-004\/s3\/aws4_request/);
    expect(req.headers.get("x-amz-content-sha256")).toBeTruthy();
  });

  it("returns null bytes on a 404 GET without throwing", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    const s = new B2StagingStore(config, fetchImpl);
    expect(await s.getBytes("tenant-a/uploads/missing.csv")).toBeNull();
  });

  it("throws StagingRequestError on a failed PUT", async () => {
    const fetchImpl = (async () =>
      new Response("no", { status: 500 })) as unknown as typeof fetch;
    const s = new B2StagingStore(config, fetchImpl);
    await expect(s.put("k", enc.encode("x"))).rejects.toThrow(/B2 PUT/);
  });
});

describe("resolveB2Region", () => {
  it("derives the region from a Backblaze S3 endpoint host", () => {
    expect(
      resolveB2Region({ endpoint: "https://s3.us-west-004.backblazeb2.com" }),
    ).toBe("us-west-004");
    expect(
      resolveB2Region({ endpoint: "https://s3.eu-central-003.backblazeb2.com" }),
    ).toBe("eu-central-003");
  });

  it("prefers an explicit region override", () => {
    expect(
      resolveB2Region({
        endpoint: "https://s3.us-west-004.backblazeb2.com",
        region: "eu-central-003",
      }),
    ).toBe("eu-central-003");
  });

  it("throws a named StagingConfigError when no region can be derived", () => {
    expect(() =>
      resolveB2Region({ endpoint: "https://storage.example.com" }),
    ).toThrow(StagingConfigError);
    expect(() => resolveB2Region({ endpoint: "not a url" })).toThrow(
      StagingConfigError,
    );
  });
});

describe("getStagingStore backend selection", () => {
  it("defaults to R2 when the backend selector is unset", () => {
    const s = getStagingStore({ ...env, IMPORTS_STAGING_BACKEND: undefined } as any);
    expect(s).toBeInstanceOf(R2StagingStore);
  });

  it("never selects B2 from credential presence alone", () => {
    const s = getStagingStore({
      ...env,
      IMPORTS_STAGING_BACKEND: undefined,
      IMPORTS_STAGING_S3_ENDPOINT: "https://example.com",
      IMPORTS_STAGING_BUCKET: "b",
      IMPORTS_STAGING_KEY_ID: "k",
      IMPORTS_STAGING_SECRET_KEY: "s",
    } as any);
    expect(s).toBeInstanceOf(R2StagingStore);
  });

  it("builds B2 when explicitly selected with full credentials", () => {
    const s = getStagingStore({
      ...env,
      IMPORTS_STAGING_BACKEND: "b2",
      IMPORTS_STAGING_S3_ENDPOINT: "https://s3.us-west-004.backblazeb2.com",
      IMPORTS_STAGING_BUCKET: "b",
      IMPORTS_STAGING_KEY_ID: "k",
      IMPORTS_STAGING_SECRET_KEY: "s",
    } as any);
    expect(s).toBeInstanceOf(B2StagingStore);
  });

  it("throws when B2 is selected without complete credentials", () => {
    expect(() =>
      getStagingStore({
        ...env,
        IMPORTS_STAGING_BACKEND: "b2",
        IMPORTS_STAGING_S3_ENDPOINT: "",
      } as any),
    ).toThrow(StagingConfigError);
  });
});
