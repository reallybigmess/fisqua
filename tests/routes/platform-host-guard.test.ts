/**
 * Tests — platform host guard
 *
 * This suite pins the platform-host hard-404 invariant: the middleware
 * must hard-404 every path on a `kind="platform"` tenant host whose
 * pathname is not in the operator-route allowlist. The allowlist opens specific operator paths
 * (operator routes are explicit allow-ins).
 *
 * The 404 must be a bare `Response(null, {status: 404})` so it is
 * externally indistinguishable from the resolver's unknown-host
 * 404. This is the structural mitigation that prevents the
 * `platform` slug from being enumerable.
 *
 * Coverage:
 *   - platform.fisqua.test/dashboard 404s for an authenticated
 *     platform user
 *   - platform.fisqua.test/login 404s under the empty allowlist
 *   - neogranadina.fisqua.test/dashboard does NOT 404 (control)
 *
 * @version v0.4.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import {
  applyMigrations,
  cleanDatabase,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { authMiddleware } from "../../app/middleware/auth.server";
import { createSessionStorage } from "../../app/sessions.server";
import { PLATFORM_TENANT_ID } from "../../app/lib/tenant";

const TEST_SECRET = "test-session-secret";

async function makeSessionCookie(userId: string): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(TEST_SECRET);
  const session = await getSession();
  session.set("userId", userId);
  return commitSession(session);
}

function buildContext(): any {
  const ctx = new RouterContextProvider();
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function buildAuthenticatedRequest(
  userId: string,
  url: string,
): Promise<Request> {
  const cookie = await makeSessionCookie(userId);
  return new Request(url, { headers: { Cookie: cookie } });
}

describe("platform host guard", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("platform.fisqua.test/dashboard 404s for an authenticated platform user", async () => {
    const user = await createTestUser({
      tenantId: PLATFORM_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://platform.fisqua.test/dashboard",
    );
    const ctx = buildContext();

    try {
      await authMiddleware(
        { request, context: ctx } as any,
        async () => undefined,
      );
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
      // Bare body — no enumeration leak.
      expect(await (e as Response).clone().text()).toBe("");
    }
  });

  it("platform.fisqua.test/login 404s under the empty allowlist", async () => {
    const user = await createTestUser({
      tenantId: PLATFORM_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://platform.fisqua.test/login",
    );
    const ctx = buildContext();

    try {
      await authMiddleware(
        { request, context: ctx } as any,
        async () => undefined,
      );
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(404);
    }
  });

  it("neogranadina.fisqua.test/dashboard does NOT 404 (control case)", async () => {
    const user = await createTestUser({
      tenantId: DEFAULT_TEST_TENANT_ID,
      isAdmin: true,
    });
    const request = await buildAuthenticatedRequest(
      user.id,
      "https://neogranadina.fisqua.test/dashboard",
    );
    const ctx = buildContext();

    // Should run to completion without throwing (or, if it throws,
    // the status must not be 404 — only 5xx in case of D1
    // transient errors, which would surface unrelated regressions).
    let thrown: unknown = null;
    try {
      await authMiddleware(
        { request, context: ctx } as any,
        async () => undefined,
      );
    } catch (e) {
      thrown = e;
    }

    if (thrown instanceof Response) {
      expect(thrown.status).not.toBe(404);
    } else {
      expect(thrown).toBeNull();
    }
  });
});
