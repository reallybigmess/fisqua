/**
 * Operator Surface Shell
 *
 * This layout is the top-level shell for the `/operator/*` route
 * family. It reuses the staff `_auth` design tokens (Spectral /
 * Fisqua wordmark, stone-* palette,
 * indigo accents) but ships a thin top-bar nav with no sidebar — the
 * v0.4 operator surface is for ~1–2 named operators and the lighter
 * chrome fits the audience.
 *
 * Structurally the operator layout is a SIBLING of `_auth`, not a
 * child. Two reasons:
 *
 *   1. Different gate. `_auth` runs `authMiddleware` which calls
 *      `requireTenantUser` (default-deny on tenant mismatch) — that
 *      logic is wrong for the platform host where every request is
 *      from the operator user living in the platform tenant. The
 *      `_operator` layout runs `operatorAuthMiddleware` which calls
 *      `assertOperator(tenant)` instead.
 *
 *   2. Different chrome. `_auth` renders the full staff sidebar (project
 *      nav, admin nav, capability-gated entries). The operator surface
 *      has no projects, no descriptions, no entities — it manages
 *      tenants and that's it. A nested layout would have to fight the
 *      staff sidebar's role-flag and capability gates; a sibling
 *      layout simply doesn't render them.
 *
 * Three nav slots:
 *   - **Tenants** — link to `/operator/tenants`, the cross-tenant list.
 *   - **Logout** — POST form to `/auth/logout`, the existing handler.
 *   - **End impersonation** — only renders when `impersonationContext`
 *     carries a non-null state. On the platform host that is never
 *     true (operators don't impersonate INTO the platform tenant), so
 *     the slot is structurally absent here — the conditional render
 *     is for shape parity with `_auth`'s layout, in case a future
 *     migration wants to surface impersonation status in operator
 *     chrome.
 *
 * @version v0.4.0
 */

import { Form, Outlet, NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import {
  impersonationContext,
  tenantContext,
  userContext,
} from "../context";
import type { Route } from "./+types/_operator";

export const middleware = [
  async (args: any, next: any) => {
    const { operatorAuthMiddleware } = await import(
      "../middleware/operator-auth.server"
    );
    return operatorAuthMiddleware(args, next);
  },
];

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  const impersonating = context.get(impersonationContext);
  // Surface a narrow payload — the layout never reads roles, only
  // identifying info for the top bar. Capability flags are not
  // relevant on the platform tenant (always all-off per the seed).
  return {
    user: { email: user.email, name: user.name },
    tenant: { name: tenant.name },
    impersonating,
  };
}

export default function OperatorLayout({
  loaderData,
}: Route.ComponentProps) {
  const { t } = useTranslation("operator");
  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* Top bar — Spectral wordmark + verdigris accent, mirroring
          `_auth.tsx` header tokens. Operator surface keeps the same
          visual identity. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-stone-200 bg-stone-50 px-4">
        <div className="flex items-center">
          <img
            src="/brand/fisqua-mark.svg"
            alt=""
            className="h-7 w-7"
            aria-hidden="true"
          />
          <span className="ml-2 font-display text-[22px] font-semibold leading-none text-verdigris">
            {t("brand")}
          </span>
          <div
            className="mx-3 h-5 w-px bg-stone-200"
            aria-hidden="true"
          />
          <span className="font-sans text-sm text-stone-500">
            {loaderData.tenant.name}
          </span>
        </div>
        <nav className="flex items-center gap-4">
          <NavLink
            to="/operator/tenants"
            className={({ isActive }) =>
              isActive
                ? "font-sans text-sm font-medium text-verdigris"
                : "font-sans text-sm text-stone-600 hover:text-verdigris"
            }
          >
            {t("nav.tenants")}
          </NavLink>
          {loaderData.impersonating !== null ? (
            <Form method="post" action="/end-impersonation">
              <button
                type="submit"
                className="font-sans text-sm font-medium text-rust hover:underline"
              >
                {t("nav.end_impersonation")}
              </button>
            </Form>
          ) : null}
          <span className="font-sans text-sm text-stone-500">
            {loaderData.user.email}
          </span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="font-sans text-sm font-medium text-indigo hover:underline"
            >
              {t("nav.logout")}
            </button>
          </Form>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

// @version v0.4.0
