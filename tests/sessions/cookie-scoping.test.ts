/**
 * Tests — session cookie scoping
 *
 * This suite pins the cookie-scoping invariant: the session cookie
 * config in `app/sessions.server.ts` MUST omit the `Domain` attribute so
 * cookies set on `<slug-A>.fisqua.org` are structurally not echoed
 * to `<slug-B>.fisqua.org` per RFC 6265 §5.3. This is the
 * structural mechanism that makes cross-subdomain cookie sharing
 * impossible -- the v0.4 multi-tenancy isolation guarantee.
 *
 * If a future PR adds `Domain: ".fisqua.org"` (or any other
 * `Domain` attribute) to the cookie config, this test fails and
 * surfaces the regression at code review time. The browser-side
 * enforcement that follows from the absence of `Domain` is a
 * runtime guarantee in production; the test pool's miniflare HTTP
 * layer does not enforce browser-side cookie scoping rules across
 * synthetic hosts (RESEARCH §"Test infrastructure" caveat), so
 * this is the right place to assert the structural property.
 *
 * @version v0.6.0
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { createSessionStorage } from "../../app/sessions.server";

describe("session cookie scoping (C-02)", () => {
  it("Set-Cookie header has no Domain attribute (host-only)", async () => {
    const { getSession, commitSession } = createSessionStorage(
      "test-session-secret"
    );
    const session = await getSession();
    session.set("userId", "00000000-0000-0000-0000-000000000001");
    const cookieHeader = await commitSession(session);

    // Structural assertion: the Set-Cookie value MUST NOT contain
    // a Domain attribute. RFC 6265 §5.3: cookies without a Domain
    // attribute are scoped host-only to the request host.
    expect(cookieHeader).not.toMatch(/Domain=/i);

    // Defensive sibling assertion: the cookie sets the project
    // standard attributes that document host-only-by-default
    // intent. Path, HttpOnly, SameSite, Secure -- if any of these
    // disappear silently, the cookie surface has changed and the
    // C-02 invariant deserves re-review even if the Domain
    // assertion above still passes.
    expect(cookieHeader).toMatch(/Path=\//);
    expect(cookieHeader).toMatch(/HttpOnly/);
    expect(cookieHeader).toMatch(/SameSite=Lax/i);
  });

  // `Secure` is build-conditioned (`!import.meta.env.DEV`): the vite
  // dev server serves plain http on *.localhost, where browsers that
  // don't treat *.localhost as a trustworthy origin drop a Secure
  // cookie and silently break local login. Both directions are pinned
  // so neither the production guarantee nor the dev carve-out can
  // regress silently.
  describe("Secure attribute follows the build, not the runtime", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("production build (DEV=false) sets Secure", async () => {
      vi.stubEnv("DEV", false);
      const { getSession, commitSession } = createSessionStorage(
        "test-session-secret"
      );
      const session = await getSession();
      session.set("userId", "00000000-0000-0000-0000-000000000001");
      expect(await commitSession(session)).toMatch(/Secure/);
    });

    it("dev build (DEV=true) omits Secure", async () => {
      vi.stubEnv("DEV", true);
      const { getSession, commitSession } = createSessionStorage(
        "test-session-secret"
      );
      const session = await getSession();
      session.set("userId", "00000000-0000-0000-0000-000000000001");
      expect(await commitSession(session)).not.toMatch(/Secure/);
    });
  });
});
