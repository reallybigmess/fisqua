/**
 * Sidebar Navigation
 *
 * This component is the primary left-hand navigation for the authenticated
 * app. Renders the active project section, the cataloguing / description
 * / admin link groups, and the footer with the signed-in user pill. Item
 * visibility is computed from the caller's role flags via
 * `getSidebarSections`, which keeps sidebar composition testable and free
 * of inline role checks. Supports both a desktop collapsed state and a
 * mobile drawer.
 *
 * `getSidebarSections(user, tenant)` takes a second argument carrying
 * the request tenant's five capability booleans
 * (`crowdsourcingEnabled`, `vocabularyHubEnabled`,
 * `publishPipelineEnabled`, `multiRepositoryEnabled`,
 * `authoritiesEnabled`). When a
 * capability is off, the corresponding nav surface is omitted
 * entirely — no greyed-out, no "coming soon", no tooltip — matching
 * the platform's immutable-capability posture. The gate map is:
 *
 *   - `crowdsourcingEnabled` → entire `Collaborative Cataloguing`
 *     section (My projects, All projects, Manage users, Promote)
 *   - `vocabularyHubEnabled` → `/admin/vocabularies`
 *   - `publishPipelineEnabled` → `/admin/publish` and
 *     `/admin/cataloguing/promote`
 *   - `multiRepositoryEnabled` → `/admin/repositories`
 *   - `authoritiesEnabled` → the entire `Authorities` section
 *     (`/admin/entities` and `/admin/places`), its own grouped
 *     section as of the 2026-07-10 module-section ruling
 *
 * For Neogranadina (all five capabilities ON) the rendered tree is
 * byte-identical to v0.3 — the gating is invisible to existing
 * users. The `<Sidebar>` component grew a matching `tenant` prop
 * which the `_auth` layout populates from `tenantContext`.
 *
 * @version v0.4.2
 */

import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  FolderOpen,
  Folders,
  FileText,
  Users,
  MapPin,
  Building2,
  UserCog,
  Upload,
  ArrowUpFromLine,
  BookOpen,
  GitCompare,
  Kanban,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  path: string;
  icon: LucideIcon;
  labelKey: string;
  end?: boolean;
  /** Right-aligned madder pill count (duplicate candidates). */
  badge?: number;
}

export interface NavSection {
  labelKey?: string;
  items: NavItem[];
}

export interface SidebarUser {
  isAdmin: boolean;
  isSuperAdmin: boolean;
  isCollabAdmin: boolean;
  isArchiveUser: boolean;
  isUserManager: boolean;
  isCataloguer: boolean;
  hasAnyProjectMembership: boolean;
}

/**
 * Capability-flag surface the sidebar reads. Structurally compatible
 * with the full `Tenant` row from `app/context.ts` — the layout
 * loader can pass the tenant straight through — but narrow enough
 * that unit tests don't need to seed every column of a `tenants`
 * row to exercise the gating logic.
 */
export interface SidebarTenant {
  crowdsourcingEnabled: boolean;
  vocabularyHubEnabled: boolean;
  publishPipelineEnabled: boolean;
  multiRepositoryEnabled: boolean;
  authoritiesEnabled: boolean;
}

/**
 * Pure function that returns the sidebar sections visible to a given
 * user on a given tenant. Single source of truth for sidebar
 * visibility, fully unit-testable. Capability gates per the map in
 * the file header — sections / items disappear entirely when the
 * matching tenant capability is off.
 */
export function getSidebarSections(
  user: SidebarUser,
  tenant: SidebarTenant,
  counts?: { duplicates?: number },
): NavSection[] {
  const sections: NavSection[] = [
    {
      items: [
        { path: "/", icon: LayoutDashboard, labelKey: "sidebar:home", end: true },
      ],
    },
  ];

  // Collaborative cataloguing — visible if member OR any collab/admin
  // flag, AND the tenant has crowdsourcing enabled. When
  // `crowdsourcingEnabled` is false the entire section (including
  // /proyectos) is omitted; dormant role flags on the user
  // (`isCataloguer`, `isCollabAdmin` set from before crowdsourcing
  // was disabled) become no-ops because the section that would
  // surface them is gone and the route-level capability gate 404s
  // any direct hit.
  if (
    tenant.crowdsourcingEnabled &&
    (user.hasAnyProjectMembership ||
      user.isCollabAdmin ||
      user.isSuperAdmin ||
      user.isAdmin ||
      user.isCataloguer)
  ) {
    const collabItems: NavItem[] = [
      { path: "/proyectos", icon: FolderOpen, labelKey: "sidebar:my_projects" },
    ];
    if (user.isCollabAdmin || user.isSuperAdmin) {
      collabItems.push(
        {
          path: "/admin/cataloguing/projects",
          icon: Folders,
          labelKey: "sidebar:all_projects",
        },
        {
          path: "/admin/cataloguing/team",
          icon: UserCog,
          labelKey: "sidebar:manage_users",
        },
      );
    }
    // Promote sits under the cataloguing section but is gated on
    // BOTH the cataloguing capability (crowdsourcing) and the
    // publish pipeline — promotion is the bridge between the two.
    // The outer crowdsourcing branch already passed; check publish
    // here for the per-item gate.
    if (user.isSuperAdmin && tenant.publishPipelineEnabled) {
      collabItems.push(
        {
          path: "/admin/cataloguing/promote",
          icon: ArrowUpFromLine,
          labelKey: "sidebar:promote",
        },
      );
    }
    sections.push({
      labelKey: "sidebar:collaborative_cataloguing",
      items: collabItems,
    });
  }

  // Records management — archive admin side. Per-item gating for
  // the capability-bound entries (repositories, vocabularies,
  // publish); descriptions is always available when the user has the
  // role. Entities and places moved to their own Authorities section
  // (ruled 2026-07-10) — each module gets its own sidebar section.
  if (user.isAdmin || user.isSuperAdmin) {
    const items: NavItem[] = [
      { path: "/admin/descriptions", icon: FileText, labelKey: "sidebar:descriptions" },
    ];
    if (tenant.multiRepositoryEnabled) {
      items.push({
        path: "/admin/repositories",
        icon: Building2,
        labelKey: "sidebar:repositories",
      });
    }
    if (tenant.vocabularyHubEnabled) {
      items.push({
        path: "/admin/vocabularies",
        icon: BookOpen,
        labelKey: "sidebar:vocabularies",
      });
    }
    if (user.isSuperAdmin && tenant.publishPipelineEnabled) {
      items.push({
        path: "/admin/publish",
        icon: Upload,
        labelKey: "sidebar:publish",
      });
    }
    sections.push({ labelKey: "sidebar:records_management", items });

    // Authorities — the module's own section, gated on the
    // authorities capability. When off the whole section is omitted
    // (the phase-2 route gate 404s any direct hit). The Possible
    // duplicates entry carries the candidate-count badge computed by
    // the layout loader.
    if (tenant.authoritiesEnabled) {
      sections.push({
        labelKey: "sidebar:authorities",
        items: [
          { path: "/admin/entities", icon: Users, labelKey: "sidebar:entities" },
          { path: "/admin/places", icon: MapPin, labelKey: "sidebar:places" },
          {
            path: "/admin/entities/duplicates",
            icon: GitCompare,
            labelKey: "sidebar:possible_duplicates",
            badge: counts?.duplicates,
          },
        ],
      });
    }
  }

  return sections;
}

const BOTTOM_ITEMS: NavItem[] = [
  { path: "/configuracion", icon: Settings, labelKey: "sidebar:my_settings" },
];

interface SidebarProps {
  user: SidebarUser;
  tenant: SidebarTenant;
  collapsed: boolean;
  onToggle: () => void;
  /** Possible-duplicates badge count from the layout loader. */
  duplicateCount?: number;
}

export function Sidebar({
  user,
  tenant,
  collapsed,
  onToggle,
  duplicateCount,
}: SidebarProps) {
  const { t } = useTranslation("sidebar");

  const sections = getSidebarSections(user, tenant, {
    duplicates: duplicateCount,
  });

  return (
    <nav
      aria-label="Main navigation"
      className={`flex flex-col border-r border-stone-200 bg-stone-50 transition-all duration-300 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex flex-1 flex-col gap-1 py-4">
        {sections.map((section, si) => (
          <div key={section.labelKey ?? si}>
            {si > 0 && <div className="mx-4 my-2 border-t border-stone-200" />}
            {section.labelKey && !collapsed && (
              <p className="mx-6 mb-1 font-sans text-11 font-semibold uppercase tracking-[0.1em] text-stone-400">
                {t(section.labelKey.replace("sidebar:", ""))}
              </p>
            )}
            {section.items.map((item) => (
              <SidebarNavItem
                key={item.path}
                item={item}
                collapsed={collapsed}
                t={t}
              />
            ))}
          </div>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom divider + items */}
        <div className="mx-4 my-2 border-t border-stone-200" />
        {BOTTOM_ITEMS.map((item) => (
          <SidebarNavItem
            key={item.path}
            item={item}
            collapsed={collapsed}
            t={t}
          />
        ))}
        {(user.isSuperAdmin || user.isUserManager) && (
          <SidebarNavItem
            item={{ path: "/admin/users", icon: Users, labelKey: "sidebar:system_users" }}
            collapsed={collapsed}
            t={t}
          />
        )}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("expand") : t("collapse")}
        className="flex justify-center border-t border-stone-200 py-3 text-stone-500 hover:text-indigo"
      >
        {collapsed ? (
          <ChevronRight className="h-5 w-5" />
        ) : (
          <ChevronLeft className="h-5 w-5" />
        )}
      </button>
    </nav>
  );
}

function SidebarNavItem({
  item,
  collapsed,
  t,
}: {
  item: NavItem;
  collapsed: boolean;
  t: (key: string) => string;
}) {
  const Icon = item.icon;

  return (
    <NavLink
      to={item.path}
      end={item.end}
      className={({ isActive }) =>
        `relative mx-2 flex items-center gap-3 rounded-md px-4 py-2.5 ${
          collapsed ? "justify-center" : ""
        } ${
          isActive
            ? "bg-white font-semibold text-indigo before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-indigo"
            : "font-sans text-stone-700 hover:bg-white/50"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            className={`h-5 w-5 flex-shrink-0 ${
              isActive ? "text-indigo" : "text-stone-500"
            }`}
          />
          {!collapsed && (
            <span className="flex-1 font-sans text-sm">
              {t(item.labelKey.replace("sidebar:", ""))}
            </span>
          )}
          {!collapsed && item.badge != null && item.badge > 0 && (
            <span className="rounded-full bg-madder-tint px-2 py-0.5 font-sans text-11 nums font-semibold text-madder-deep">
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}
