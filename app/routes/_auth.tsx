/**
 * Authenticated App Shell
 *
 * This layout is the parent route for everything behind login. It
 * runs the auth guard, loads the sidebar payload — projects the
 * caller belongs to, plus
 * admin visibility flags — and renders the three-column shell:
 * sidebar, top bar, outlet. The shell manages the sidebar collapse
 * state and the mobile drawer, exposing both through the outlet
 * context so nested pages can react.
 *
 * The loader reads `tenantContext` (populated by `authMiddleware`
 * after resolving the request `Host` header) and surfaces the
 * capability flags to the `<Sidebar>` so capability-off nav surfaces
 * are hidden.
 *
 * @version v0.6.0
 */

import { useState, useEffect } from "react";
import { Form, Outlet, useLocation } from "react-router";
import { useTranslation } from "react-i18next";
import { impersonationContext, tenantContext, userContext } from "../context";
import { Sidebar } from "../components/layout/sidebar";
import { Footer } from "../components/layout/footer";
import { ImpersonationBanner } from "../components/layout/impersonation-banner";
import type { Route } from "./+types/_auth";

export const middleware = [
  async (args: any, next: any) => {
    const { authMiddleware } = await import("../middleware/auth.server");
    return authMiddleware(args, next);
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { getAppConfig } = await import("../lib/config.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { projectMembers } = await import("../db/schema");

  const user = context.get(userContext);
  const tenant = context.get(tenantContext);
  // Read the impersonation envelope so the layout can render the
  // persistent banner. Always populated (the middleware attaches
  // `null` when no envelope is active) per the
  // `impersonationContext` contract in `app/context.ts`.
  const impersonating = context.get(impersonationContext);
  const env = context.cloudflare.env;
  const { appName } = getAppConfig(env);

  // Compute hasAnyProjectMembership so the sidebar can show the
  // Collaborative Cataloguing section to project-member-only users.
  const db = drizzle(env.DB);
  const membershipRows = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))
    .limit(1);
  const hasAnyProjectMembership = membershipRows.length > 0;

  // Surface only the capability flags the sidebar needs;
  // structurally matches `SidebarTenant` so the prop typecheck is a
  // simple shape match rather than a wider Tenant cast. Keeping the
  // payload narrow also avoids accidentally serialising capability
  // flags that future surfaces gate on but the layout itself does
  // not consume.
  const tenantCaps = {
    crowdsourcingEnabled: tenant.crowdsourcingEnabled,
    vocabularyHubEnabled: tenant.vocabularyHubEnabled,
    publishPipelineEnabled: tenant.publishPipelineEnabled,
    multiRepositoryEnabled: tenant.multiRepositoryEnabled,
    authoritiesEnabled: tenant.authoritiesEnabled,
    importsEnabled: tenant.importsEnabled,
  };

  // Possible-duplicates badge for the Authorities sidebar entry —
  // computed only for admins on authorities-on tenants AND only while
  // the current request is inside the authorities section. The count
  // is two GROUP BY scans over lower(display_name) (which no index
  // serves) plus a join over the separate ledger rows; running that on
  // every admin navigation is disproportionate for a badge, so pages
  // outside /admin/entities and /admin/places render the nav entry
  // without a pill. Within the section the pill is always fresh.
  // The count itself is the CHEAP approximation (exact lowercase-name
  // collision pairs minus dismissed pairs), not the worklist's
  // accent-normalised number; see `getDuplicateBadgeCounts`.
  let duplicateCount = 0;
  const pathname = new URL(request.url).pathname;
  const inAuthoritiesSection =
    pathname.startsWith("/admin/entities") ||
    pathname.startsWith("/admin/places");
  if (
    inAuthoritiesSection &&
    tenant.authoritiesEnabled &&
    (user.isAdmin || user.isSuperAdmin)
  ) {
    const { getDuplicateBadgeCounts } = await import(
      "../lib/authority-duplicates.server"
    );
    const counts = await getDuplicateBadgeCounts(db, tenant.federationId);
    duplicateCount = counts.entities + counts.places;
  }

  // Surface a narrow `impersonating` payload for the banner. Empty
  // shape (null) when no envelope is active. We deliberately do NOT
  // expose `sessionId` or `lastActivityAt` to client-side render —
  // role + tenant name are sufficient for the banner copy.
  const impersonatingForBanner = impersonating
    ? { role: impersonating.role, tenantName: tenant.name }
    : null;

  return {
    user,
    appName,
    hasAnyProjectMembership,
    tenant: tenantCaps,
    impersonating: impersonatingForBanner,
    duplicateCount,
  };
}

export default function CatalogacionLayout({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const { t } = useTranslation("common");
  const { t: tDashboard } = useTranslation("dashboard");

  // Detect the focused work surfaces — volume viewer and description
  // editor. Their URL paths are /projects/:projectId/volumes/:volumeId
  // and /projects/:projectId/describe/:entryId; matching by file name
  // substrings ("/viewer/", "/describe/") miss the volume URL because
  // the route file name contains "viewer" but the URL does not.
  const isViewer = /^\/projects\/[^/]+\/volumes\/[^/]+\/?$/.test(
    location.pathname,
  );
  const isDescriptionEditor = /^\/projects\/[^/]+\/describe\/[^/]+\/?$/.test(
    location.pathname,
  );
  // Both render their own full-height layouts, so the chrome's content
  // slot drops its padding and overflow behaviour for them and defaults
  // the sidebar to its narrow rail to maximise working space.
  const isFocusedSurface = isViewer || isDescriptionEditor;

  // Sidebar collapse state — initialise false, read localStorage on mount
  const [collapsed, setCollapsed] = useState(false);
  // Per-visit override for focused surfaces. The narrow rail is the
  // default on viewer/describer, but the toggle still works; resets to
  // `null` (i.e. back to default) when navigating between focused and
  // non-focused routes so the saved preference doesn't get clobbered.
  const [focusedOverride, setFocusedOverride] = useState<boolean | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    setFocusedOverride(null);
  }, [isFocusedSurface]);

  const effectiveCollapsed = isFocusedSurface
    ? (focusedOverride ?? true)
    : collapsed;

  const toggleCollapsed = () => {
    if (isFocusedSurface) {
      setFocusedOverride((prev) => !(prev ?? true));
      return;
    }
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Persistent impersonation banner. Renders above the existing
          chrome on every tenant subdomain page during an operator
          impersonation envelope. Cannot be dismissed; the only exit
          is the End-impersonation button which posts to
          `/end-impersonation`. */}
      {loaderData.impersonating ? (
        <ImpersonationBanner
          role={loaderData.impersonating.role}
          tenantName={loaderData.impersonating.tenantName}
        />
      ) : null}
      {/* Header bar — wordmark in verdigris (Spectral 22px), partner
          name in stone-500 sans. Per design-system §Chrome. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-stone-200 bg-stone-50 px-4">
        <div className="flex items-center">
          <img
            src="/brand/fisqua-mark.svg"
            alt=""
            className="h-7 w-7"
            aria-hidden="true"
          />
          <span className="ml-2 font-display text-2xl font-semibold leading-none text-verdigris">
            Fisqua
          </span>
          <div className="mx-3 h-5 w-px bg-stone-200" aria-hidden="true" />
          <span className="font-sans text-sm text-stone-500">Neogranadina</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-sans text-sm text-stone-500">
            {loaderData.user.email}
          </span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="font-sans text-sm font-medium text-indigo hover:underline"
            >
              {tDashboard("nav.log_out")}
            </button>
          </Form>
        </div>
      </header>

      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        {isFocusedSurface ? (
          // On focused surfaces the sidebar floats above the work area
          // when expanded, so the viewer/describer keeps its column
          // widths instead of reflowing. The fixed-width 64 px slot in
          // the flex row matches the collapsed rail; the absolute layer
          // overlays when the user expands.
          <div className="relative w-16 shrink-0">
            <div className="absolute inset-y-0 left-0 z-30 flex">
              <Sidebar
                user={{
                  isAdmin: loaderData.user.isAdmin,
                  isSuperAdmin: loaderData.user.isSuperAdmin,
                  isCollabAdmin: loaderData.user.isCollabAdmin,
                  isArchiveUser: loaderData.user.isArchiveUser,
                  isUserManager: loaderData.user.isUserManager,
                  isCataloguer: loaderData.user.isCataloguer,
                  hasAnyProjectMembership: loaderData.hasAnyProjectMembership,
                }}
                tenant={loaderData.tenant}
                collapsed={effectiveCollapsed}
                onToggle={toggleCollapsed}
                duplicateCount={loaderData.duplicateCount}
              />
            </div>
          </div>
        ) : (
          <Sidebar
            user={{
              isAdmin: loaderData.user.isAdmin,
              isSuperAdmin: loaderData.user.isSuperAdmin,
              isCollabAdmin: loaderData.user.isCollabAdmin,
              isArchiveUser: loaderData.user.isArchiveUser,
              isUserManager: loaderData.user.isUserManager,
              isCataloguer: loaderData.user.isCataloguer,
              hasAnyProjectMembership: loaderData.hasAnyProjectMembership,
            }}
            tenant={loaderData.tenant}
            collapsed={effectiveCollapsed}
            onToggle={toggleCollapsed}
            duplicateCount={loaderData.duplicateCount}
          />
        )}
        <div
          className={
            isFocusedSurface
              ? "flex min-w-0 flex-1 flex-col"
              : "relative flex flex-1 flex-col"
          }
        >
          <div
            className={
              isFocusedSurface
                ? "min-h-0 flex-1"
                : "flex-1 overflow-y-auto px-6 pb-16 pt-6"
            }
          >
            <Outlet />
          </div>
          {!isFocusedSurface && <Footer />}
        </div>
      </div>
    </div>
  );
}
