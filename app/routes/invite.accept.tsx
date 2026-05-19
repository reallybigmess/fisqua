/**
 * Invite Acceptance
 *
 * This route is the landing URL for the project-invite emails sent
 * by the lead's "Invite by email" form. Loader-only — no component
 * is ever rendered; the route exists purely to consume the token and
 * 302 the user into the project. The loader pulls `?token=` from the
 * URL, hands it to `acceptInvite` which validates it against the
 * `invites` table, marks it consumed, creates the
 * `project_members` row, and returns the user id plus the target
 * project id. The loader then mints a session cookie and 302s to
 * the project root.
 *
 * Invalid, expired, or already-consumed tokens fall through to
 * `/login?error=invalid-invite` so the invitee sees the tenant
 * sign-in surface with an error banner rather than a blank 4xx.
 *
 * @version v0.3.0
 */

import { redirect } from "react-router";
import type { Route } from "./+types/invite.accept";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { acceptInvite } = await import("../lib/invites.server");

  const env = context.cloudflare.env;
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) {
    throw redirect("/login?error=invalid-invite");
  }

  const db = drizzle(env.DB);
  const result = await acceptInvite(db, token);

  if (!result.success) {
    throw redirect("/login?error=invalid-invite");
  }

  // Create session for the user
  const { getSession, commitSession } = createSessionStorage(
    env.SESSION_SECRET
  );
  const session = await getSession();
  session.set("userId", result.userId);

  throw redirect(`/projects/${result.projectId}`, {
    headers: {
      "Set-Cookie": await commitSession(session),
    },
  });
}
