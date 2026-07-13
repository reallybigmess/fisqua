/**
 * Tests — end-impersonation route
 *
 * This suite pins POST `/end-impersonation` at `app/routes/end-impersonation.tsx`.
 * The route is the structural counterpart to `/handoff/impersonation`:
 * the handoff route MINTED the impersonating session; this route
 * CLEARS it. The userId on the session is preserved (the operator is
 * still signed in on this tenant subdomain — they just dropped out of
 * the impersonation envelope), only the `impersonating` field is
 * unset. After commit the response 302s back to the platform host's
 * operator surface (`https://platform.fisqua.test/operator/tenants`).
 *
 * By design, no audit row is written by
 * end-impersonation — the original `login_as` row's
 * impersonation_session_id + the audit-coverage keystone's exemption
 * for this file together capture the timeframe.
 *
 *   1. POST clears impersonating from a session that has it; userId
 *      preserved; 302 to platform.fisqua.test/operator/tenants.
 *   2. POST is a no-op for a non-impersonating session; userId
 *      preserved; still 302s back to platform.
 *   3. POST without a session cookie → 302 to /login.
 *
 * @version v0.5.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  applyMigrations,
  cleanDatabase,
  seedTenants,
  seedOperatorUser,
  OPERATOR_TEST_USER_ID,
  DEFAULT_TEST_TENANT_ID,
} from "../helpers/db";
import { createSessionStorage } from "../../app/sessions.server";

function makeActionArgs(url: string, cookieHeader: string | null) {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (cookieHeader) headers.set("Cookie", cookieHeader);
  const request = new Request(url, {
    method: "POST",
    headers,
    body: "",
  });
  return {
    request,
    context: {
      cloudflare: {
        env: {
          DB: env.DB,
          SESSION_SECRET: "test-session-secret",
        },
      },
    },
    params: {},
  };
}

async function runAction(
  args: ReturnType<typeof makeActionArgs>,
): Promise<Response> {
  const { action } = await import(
    "../../app/routes/end-impersonation"
  );
  try {
    const result = await action(args as any);
    if (result instanceof Response) return result;
    throw new Error("action returned non-Response");
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

async function buildSessionCookie(
  payload: { userId: string; impersonating?: any },
): Promise<string> {
  const { getSession, commitSession } = createSessionStorage(
    "test-session-secret",
  );
  const session = await getSession();
  session.set("userId", payload.userId);
  if (payload.impersonating) {
    session.set("impersonating", payload.impersonating);
  }
  return commitSession(session);
}

function extractSessionCookie(setCookieHeaders: string[]): string | undefined {
  return setCookieHeaders.find((c) => c.startsWith("__session="));
}

describe("/end-impersonation — POST action", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedTenants();
    await seedOperatorUser();
  });

  it("clears impersonating from a session that has it; preserves userId; 302 to platform", async () => {
    const cookie = await buildSessionCookie({
      userId: OPERATOR_TEST_USER_ID,
      impersonating: {
        role: "isCataloguer",
        sessionId: "test-handoff-id",
        lastActivityAt: Date.now(),
      },
    });
    // The Cookie header expects `name=value`; commitSession returns the
    // full Set-Cookie value, so strip everything past the first `;`.
    const cookieHeader = cookie.split(";")[0];

    const r = await runAction(
      makeActionArgs(
        "https://neogranadina.fisqua.test/end-impersonation",
        cookieHeader,
      ),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(
      "https://platform.fisqua.test/operator/tenants",
    );

    // Read the Set-Cookie back; impersonating should be gone, userId preserved.
    const setCookies: string[] = [];
    r.headers.forEach((v, k) => {
      if (k.toLowerCase() === "set-cookie") setCookies.push(v);
    });
    const newSessionCookie = extractSessionCookie(setCookies);
    expect(newSessionCookie).toBeDefined();

    const { getSession } = createSessionStorage("test-session-secret");
    const reread = await getSession(newSessionCookie!);
    expect(reread.get("userId")).toBe(OPERATOR_TEST_USER_ID);
    expect(reread.get("impersonating")).toBeUndefined();
  });

  it("no-op for non-impersonating session: userId preserved; still 302 to platform", async () => {
    const cookie = await buildSessionCookie({
      userId: OPERATOR_TEST_USER_ID,
    });
    const cookieHeader = cookie.split(";")[0];

    const r = await runAction(
      makeActionArgs(
        "https://neogranadina.fisqua.test/end-impersonation",
        cookieHeader,
      ),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(
      "https://platform.fisqua.test/operator/tenants",
    );
  });

  it("no session cookie → 302 to /login", async () => {
    const r = await runAction(
      makeActionArgs(
        "https://neogranadina.fisqua.test/end-impersonation",
        null,
      ),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/login");
  });
});
