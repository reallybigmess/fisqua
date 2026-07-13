/**
 * Wrong-workspace interstitial
 *
 * This route is the public top-level interstitial (no auth
 * middleware) rendered on a tenant subdomain when an authenticated
 * request comes in for a user whose `tenantId` doesn't match the
 * host's tenant. The three callers — `auth.verify.tsx` (magic-link),
 * `auth.github.handoff.tsx`
 * (OAuth), and `authMiddleware` (defence-in-depth) — 302 here with
 * `?home=<home-slug>`. This route reads the slug, validates it,
 * resolves both tenant rows, and renders the sketch-001 Variant A
 * interstitial with a CTA linking to the home subdomain's `/login`.
 *
 * Identity-blind by design: never reads the `__session` cookie, never
 * mints one. Renders the fallback copy (generic CTA, no specific
 * workspace name) on any of:
 *   - `?home` missing or fails `SlugSchema`
 *   - `findTenantBySlug(home)` returns null
 *   - the matching row is soft-disabled (`disabledAt !== null`)
 *   - `home` equals the current tenant's slug (someone hit the URL on
 *     the right subdomain)
 *
 * The route sits OUTSIDE the `_auth.tsx` layout in `app/routes.ts`, so
 * `authMiddleware` does not run on it. This is intentional: the user
 * arriving here has either (a) never minted a wrong-subdomain session
 * (verify / handoff paths) or (b) just had theirs cleared on the way
 * out (middleware path). The page does not need auth to render.
 *
 * Visual: sketch 001 Variant A.
 *
 * @version v0.4.2
 */

import { useTranslation } from "react-i18next";
import { CircleAlert, ArrowRight } from "lucide-react";
import type { Route } from "./+types/wrong-workspace";
import {
  SlugSchema,
  buildTenantOriginUrl,
  findTenantBySlug,
  getTenantFromRequest,
} from "../lib/tenant";

export function meta({ data }: Route.MetaArgs) {
  // Static title — i18next is component-side; meta runs on the server
  // without an i18n context. Match the EN page_title literal.
  return [{ title: "Wrong workspace | Fisqua" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Resolve the request's tenant. Throws a bare 404 Response on
  // unknown host / multi-level subdomain / disabled tenant — bubbles
  // up unchanged. A soft-disabled tenant 404s here (matches
  // `getTenantFromRequest`'s disabled-tenant carve-out, which only
  // excepts /operator/*).
  const tenant = await getTenantFromRequest(db, request);

  const url = new URL(request.url);
  const homeRaw = url.searchParams.get("home") ?? "";
  const parsed = SlugSchema.safeParse(homeRaw);

  let homeTenant: { slug: string; name: string } | null = null;
  if (parsed.success) {
    const candidate = await findTenantBySlug(db, parsed.data);
    if (
      candidate &&
      candidate.disabledAt === null &&
      candidate.id !== tenant.id
    ) {
      homeTenant = { slug: candidate.slug, name: candidate.name };
    }
  }

  const origin = homeTenant
    ? buildTenantOriginUrl(new URL(request.url), homeTenant.slug)
    : null;
  const ctaUrl = origin !== null ? `${origin}/login` : null;

  return {
    wrongTenant: { slug: tenant.slug, name: tenant.name },
    homeTenant,
    ctaUrl,
  };
}

export default function WrongWorkspacePage({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("auth");
  const { wrongTenant, homeTenant, ctaUrl } = loaderData;
  const hasHome = homeTenant !== null && ctaUrl !== null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-parchment px-4 py-8">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border-t-4 border-saffron bg-white shadow-lg">
        <div className="px-10 pb-8 pt-10 text-center">
          {/* Fisqua mark */}
          <img
            src="/brand/fisqua-mark.svg"
            alt="Fisqua"
            className="mx-auto mb-5 h-16 w-16"
          />

          {/* Saffron-tint icon circle with CircleAlert */}
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-saffron-tint">
            <CircleAlert
              className="h-7 w-7 text-saffron-deep"
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </div>

          {/* Eyebrow */}
          <p className="mb-2 font-sans text-xs font-semibold uppercase tracking-[0.1em] text-saffron-deep">
            {t("wrong_workspace.eyebrow")}
          </p>

          {/* Display title */}
          <h1 className="mb-4 font-display text-5xl font-semibold leading-[1.15] tracking-[-0.01em] text-indigo">
            {t("wrong_workspace.title")}
          </h1>

          {/* Body */}
          <p className="mb-2 font-serif text-base leading-[1.6] text-indigo-soft">
            {t(hasHome ? "wrong_workspace.body" : "wrong_workspace.body_fallback")}
          </p>

          {/* Tenant comparison (only when we know the home tenant) */}
          {hasHome && (
            <div
              className="my-6 flex items-center justify-center gap-2.5 font-mono text-sm text-indigo"
              aria-label="Workspace comparison"
            >
              <span className="text-stone-500 line-through decoration-stone-400">
                {wrongTenant.slug}.fisqua.org
              </span>
              <ArrowRight
                className="h-4 w-4 shrink-0 text-stone-400"
                strokeWidth={2}
                aria-hidden="true"
              />
              <span className="rounded bg-verdigris-tint px-2 py-1 font-semibold text-verdigris-deep">
                {homeTenant!.slug}.fisqua.org
              </span>
            </div>
          )}

          {/* Primary CTA */}
          {hasHome ? (
            <a
              href={ctaUrl!}
              className="mt-2 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-indigo px-5 font-sans text-15 font-semibold text-parchment hover:bg-indigo-deep focus:outline-none focus:ring-2 focus:ring-indigo focus:ring-offset-2"
            >
              <span>{t("wrong_workspace.cta", { name: homeTenant!.name })}</span>
              <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </a>
          ) : (
            <a
              href="/login"
              className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-indigo px-5 font-sans text-15 font-semibold text-parchment hover:bg-indigo-deep focus:outline-none focus:ring-2 focus:ring-indigo focus:ring-offset-2"
            >
              <span>{t("wrong_workspace.cta_fallback")}</span>
            </a>
          )}

          {/* Sign-out divider + link */}
          <div className="mt-6 border-t border-stone-200 pt-6">
            <form method="post" action="/auth/logout" className="inline">
              <button
                type="submit"
                className="font-sans text-13 text-stone-500 underline decoration-stone-400 underline-offset-[3px] hover:text-stone-700"
              >
                {t("wrong_workspace.sign_out_link")}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// @version v0.4.2
