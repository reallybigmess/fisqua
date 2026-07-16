/**
 * Tenant /login route
 *
 * This route is the per-tenant sign-in surface. Two affordances:
 *
 *   1. "Sign in with GitHub" — primary position. The button points at
 *      the apex init route (`https://fisqua.org/auth/github`) with
 *      `?return_to=<slug>`; the apex completes OAuth at the one
 *      callback URL the GitHub OAuth App is registered with and 302s
 *      back to this tenant via a single-use handoff token. The tenant
 *      slug is read from the loader's `getTenantFromRequest` resolution.
 *
 *   2. Magic-link form — secondary position. Submits an email; the
 *      action generates a magic link with `new URL(request.url).origin`
 *      so the verify URL stays on the tenant subdomain (host-aware by
 *      construction).
 *
 * @version v0.4.2
 */
import { redirect, data } from "react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CircleCheck, CircleX, Github, Mail } from "lucide-react";
import type { Route } from "./+types/login";
import {
  assertNonPlatformOrAllowlisted,
  getTenantFromRequest,
} from "../lib/tenant";

const emailSchema = z.object({
  email: z.string().email(),
});

export function meta() {
  return [{ title: "Iniciar sesión | Fisqua" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { createSessionStorage } = await import("../sessions.server");
  const { drizzle } = await import("drizzle-orm/d1");

  const env = context.cloudflare.env;
  const { getSession } = createSessionStorage(env.SESSION_SECRET);
  const session = await getSession(request.headers.get("Cookie"));

  if (session.get("userId")) {
    throw redirect("/");
  }

  // Resolve the tenant from the request host so the "Sign in with
  // GitHub" button can carry `?return_to=<slug>` to the apex. The
  // apex init route is the single entry point for OAuth across every
  // tenant; the tenant-side button on /login is just a convenience
  // link.
  //
  // Defensive: if tenant resolution throws (unknown host, multi-level
  // subdomain), bubble the 404 — it's the same behaviour every other
  // tenant route gets, and a /login that 404s on a non-existent host
  // is correct.
  const db = drizzle(env.DB);
  const tenant = await getTenantFromRequest(db, request);
  // Seal platform host. /login is not in OPERATOR_ROUTE_ALLOWLIST,
  // so platform.fisqua.org/login hard-404s here — externally
  // identical to an unknown slug's /login.
  assertNonPlatformOrAllowlisted(tenant, new URL(request.url).pathname);

  return {
    tenantSlug: tenant.slug,
    // Surface the workspace name as a subtitle under the Fisqua
    // mark/title so users know which tenant they're about to sign
    // into. Only exposed for tenant kind; platform host returns null
    // so the operator-login screen doesn't leak the platform tenant's
    // display name.
    tenantName: tenant.kind === "tenant" ? tenant.name : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { createSessionStorage } = await import("../sessions.server");
  const { generateMagicLink } = await import("../lib/auth.server");
  const { getInstance } = await import("~/middleware/i18next");

  const env = context.cloudflare.env;
  const i18n = getInstance(context);
  const formData = await request.formData();

  const parsed = emailSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return data(
      { error: i18n.t("auth:error.invalid_email"), success: false },
      { status: 400 }
    );
  }

  const db = drizzle(env.DB);
  const origin = new URL(request.url).origin;
  const result = await generateMagicLink(
    db,
    parsed.data.email,
    origin,
    env.RESEND_API_KEY,
    env
  );

  if (result.error) {
    return data({ error: result.error, success: false }, { status: 400 });
  }

  return data({ success: true, error: null });
}

export default function LoginPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("auth");
  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const urlError = searchParams.get("error");

  const errorMessages: Record<string, string> = {
    "expired-link": t("error.expired_link"),
    "invalid-link": t("error.invalid_link"),
    "oauth-failed": t("error.oauth_failed"),
    "no-email": t("error.no_email"),
    "no-account": t("error.no_account"),
  };

  // The GitHub button targets the apex init route with
  // ?return_to=<slug>. The apex completes OAuth at the one URL the
  // GitHub OAuth App is registered with, then 302s back to this
  // tenant subdomain via the single-use handoff token.
  const tenantSlug = loaderData?.tenantSlug ?? "";
  const githubHref = tenantSlug
    ? `https://fisqua.org/auth/github?return_to=${encodeURIComponent(tenantSlug)}`
    : "/auth/github";

  return (
    <div className="flex min-h-screen items-center justify-center bg-white">
      <div className="mx-auto w-full max-w-md space-y-6 px-4">
        <div className="text-center">
          <img
            src="/brand/fisqua-mark.svg"
            alt="Fisqua"
            className="mx-auto h-24 w-24"
          />
          <h1 className="mt-4 font-display text-5xl font-semibold text-indigo">
            Fisqua
          </h1>
          {loaderData?.tenantName && (
            <p className="mt-1 font-sans text-sm text-stone-500">
              {loaderData.tenantName}
            </p>
          )}
        </div>

        {urlError && errorMessages[urlError] && (
          <div className="flex items-start gap-3 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
            <CircleX
              className="mt-0.5 h-5 w-5 shrink-0 text-indigo"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span>{errorMessages[urlError]}</span>
          </div>
        )}

        {actionData?.success ? (
          <div className="flex items-start gap-3 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 text-sm text-stone-700">
            <CircleCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-verdigris"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <span>{t("success_message")}</span>
          </div>
        ) : (
          <div className="space-y-6">
            {/*
              GitHub login button — primary position. The link targets
              the apex init route with the tenant slug as
              ?return_to=<slug>. GitHub OAuth Apps allow exactly one
              Authorization callback URL, so the apex completes the
              flow on behalf of every tenant.
            */}
            <a
              href={githubHref}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#24292f] font-sans text-15 font-semibold text-white hover:bg-[#1b1f23] focus:outline-none focus:ring-2 focus:ring-[#24292f] focus:ring-offset-2"
            >
              <Github className="h-5 w-5" />
              {t("github_login_button")}
            </a>

            {/* Divider */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-stone-300" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-white px-2 text-stone-500">{t("or_divider")}</span>
              </div>
            </div>

            {/* Magic link form -- secondary position */}
            <form method="post" className="space-y-4">
              {actionData?.error && (
                <div className="flex items-start gap-3 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
                  <CircleX
                    className="mt-0.5 h-5 w-5 shrink-0 text-indigo"
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <span>{actionData.error}</span>
                </div>
              )}

              <div>
                <label
                  htmlFor="email"
                  className="block font-sans text-sm font-medium text-indigo"
                >
                  {t("email_label")}
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="mt-1 block h-12 w-full rounded-lg border border-stone-300 px-3 text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                  placeholder={t("placeholder")}
                />
              </div>

              <button
                type="submit"
                className="flex h-12 w-full items-center justify-center gap-2 rounded-md bg-indigo font-sans text-15 font-semibold text-parchment hover:bg-indigo-deep focus:outline-none focus:ring-2 focus:ring-indigo focus:ring-offset-2"
              >
                <Mail className="h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
                {t("login_button")}
              </button>
            </form>
          </div>
        )}

        <p className="text-center font-sans text-xs text-stone-400">
          {t("footer_note")}
        </p>
      </div>
    </div>
  );
}

// @version v0.4.2
