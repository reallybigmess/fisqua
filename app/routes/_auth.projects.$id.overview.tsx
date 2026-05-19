/**
 * Project Overview Page
 *
 * This page is the landing surface for one project: headline stats,
 * the list of volumes with their descrption-workflow status, and
 * quick links into the
 * more specialised project surfaces. Read-only — every mutation lives
 * on the dedicated sub-pages.
 *
 * @version v0.3.0
 */

import { useState, useCallback } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import { PipelineColumn } from "../components/pipeline/pipeline-column";
import { AssignDescriberPopover } from "../components/pipeline/assign-describer-popover";
import type { Route } from "./+types/_auth.projects.$id.overview";
import type { PipelineColumn as PipelineColumnType } from "../lib/pipeline/pipeline.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getPipelineData, getTeamMembers } = await import(
    "../lib/pipeline/pipeline.server"
  );

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  await requireProjectRole(
    db,
    user.id,
    params.id,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  const [columns, teamMembers] = await Promise.all([
    getPipelineData(db, params.id),
    getTeamMembers(db, params.id),
  ]);

  return { columns, teamMembers, user, projectId: params.id };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { z } = await import("zod");
  const { assignDescriber } = await import(
    "../lib/pipeline/pipeline.server"
  );

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "assignDescriber") {
    const schema = z.object({
      entryId: z.string().min(1),
      describerId: z.string().min(1),
    });

    const parsed = schema.safeParse({
      entryId: formData.get("entryId"),
      describerId: formData.get("describerId"),
    });

    if (!parsed.success) {
      return { success: false, error: "Invalid input" };
    }

    return assignDescriber(db, parsed.data.entryId, parsed.data.describerId);
  }

  return { success: false, error: "Unknown intent" };
}

const SEGMENTATION_COLUMN_IDS = [
  "unstarted",
  "segmenting",
  "seg_review",
  "ready_to_describe",
];
const DESCRIPTION_COLUMN_IDS = [
  "describing",
  "desc_review",
  "ready_to_promote",
];

type Stage = "segmentation" | "description";

export default function ProjectOverview({
  loaderData,
}: Route.ComponentProps) {
  const { columns, teamMembers, user, projectId } = loaderData;
  const { t } = useTranslation("pipeline");
  const [searchParams, setSearchParams] = useSearchParams();
  const stage: Stage =
    searchParams.get("stage") === "description" ? "description" : "segmentation";

  const [assignPopover, setAssignPopover] = useState<{
    entryId: string;
    projectId: string;
  } | null>(null);

  const handleAssignClick = useCallback(
    (entryId: string, projectId: string) => {
      setAssignPopover({ entryId, projectId });
    },
    []
  );

  const handleAssignClose = useCallback(() => {
    setAssignPopover(null);
  }, []);

  const filterIds =
    stage === "segmentation" ? SEGMENTATION_COLUMN_IDS : DESCRIPTION_COLUMN_IDS;
  const visibleColumns: PipelineColumnType[] = columns.filter((c) =>
    filterIds.includes(c.id)
  );

  const setStage = (s: Stage) => {
    const next = new URLSearchParams(searchParams);
    if (s === "segmentation") {
      next.delete("stage");
    } else {
      next.set("stage", s);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div>
      {/* Stage toggle */}
      <div className="mb-6 flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-stone-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setStage("segmentation")}
            className={`rounded-md px-3 py-1.5 font-sans text-sm font-medium transition-colors ${
              stage === "segmentation"
                ? "bg-indigo text-parchment"
                : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {t("stage_segmentation")}
          </button>
          <button
            type="button"
            onClick={() => setStage("description")}
            className={`rounded-md px-3 py-1.5 font-sans text-sm font-medium transition-colors ${
              stage === "description"
                ? "bg-indigo text-parchment"
                : "text-stone-500 hover:text-stone-700"
            }`}
          >
            {t("stage_description")}
          </button>
        </div>
      </div>

      {/* Kanban */}
      <div className="overflow-x-auto">
        <div className="relative flex gap-4">
          {visibleColumns.map((column) => (
            <PipelineColumn
              key={column.id}
              column={column}
              columnId={column.id}
              isSuperAdmin={user.isSuperAdmin}
              onAssignClick={handleAssignClick}
            />
          ))}

          {assignPopover && (
            <AssignDescriberPopover
              entryId={assignPopover.entryId}
              projectId={assignPopover.projectId}
              teamMembers={teamMembers}
              onClose={handleAssignClose}
            />
          )}
        </div>
      </div>

      {visibleColumns.every((c) => c.items.length === 0) && (
        <p className="mt-8 rounded-lg border border-stone-200 px-4 py-8 text-center font-sans text-sm text-stone-400">
          {stage === "segmentation"
            ? t("empty_segmentation")
            : t("empty_description")}
        </p>
      )}
    </div>
  );
}
