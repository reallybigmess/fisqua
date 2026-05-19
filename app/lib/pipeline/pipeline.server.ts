/**
 * Description Workflow Pipeline
 *
 * This module deals with the server-side engine for the description
 * workflow: promoting a volume into description, tracking per-entry
 * describer and reviewer state, and moving each entry through draft
 * / submitted / approved / sent-back transitions. Callers pass the
 * guarded user in; every mutation writes an audit row so the trail
 * is recoverable.
 *
 * @version v0.3.0
 */
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { eq, and, isNull, notInArray, inArray } from "drizzle-orm";
import {
  volumes,
  entries,
  projects,
  users,
  projectMembers,
} from "~/db/schema";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

export const PIPELINE_COLUMNS = [
  { id: "unstarted", type: "volume" as const, statuses: ["unstarted"] },
  { id: "segmenting", type: "volume" as const, statuses: ["in_progress", "sent_back"] },
  { id: "seg_review", type: "volume" as const, statuses: ["segmented"] },
  { id: "ready_to_describe", type: "volume" as const, statuses: ["reviewed", "approved"] },
  { id: "describing", type: "entry" as const, statuses: ["assigned", "in_progress", "sent_back"] },
  { id: "desc_review", type: "entry" as const, statuses: ["described"] },
  { id: "ready_to_promote", type: "entry" as const, statuses: ["reviewed", "approved"] },
] as const;

const VOLUME_SENT_BACK_STATUS = "sent_back";
const ENTRY_SENT_BACK_STATUS = "sent_back";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineItem {
  id: string;
  name: string;
  assignee: string | null;
  projectId: string;
  projectName: string;
  updatedAt: number;
  isSentBack: boolean;
  type: "volume" | "entry";
}

export interface PipelineColumn {
  id: string;
  items: PipelineItem[];
}

type VolumeColumnId = "unstarted" | "segmenting" | "seg_review" | "ready_to_describe";
type EntryColumnId = "describing" | "desc_review" | "ready_to_promote";

// ---------------------------------------------------------------------------
// Pure grouping functions (testable without DB)
// ---------------------------------------------------------------------------

const VOLUME_STATUS_MAP: Record<string, VolumeColumnId> = {
  unstarted: "unstarted",
  in_progress: "segmenting",
  sent_back: "segmenting",
  segmented: "seg_review",
  reviewed: "ready_to_describe",
  approved: "ready_to_describe",
};

const ENTRY_STATUS_MAP: Record<string, EntryColumnId> = {
  assigned: "describing",
  in_progress: "describing",
  sent_back: "describing",
  described: "desc_review",
  reviewed: "ready_to_promote",
  approved: "ready_to_promote",
};

export function groupVolumesByColumn(
  volumeItems: Array<PipelineItem & { status: string }>
): Record<VolumeColumnId, PipelineItem[]> {
  const result: Record<VolumeColumnId, PipelineItem[]> = {
    unstarted: [],
    segmenting: [],
    seg_review: [],
    ready_to_describe: [],
  };

  for (const item of volumeItems) {
    const columnId = VOLUME_STATUS_MAP[item.status];
    if (!columnId) continue;

    result[columnId].push({
      id: item.id,
      name: item.name,
      assignee: item.assignee,
      projectId: item.projectId,
      projectName: item.projectName,
      updatedAt: item.updatedAt,
      isSentBack: item.status === VOLUME_SENT_BACK_STATUS,
      type: "volume",
    });
  }

  return result;
}

export function groupEntriesByColumn(
  entryItems: Array<PipelineItem & { descriptionStatus: string }>
): Record<EntryColumnId, PipelineItem[]> {
  const result: Record<EntryColumnId, PipelineItem[]> = {
    describing: [],
    desc_review: [],
    ready_to_promote: [],
  };

  for (const item of entryItems) {
    const columnId = ENTRY_STATUS_MAP[item.descriptionStatus];
    if (!columnId) continue;

    result[columnId].push({
      id: item.id,
      name: item.name,
      assignee: item.assignee,
      projectId: item.projectId,
      projectName: item.projectName,
      updatedAt: item.updatedAt,
      isSentBack: item.descriptionStatus === ENTRY_SENT_BACK_STATUS,
      type: "entry",
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

export async function getPipelineData(
  db: DrizzleD1Database,
  projectFilter?: string
): Promise<PipelineColumn[]> {
  // Query volumes with project and assignee info
  const volumeConditions = projectFilter
    ? eq(volumes.projectId, projectFilter)
    : undefined;

  const volumeRows = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      status: volumes.status,
      projectId: volumes.projectId,
      projectName: projects.name,
      assigneeName: users.name,
      updatedAt: volumes.updatedAt,
    })
    .from(volumes)
    .leftJoin(projects, eq(volumes.projectId, projects.id))
    .leftJoin(users, eq(volumes.assignedTo, users.id))
    .where(volumeConditions)
    .all();

  const volumeItems = volumeRows.map((row) => ({
    id: row.id,
    name: row.name,
    assignee: row.assigneeName ?? null,
    projectId: row.projectId,
    projectName: row.projectName ?? "",
    updatedAt: row.updatedAt,
    isSentBack: false,
    type: "volume" as const,
    status: row.status,
  }));

  // Query entries in the description pipeline (not unassigned, not promoted)
  const entryBaseConditions = [
    notInArray(entries.descriptionStatus, ["unassigned", "promoted"]),
  ];
  if (projectFilter) {
    entryBaseConditions.push(eq(volumes.projectId, projectFilter));
  }

  const entryRows = await db
    .select({
      id: entries.id,
      title: entries.title,
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
      projectId: volumes.projectId,
      projectName: projects.name,
      assigneeName: users.name,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .innerJoin(volumes, eq(entries.volumeId, volumes.id))
    .leftJoin(projects, eq(volumes.projectId, projects.id))
    .leftJoin(users, eq(entries.assignedDescriber, users.id))
    .where(and(...entryBaseConditions))
    .all();

  const entryItems = entryRows.map((row) => ({
    id: row.id,
    name: row.title ?? "(untitled)",
    assignee: row.assigneeName ?? null,
    projectId: row.projectId,
    projectName: row.projectName ?? "",
    updatedAt: row.updatedAt,
    isSentBack: false,
    type: "entry" as const,
    descriptionStatus: row.descriptionStatus ?? "assigned",
  }));

  const volumeGroups = groupVolumesByColumn(volumeItems);
  const entryGroups = groupEntriesByColumn(entryItems);

  return PIPELINE_COLUMNS.map((col) => ({
    id: col.id,
    items:
      col.type === "volume"
        ? volumeGroups[col.id as VolumeColumnId]
        : entryGroups[col.id as EntryColumnId],
  }));
}

// ---------------------------------------------------------------------------
// Assign describer action
// ---------------------------------------------------------------------------

export async function assignDescriber(
  db: DrizzleD1Database,
  entryId: string,
  describerId: string
): Promise<{ success: boolean; error?: string }> {
  const entry = await db
    .select({ id: entries.id, descriptionStatus: entries.descriptionStatus })
    .from(entries)
    .where(eq(entries.id, entryId))
    .get();

  if (!entry) {
    return { success: false, error: "Entry not found" };
  }

  if (entry.descriptionStatus !== "unassigned") {
    return { success: false, error: "Entry is not in unassigned status" };
  }

  await db
    .update(entries)
    .set({
      descriptionStatus: "assigned",
      assignedDescriber: describerId,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(entries.id, entryId));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

export async function getProjectsForFilter(
  db: DrizzleD1Database
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(isNull(projects.archivedAt))
    .all();

  return rows;
}

export async function getTeamMembers(
  db: DrizzleD1Database,
  projectId?: string
): Promise<Array<{ id: string; name: string | null; email: string }>> {
  if (projectId) {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .innerJoin(projectMembers, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
      .all();

    return rows;
  }

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .all();

  return rows;
}
