/**
 * Logout Action
 *
 * This action is the sign-out endpoint posted by the sidebar's
 * logout button. POST-only — a GET would let an attacker log a user
 * out via an image tag or a cross-origin link. The handler reads the
 * existing session, calls `destroySession` to mint the cookie-clearing
 * `Set-Cookie` header, and throws a 302 to `/login` so the browser
 * lands on the tenant's sign-in surface unauthenticated.
 *
 * The session secret comes from the Worker env so the same handler
 * works across local, staging, and production without configuration
 * drift.
 *
 * @version v0.3.0
 */

import { redirect } from "react-router";
import type { Route } from "./+types/auth.logout";

export async function action({ request, context }: Route.ActionArgs) {
  const { createSessionStorage } = await import("../sessions.server");

  const env = context.cloudflare.env;
  const { getSession, destroySession } = createSessionStorage(
    env.SESSION_SECRET
  );
  const session = await getSession(request.headers.get("Cookie"));

  throw redirect("/login", {
    headers: {
      "Set-Cookie": await destroySession(session),
    },
  });
}
