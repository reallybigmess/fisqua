/**
 * Lead Dashboard
 *
 * This component is the project-lead landing surface — a cross-project
 * overview that opens with an attention strip and falls back to a roster
 * of project cards. The attention strip carries five kinds of items
 * (volumes waiting on review for more than three days, inactive team
 * members, unassigned volumes, description reviews waiting too long, and
 * re-segmentation requests from reviewers), all rendered as deep links
 * so the lead can jump straight to the surface that needs a hand. Below
 * the strip, each project card stacks a segmentation progress bar and a
 * description progress bar — the same components the assignments page
 * uses, so the visual language stays continuous — and lists the team
 * with avatar initials and role badges. The component is purely a view;
 * all loaders run on the parent route, which keeps this file safe to
 * mount under SSR without round-tripping the database.
 *
 * @version v0.4.2
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { StackedProgressBar } from "./progress-bar";
import { DescriptionProgressBar } from "./description-progress-bar";
import { relativeTime } from "~/lib/format";

export type AttentionItem = {
  type: "waiting" | "inactive" | "unassigned" | "description-review" | "resegmentation";
  link: string;
  // waiting, description-review
  volumeName?: string;
  entryTitle?: string;
  days?: number;
  // inactive
  memberName?: string | null;
  // unassigned
  count?: number;
  projectName?: string;
};

export type TeamMember = {
  id: string;
  name: string | null;
  role: string;
  lastActiveAt: number | null;
  volumeCount: number;
  entryCount?: number;
};

export type ProjectOverview = {
  id: string;
  name: string;
  statusCounts: Record<string, number>;
  descriptionStatusCounts?: Record<string, number>;
  totalVolumes: number;
  totalEntries?: number;
  teamMembers: TeamMember[];
};

type LeadDashboardProps = {
  projects: ProjectOverview[];
  attentionItems: AttentionItem[];
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  lead: "bg-saffron-tint text-saffron-deep",
  cataloguer: "bg-indigo-tint text-indigo",
  reviewer: "bg-verdigris-tint text-verdigris",
};

/** Get initials from a name (up to 2 letters) */
function getInitials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/** Attention item background styles by type */
function getAttentionStyles(type: AttentionItem["type"]): { border: string; bg: string; text: string } {
  if (type === "resegmentation") {
    return { border: "border-saffron", bg: "bg-saffron-tint", text: "text-saffron-deep" };
  }
  if (type === "description-review") {
    return { border: "border-saffron", bg: "bg-saffron-tint", text: "text-saffron-deep" };
  }
  // Default pink for waiting, inactive, unassigned
  return { border: "border-madder", bg: "bg-indigo-tint", text: "text-indigo" };
}

function AttentionSection({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation("dashboard");

  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-madder-deep">
        {t("group.needs_attention")}
        <span className="ml-2 text-xs font-normal">({items.length})</span>
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item, i) => {
          const styles = getAttentionStyles(item.type);
          return (
            <Link
              key={i}
              to={item.link}
              className={`block rounded-lg border ${styles.border} ${styles.bg} p-4 hover:shadow-sm`}
            >
              <div className="flex items-start gap-2">
                <AttentionIcon type={item.type} />
                <p className={`text-sm ${styles.text}`}>
                  <AttentionItemDescription item={item} />
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function AttentionIcon({ type }: { type: AttentionItem["type"] }) {
  if (type === "resegmentation") {
    return (
      <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-saffron-deep" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  if (type === "description-review") {
    return (
      <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-saffron-deep" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  return null;
}

function AttentionItemDescription({ item }: { item: AttentionItem }) {
  const { t } = useTranslation(["dashboard", "common"]);

  if (item.type === "waiting") {
    const daysText = item.days === 0
      ? t("dashboard:today")
      : t("dashboard:days_waiting", { count: item.days });
    return <>{`"${item.volumeName}" \u2014 ${daysText}`}</>;
  }

  if (item.type === "unassigned") {
    const volumeText = t("common:domain.volume_count_full", { count: item.count });
    const daysText = t("dashboard:days_waiting", { count: item.days });
    return <>{t("dashboard:attention.unassigned_volumes", { volumes: volumeText, project: item.projectName })}</>;
  }

  if (item.type === "inactive") {
    const name = item.memberName ?? t("dashboard:unnamed");
    const daysText = t("dashboard:days_waiting", { count: item.days });
    return <>{t("dashboard:attention.inactive_member", { name, days: daysText })}</>;
  }

  if (item.type === "description-review") {
    const daysText = item.days === 0
      ? t("dashboard:today")
      : t("dashboard:days_waiting", { count: item.days });
    return <>{`"${item.entryTitle ?? item.volumeName}" \u2014 ${daysText}`}</>;
  }

  if (item.type === "resegmentation") {
    return <>{t("dashboard:attention.reseg_flag", { volume: item.volumeName })}</>;
  }

  return null;
}

function ProjectCard({ project }: { project: ProjectOverview }) {
  const { t } = useTranslation(["dashboard", "common", "workflow", "description"]);
  const hasDescription = project.descriptionStatusCounts &&
    Object.values(project.descriptionStatusCounts).some((n) => n > 0);

  return (
    <div className="rounded-lg border border-stone-200 p-4">
      <div className="flex items-center justify-between">
        <Link
          to={`/projects/${project.id}`}
          className="font-medium text-stone-900 hover:underline"
        >
          {project.name}
        </Link>
        <span className="text-xs text-stone-400">
          {t("common:domain.volume_count", { count: project.totalVolumes })}
        </span>
      </div>

      {/* Segmentation progress bar */}
      <div className="mt-3">
        <StackedProgressBar counts={project.statusCounts} />
      </div>

      {/* Description progress bar */}
      <div className="mt-3">
        {hasDescription ? (
          <DescriptionProgressBar counts={project.descriptionStatusCounts!} />
        ) : (
          <div className="rounded bg-stone-100 px-3 py-2 text-xs text-stone-400">
            {t("description:promote.descripcion_no_iniciada")}
          </div>
        )}
      </div>

      {project.teamMembers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-stone-500">{t("dashboard:group.team")}</h3>
          <div className="mt-2 divide-y divide-stone-100">
            {project.teamMembers.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between py-1.5"
              >
                <div className="flex items-center gap-2">
                  {/* Avatar initials */}
                  <div className="flex h-[1.125rem] w-[1.125rem] items-center justify-center rounded-full bg-stone-100 text-10 font-medium text-stone-500">
                    {getInitials(member.name)}
                  </div>
                  <Link
                    to={`/users/${member.id}/activity`}
                    className="text-sm text-stone-700 hover:underline"
                  >
                    {member.name || t("dashboard:unnamed")}
                  </Link>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      ROLE_BADGE_STYLES[member.role] ?? "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {t(`workflow:role.${member.role}`)}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-stone-400">
                  <span>
                    {hasDescription && member.entryCount != null
                      ? `${member.entryCount} ${t("dashboard:item_abbr")}`
                      : `${member.volumeCount} ${t("dashboard:vol_abbr")}`}
                  </span>
                  <span>{relativeTime(member.lastActiveAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function LeadDashboard({
  projects,
  attentionItems,
}: LeadDashboardProps) {
  const { t } = useTranslation("dashboard");

  if (projects.length === 0) {
    return (
      <div className="mt-12 flex justify-center">
        <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
            <svg className="h-7 w-7 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 className="mt-4 font-serif text-lg font-semibold text-indigo">{t("empty.no_projects_title")}</h3>
          <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
            {t("empty.no_lead_projects_body")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AttentionSection items={attentionItems} />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
          {t("group.projects")}
          <span className="ml-2 text-xs font-normal">({projects.length})</span>
        </h2>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      </section>
    </div>
  );
}
