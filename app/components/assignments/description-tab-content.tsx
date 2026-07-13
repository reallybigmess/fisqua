/**
 * Description Tab Content
 *
 * This component is the contents of the Description tab on the
 * assignments page. It stacks four reading surfaces for the project lead
 * — volumes ready to be promoted into description ("Listos para
 * descripción"), volumes currently in description with their per-status
 * progress bars, a global description-progress bar for the project, and
 * the team-progress cards keyed to description assignments. All data is
 * read-only here; commit affordances live on the inner tables and cards.
 *
 * @version v0.4.2
 */

import { Link, useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { DESCRIPTION_STATUS_STYLES } from "../../lib/description-workflow";
import type { MemberOption } from "./assignment-table";

type PromotableVolume = {
  id: string;
  name: string;
  referenceCode: string | null;
  approvedEntryCount: number;
};

type DescriptionVolume = {
  id: string;
  name: string;
  referenceCode: string | null;
  entryCount: number;
  progress: Record<string, number>;
  hasOpenFlags: boolean;
};

type DescriptionMemberStats = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  assignedCount: number;
  completedCount: number;
};

type DescriptionTabContentProps = {
  promotableVolumes: PromotableVolume[];
  descriptionVolumes: DescriptionVolume[];
  globalProgress: Record<string, number>;
  descriptionMembers: DescriptionMemberStats[];
  projectId: string;
};

const DESC_STATUS_ORDER = [
  "unassigned",
  "assigned",
  "in_progress",
  "described",
  "reviewed",
  "approved",
  "sent_back",
];

/** Segment colours for description progress bars (darker, for bar fills) */
const DESC_SEGMENT_COLORS: Record<string, string> = {
  unassigned: "bg-stone-500",
  assigned: "bg-indigo",
  in_progress: "bg-saffron-deep",
  described: "bg-sage-deep",
  reviewed: "bg-verdigris",
  approved: "bg-verdigris",
  sent_back: "bg-indigo",
};

export function DescriptionTabContent({
  promotableVolumes,
  descriptionVolumes,
  globalProgress,
  descriptionMembers,
  projectId,
}: DescriptionTabContentProps) {
  const { t } = useTranslation("description");

  return (
    <div className="space-y-8">
      {/* Promotable volumes */}
      {promotableVolumes.length > 0 && (
        <section>
          <h3 className="mb-4 text-sm font-semibold text-stone-700">
            {t("promote.listos_para_descripcion")}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {promotableVolumes.map((vol) => (
              <PromoteCard key={vol.id} volume={vol} />
            ))}
          </div>
        </section>
      )}

      {/* Global description progress */}
      {descriptionVolumes.length > 0 && (
        <section>
          <DescriptionProgressBar
            counts={globalProgress}
            className="mb-6"
          />
        </section>
      )}

      {/* Volumes in description */}
      {descriptionVolumes.length > 0 && (
        <section>
          <h3 className="mb-4 text-sm font-semibold text-stone-700">
            {t("promote.volumenes_en_descripcion")}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-xs font-medium uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2">{t("promote.columna_volumen")}</th>
                  <th className="px-3 py-2 text-right">{t("promote.columna_entradas")}</th>
                  <th className="min-w-[200px] px-3 py-2">{t("promote.columna_progreso")}</th>
                  <th className="px-3 py-2">{t("promote.columna_alertas")}</th>
                  <th className="px-3 py-2">{t("promote.columna_acciones")}</th>
                </tr>
              </thead>
              <tbody>
                {descriptionVolumes.map((vol) => (
                  <tr
                    key={vol.id}
                    className="border-b border-stone-100 hover:bg-stone-50"
                  >
                    <td className="px-3 py-2">
                      <Link
                        to={`/projects/${projectId}/assignments/description/${vol.id}`}
                        className="font-medium text-stone-900 hover:underline"
                      >
                        {vol.name}
                      </Link>
                      {vol.referenceCode && (
                        <span className="ml-2 font-mono text-xs text-stone-400">
                          {vol.referenceCode}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-stone-500">
                      {vol.entryCount}
                    </td>
                    <td className="px-3 py-2">
                      <DescriptionProgressBar
                        counts={vol.progress}
                        compact
                      />
                    </td>
                    <td className="px-3 py-2">
                      {vol.hasOpenFlags && (
                        <AlertTriangle className="h-4 w-4 text-saffron" />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to={`/projects/${projectId}/assignments/description/${vol.id}`}
                        className="text-sm font-medium text-stone-500 hover:text-stone-700 hover:underline"
                      >
                        {t("promote.asignar")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Team description progress */}
      {descriptionMembers.length > 0 && (
        <section>
          <h3 className="mb-4 text-sm font-semibold text-stone-700">
            {t("assignment.progreso_equipo")}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {descriptionMembers.map((member) => (
              <div
                key={member.id}
                className="rounded-lg border border-stone-200 bg-white p-4"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-stone-900">
                    {member.name ?? member.email}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
                    {member.role}
                  </span>
                </div>
                <div className="mb-3">
                  <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
                    {member.assignedCount > 0 && (
                      <div
                        className="h-full bg-verdigris transition-all"
                        style={{
                          width: `${(member.completedCount / member.assignedCount) * 100}%`,
                        }}
                        title={`${member.completedCount} / ${member.assignedCount}`}
                      />
                    )}
                    {member.assignedCount > 0 && member.assignedCount - member.completedCount > 0 && (
                      <div
                        className="h-full bg-stone-500 transition-all"
                        style={{
                          width: `${((member.assignedCount - member.completedCount) / member.assignedCount) * 100}%`,
                        }}
                      />
                    )}
                  </div>
                </div>
                <p className="text-xs text-stone-500">
                  {member.completedCount} / {member.assignedCount} {t("assignment.entradas")}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Empty state */}
      {promotableVolumes.length === 0 && descriptionVolumes.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-sm text-stone-400">
            {t("promote.descripcion_no_iniciada")}
          </p>
        </div>
      )}
    </div>
  );
}

function PromoteCard({ volume }: { volume: PromotableVolume }) {
  const { t } = useTranslation("description");
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <h4 className="text-base font-semibold text-stone-800">
        {volume.name}
      </h4>
      {volume.referenceCode && (
        <p className="mt-0.5 font-mono text-xs text-stone-400">
          {volume.referenceCode}
        </p>
      )}
      <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
        {t("promote.entradas_aprobadas", { count: volume.approvedEntryCount })}
      </p>
      <fetcher.Form method="post" className="mt-3">
        <input type="hidden" name="_action" value="promote" />
        <input type="hidden" name="volumeId" value={volume.id} />
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-indigo px-4 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep disabled:opacity-50"
        >
          {isSubmitting
            ? "..."
            : t("promote.pasar_a_descripcion")}
        </button>
      </fetcher.Form>
    </div>
  );
}

function DescriptionProgressBar({
  counts,
  compact = false,
  className = "",
}: {
  counts: Record<string, number>;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("description");
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  if (total === 0) {
    return <div className={`h-1.5 w-full rounded-full bg-stone-100 ${className}`} />;
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <div className={`flex w-full overflow-hidden rounded-full bg-stone-100 ${compact ? "h-2" : "h-3"}`}>
        {DESC_STATUS_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          if (count === 0) return null;
          const pct = (count / total) * 100;
          return (
            <div
              key={status}
              className={`${DESC_SEGMENT_COLORS[status] ?? "bg-stone-300"} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${t(`status.${status}`)}: ${count}`}
            />
          );
        })}
      </div>

      {!compact && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
          {DESC_STATUS_ORDER.map((status) => {
            const count = counts[status] ?? 0;
            if (count === 0) return null;
            return (
              <span key={status} className="flex items-center gap-1">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${DESC_SEGMENT_COLORS[status] ?? "bg-stone-300"}`}
                />
                {t(`status.${status}`)} ({count})
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
