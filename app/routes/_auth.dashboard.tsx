/**
 * Role-Dependent Dashboard
 *
 * This route is the legacy dashboard kept for deep links and
 * admin-first users. It determines the caller's primary project role
 * — with lead taking
 * precedence over reviewer, reviewer over cataloguer — and renders
 * the appropriate dashboard view (`LeadDashboard`, `ReviewerDashboard`,
 * or `CataloguerDashboard`) with the role-specific payload the loader
 * assembled from volumes, entries, and assignments.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { userContext } from "../context";
import {
  CataloguerDashboard,
  type CataloguerGroups,
} from "../components/dashboard/cataloguer-dashboard";
import {
  ReviewerDashboard,
  type ReviewerGroups,
} from "../components/dashboard/reviewer-dashboard";
import {
  LeadDashboard,
  type ProjectOverview,
  type AttentionItem,
  type TeamMember,
} from "../components/dashboard/lead-dashboard";
import {
  CataloguerDescriptionTab,
  type DescriptionEntryCardData,
} from "../components/dashboard/cataloguer-description-tab";
import {
  ReviewerDescriptionTab,
  type ReviewerDescriptionData,
} from "../components/dashboard/reviewer-description-tab";
import type { VolumeCardData } from "../components/dashboard/volume-status-card";
import type { Route } from "./+types/_auth.dashboard";

export function meta() {
  return [
    { title: "Inicio" },
    { name: "description", content: "Inicio" },
  ];
}

type DashboardRole = "lead" | "reviewer" | "cataloguer" | "none";

/**
 * Determine user's primary role across all projects.
 * Priority: lead > reviewer > cataloguer ()
 */
function determinePrimaryRole(
  memberships: { role: string }[]
): DashboardRole {
  const roles = new Set(memberships.map((m) => m.role));
  if (roles.has("lead")) return "lead";
  if (roles.has("reviewer")) return "reviewer";
  if (roles.has("cataloguer")) return "cataloguer";
  return "none";
}

export async function loader({ context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, sql, inArray, isNull, and, desc } = await import("drizzle-orm");
  const {
    volumes,
    projectMembers,
    users,
    projects,
    entries,
    comments,
    resegmentationFlags,
  } = await import("../db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Get all memberships for role determination
  const memberships = await db
    .select({
      projectId: projectMembers.projectId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id))
    .all();

  const primaryRole = user.isAdmin ? "lead" : determinePrimaryRole(memberships);

  if (primaryRole === "none") {
    return { user, primaryRole, data: null };
  }

  if (primaryRole === "cataloguer") {
    const [segData, descData] = await Promise.all([
      loadCataloguerData(db, user.id, { eq, sql, inArray, volumes, entries, projects }),
      loadCataloguerDescriptionData(db, user.id, { eq, inArray, desc, volumes, entries, comments }),
    ]);
    return {
      user,
      primaryRole,
      data: { ...segData, descriptionEntries: descData },
    };
  }

  if (primaryRole === "reviewer") {
    const [segData, descData] = await Promise.all([
      loadReviewerData(db, user.id, { eq, sql, inArray, and, volumes, entries, projects, users }),
      loadReviewerDescriptionData(db, user.id, { eq, inArray, and, volumes, entries, users, resegmentationFlags }),
    ]);
    return {
      user,
      primaryRole,
      data: { ...segData, descriptionData: descData },
    };
  }

  // lead or admin
  return {
    user,
    primaryRole,
    data: await loadLeadData(db, user.id, user.isAdmin, { eq, sql, inArray, isNull, and, desc, volumes, projectMembers, users, projects, entries, resegmentationFlags }),
  };
}

/**
 * Load cataloguer dashboard data: all assigned volumes grouped by urgency.
 */
async function loadCataloguerData(
  db: any,
  userId: string,
  deps: any
): Promise<{ groups: CataloguerGroups }> {
  const { eq, sql, inArray, volumes, entries, projects } = deps;

  // All volumes assigned to this cataloguer with entry counts
  const assignedVolumes = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      pageCount: volumes.pageCount,
      status: volumes.status,
      projectId: volumes.projectId,
      updatedAt: volumes.updatedAt,
      reviewComment: volumes.reviewComment,
    })
    .from(volumes)
    .where(eq(volumes.assignedTo, userId))
    .all();

  if (assignedVolumes.length === 0) {
    return {
      groups: {
        needsAttention: [],
        inProgress: [],
        readyToStart: [],
        completed: [],
      },
    };
  }

  // Get entry counts for these volumes in a single query
  const volumeIds = assignedVolumes.map((v: any) => v.id);
  const entryCounts = await db
    .select({
      volumeId: entries.volumeId,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(entries)
    .where(inArray(entries.volumeId, volumeIds))
    .groupBy(entries.volumeId)
    .all();

  const entryCountMap = new Map<string, number>(
    entryCounts.map((e: any) => [e.volumeId, e.count])
  );

  // Get project names
  const projectIds = [...new Set(assignedVolumes.map((v: any) => v.projectId))];
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds))
    .all();

  const projectNameMap = new Map<string, string>(projectRows.map((p: any) => [p.id, p.name]));

  // Build card data and group
  const groups: CataloguerGroups = {
    needsAttention: [],
    inProgress: [],
    readyToStart: [],
    completed: [],
  };

  for (const vol of assignedVolumes) {
    const card: VolumeCardData = {
      id: vol.id,
      name: vol.name,
      pageCount: vol.pageCount,
      entryCount: entryCountMap.get(vol.id) ?? 0,
      status: vol.status,
      projectId: vol.projectId,
      projectName: projectNameMap.get(vol.projectId) ?? "",
      updatedAt: vol.updatedAt,
      reviewComment: vol.reviewComment,
    };

    switch (vol.status) {
      case "sent_back":
        groups.needsAttention.push(card);
        break;
      case "in_progress":
        groups.inProgress.push(card);
        break;
      case "unstarted":
        groups.readyToStart.push(card);
        break;
      default:
        groups.completed.push(card);
        break;
    }
  }

  // Sort each group by most recent activity (updatedAt desc)
  const sortByRecent = (a: VolumeCardData, b: VolumeCardData) =>
    b.updatedAt - a.updatedAt;

  groups.needsAttention.sort(sortByRecent);
  groups.inProgress.sort(sortByRecent);
  groups.readyToStart.sort(sortByRecent);
  groups.completed.sort(sortByRecent);

  return { groups };
}

/**
 * Load reviewer dashboard data: all volumes assigned for review grouped by status.
 */
async function loadReviewerData(
  db: any,
  userId: string,
  deps: any
): Promise<{ groups: ReviewerGroups }> {
  const { eq, sql, inArray, volumes, entries, projects, users } = deps;

  const reviewVolumes = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      pageCount: volumes.pageCount,
      status: volumes.status,
      projectId: volumes.projectId,
      updatedAt: volumes.updatedAt,
      assignedTo: volumes.assignedTo,
    })
    .from(volumes)
    .where(eq(volumes.assignedReviewer, userId))
    .all();

  if (reviewVolumes.length === 0) {
    return {
      groups: { awaitingReview: [], reviewed: [], approved: [] },
    };
  }

  // Get entry counts
  const volumeIds = reviewVolumes.map((v: any) => v.id);
  const entryCounts = await db
    .select({
      volumeId: entries.volumeId,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(entries)
    .where(inArray(entries.volumeId, volumeIds))
    .groupBy(entries.volumeId)
    .all();

  const entryCountMap = new Map<string, number>(
    entryCounts.map((e: any) => [e.volumeId, e.count])
  );

  // Get cataloguer names
  const cataloguerIds = [
    ...new Set(reviewVolumes.map((v: any) => v.assignedTo).filter(Boolean)),
  ] as string[];

  let cataloguerNameMap = new Map<string, string>();
  if (cataloguerIds.length > 0) {
    const cataloguers = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, cataloguerIds))
      .all();
    cataloguerNameMap = new Map(
      cataloguers.map((u: any) => [u.id, u.name ?? "Unnamed"])
    );
  }

  // Get project names
  const projectIds = [...new Set(reviewVolumes.map((v: any) => v.projectId))];
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, projectIds))
    .all();

  const projectNameMap = new Map<string, string>(projectRows.map((p: any) => [p.id, p.name]));

  const groups: ReviewerGroups = {
    awaitingReview: [],
    reviewed: [],
    approved: [],
  };

  for (const vol of reviewVolumes) {
    const card: VolumeCardData = {
      id: vol.id,
      name: vol.name,
      pageCount: vol.pageCount,
      entryCount: entryCountMap.get(vol.id) ?? 0,
      status: vol.status,
      projectId: vol.projectId,
      projectName: projectNameMap.get(vol.projectId) ?? "",
      updatedAt: vol.updatedAt,
      cataloguerName: vol.assignedTo
        ? cataloguerNameMap.get(vol.assignedTo) ?? null
        : null,
    };

    switch (vol.status) {
      case "segmented":
        groups.awaitingReview.push(card);
        break;
      case "reviewed":
        groups.reviewed.push(card);
        break;
      case "approved":
        groups.approved.push(card);
        break;
      // Other statuses (in_progress, unstarted, sent_back) not shown for reviewers
    }
  }

  const sortByRecent = (a: VolumeCardData, b: VolumeCardData) =>
    b.updatedAt - a.updatedAt;

  groups.awaitingReview.sort(sortByRecent);
  groups.reviewed.sort(sortByRecent);
  groups.approved.sort(sortByRecent);

  return { groups };
}

/**
 * Load lead dashboard data: cross-project overview with attention items.
 */
async function loadLeadData(
  db: any,
  userId: string,
  isAdmin: boolean,
  deps: any
): Promise<{ projects: ProjectOverview[]; attentionItems: AttentionItem[] }> {
  const { eq, sql, inArray, isNull, and, volumes, projectMembers, users, projects, entries, resegmentationFlags } = deps;

  // Get projects where user is lead (or all projects if admin)
  let leadProjectIds: string[];

  if (isAdmin) {
    const allProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(isNull(projects.archivedAt))
      .all();
    leadProjectIds = allProjects.map((p: any) => p.id);
  } else {
    const allMemberships = await db
      .select({
        projectId: projectMembers.projectId,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId))
      .all();
    leadProjectIds = allMemberships
      .filter((m: any) => m.role === "lead")
      .map((m: any) => m.projectId);
  }

  if (leadProjectIds.length === 0) {
    return { projects: [], attentionItems: [] };
  }

  // Fetch project details
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, leadProjectIds))
    .all();

  // Fetch all volumes for these projects
  const allVolumes = await db
    .select({
      id: volumes.id,
      projectId: volumes.projectId,
      name: volumes.name,
      referenceCode: volumes.referenceCode,
      status: volumes.status,
      assignedTo: volumes.assignedTo,
      assignedReviewer: volumes.assignedReviewer,
      updatedAt: volumes.updatedAt,
    })
    .from(volumes)
    .where(inArray(volumes.projectId, leadProjectIds))
    .all();

  // Fetch all entries for description status aggregation
  const allVolumeIds = allVolumes.map((v: any) => v.id);
  let entryDescStatusRows: { volumeId: string; descriptionStatus: string | null; count: number }[] = [];
  if (allVolumeIds.length > 0) {
    entryDescStatusRows = await db
      .select({
        volumeId: entries.volumeId,
        descriptionStatus: entries.descriptionStatus,
        count: sql<number>`count(*)`,
      })
      .from(entries)
      .where(inArray(entries.volumeId, allVolumeIds))
      .groupBy(entries.volumeId, entries.descriptionStatus)
      .all();
  }

  // Build per-volume description status map
  const volumeDescMap = new Map<string, Record<string, number>>();
  for (const row of entryDescStatusRows) {
    const vid = row.volumeId;
    if (!volumeDescMap.has(vid)) volumeDescMap.set(vid, {});
    const status = row.descriptionStatus ?? "unassigned";
    volumeDescMap.get(vid)![status] = row.count;
  }

  // Fetch open reseg flags for these volumes
  let openResegFlags: { id: string; volumeId: string }[] = [];
  if (allVolumeIds.length > 0) {
    openResegFlags = await db
      .select({
        id: resegmentationFlags.id,
        volumeId: resegmentationFlags.volumeId,
      })
      .from(resegmentationFlags)
      .where(
        and(
          inArray(resegmentationFlags.volumeId, allVolumeIds),
          eq(resegmentationFlags.status, "open")
        )
      )
      .all();
  }

  // Fetch entries waiting >3 days for description review
  let descReviewEntries: { id: string; title: string | null; volumeId: string; updatedAt: number }[] = [];
  if (allVolumeIds.length > 0) {
    descReviewEntries = await db
      .select({
        id: entries.id,
        title: entries.title,
        volumeId: entries.volumeId,
        updatedAt: entries.updatedAt,
      })
      .from(entries)
      .where(
        and(
          inArray(entries.volumeId, allVolumeIds),
          eq(entries.descriptionStatus, "described")
        )
      )
      .all();
  }

  // Fetch all members for these projects
  const allMembers = await db
    .select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, leadProjectIds))
    .all();

  // Fetch user details for members
  const memberUserIds = [...new Set(allMembers.map((m: any) => m.userId))];
  let userMap = new Map<string, { name: string | null; lastActiveAt: number | null }>();
  if (memberUserIds.length > 0) {
    const memberUsers = await db
      .select({
        id: users.id,
        name: users.name,
        lastActiveAt: users.lastActiveAt,
      })
      .from(users)
      .where(inArray(users.id, memberUserIds))
      .all();
    userMap = new Map(
      memberUsers.map((u: any) => [u.id, { name: u.name, lastActiveAt: u.lastActiveAt }])
    );
  }

  const now = Date.now();
  const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const attentionItems: AttentionItem[] = [];

  // Volume lookup for reseg/desc review attention items
  const volumeLookup = new Map<string, any>(allVolumes.map((v: any) => [v.id, v]));

  // Attention: open reseg flags
  for (const flag of openResegFlags) {
    const vol = volumeLookup.get(flag.volumeId);
    if (vol) {
      attentionItems.push({
        type: "resegmentation",
        volumeName: vol.name,
        link: `/projects/${vol.projectId}/volumes/${vol.id}`,
      });
    }
  }

  // Attention: entries waiting >3 days for description review
  for (const entry of descReviewEntries) {
    if (now - entry.updatedAt > THREE_DAYS) {
      const vol = volumeLookup.get(entry.volumeId);
      const days = Math.floor((now - entry.updatedAt) / (1000 * 60 * 60 * 24));
      attentionItems.push({
        type: "description-review",
        entryTitle: entry.title ?? undefined,
        volumeName: vol?.name,
        days,
        link: vol ? `/projects/${vol.projectId}/describe/${entry.id}` : "#",
      });
    }
  }

  // Build project overviews
  const projectOverviews: ProjectOverview[] = projectRows.map((project: any) => {
    const projectVolumes = allVolumes.filter(
      (v: any) => v.projectId === project.id
    );
    const projectMemberRows = allMembers.filter(
      (m: any) => m.projectId === project.id
    );

    // Status counts (segmentation)
    const statusCounts: Record<string, number> = {};
    for (const vol of projectVolumes) {
      statusCounts[vol.status] = (statusCounts[vol.status] ?? 0) + 1;
    }

    // Description status counts (aggregated across all entries in project volumes)
    const descriptionStatusCounts: Record<string, number> = {};
    for (const vol of projectVolumes) {
      const volDesc = volumeDescMap.get(vol.id);
      if (volDesc) {
        for (const [status, count] of Object.entries(volDesc)) {
          descriptionStatusCounts[status] = (descriptionStatusCounts[status] ?? 0) + count;
        }
      }
    }

    // Attention: volumes waiting >3 days for review
    for (const vol of projectVolumes) {
      if (vol.status === "segmented" && now - vol.updatedAt > THREE_DAYS) {
        const days = Math.floor((now - vol.updatedAt) / (1000 * 60 * 60 * 24));
        attentionItems.push({
          type: "waiting",
          volumeName: vol.name,
          days,
          link: `/projects/${project.id}/assignments`,
        });
      }
    }

    // Attention: unassigned volumes
    const unassigned = projectVolumes.filter((v: any) => !v.assignedTo);
    if (unassigned.length > 0) {
      attentionItems.push({
        type: "unassigned",
        count: unassigned.length,
        projectName: project.name,
        link: `/projects/${project.id}/assignments`,
      });
    }

    // Count volumes per member
    const memberVolumeCounts = new Map<string, number>();
    for (const vol of projectVolumes) {
      if (vol.assignedTo) {
        memberVolumeCounts.set(
          vol.assignedTo,
          (memberVolumeCounts.get(vol.assignedTo) ?? 0) + 1
        );
      }
      if (vol.assignedReviewer) {
        memberVolumeCounts.set(
          vol.assignedReviewer,
          (memberVolumeCounts.get(vol.assignedReviewer) ?? 0) + 1
        );
      }
    }

    // Total entries for project
    const totalEntries = Object.values(descriptionStatusCounts).reduce((sum, n) => sum + n, 0);

    // Build team member list
    const teamMembers: TeamMember[] = projectMemberRows.map((m: any) => {
      const userInfo = userMap.get(m.userId);

      // Attention: inactive members (>7 days)
      if (
        userInfo?.lastActiveAt &&
        now - userInfo.lastActiveAt > SEVEN_DAYS
      ) {
        attentionItems.push({
          type: "inactive",
          memberName: userInfo.name ?? null,
          days: Math.floor((now - userInfo.lastActiveAt) / (1000 * 60 * 60 * 24)),
          link: `/users/${m.userId}/activity`,
        });
      }

      return {
        id: m.userId,
        name: userInfo?.name ?? null,
        role: m.role,
        lastActiveAt: userInfo?.lastActiveAt ?? null,
        volumeCount: memberVolumeCounts.get(m.userId) ?? 0,
      };
    });

    return {
      id: project.id,
      name: project.name,
      statusCounts,
      descriptionStatusCounts,
      totalVolumes: projectVolumes.length,
      totalEntries,
      teamMembers,
    };
  });

  return {
    projects: projectOverviews,
    attentionItems,
  };
}

/**
 * Load description entries assigned to this cataloguer for the description tab.
 */
async function loadCataloguerDescriptionData(
  db: any,
  userId: string,
  deps: any
): Promise<DescriptionEntryCardData[]> {
  const { eq, inArray, desc, volumes, entries, comments } = deps;

  const assignedEntries = await db
    .select({
      id: entries.id,
      title: entries.title,
      translatedTitle: entries.translatedTitle,
      startPage: entries.startPage,
      endPage: entries.endPage,
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
      resourceType: entries.resourceType,
      dateExpression: entries.dateExpression,
      extent: entries.extent,
      scopeContent: entries.scopeContent,
      language: entries.language,
      descriptionNotes: entries.descriptionNotes,
    })
    .from(entries)
    .where(eq(entries.assignedDescriber, userId))
    .all();

  if (assignedEntries.length === 0) return [];

  // Get volume info
  const volumeIds = [...new Set(assignedEntries.map((e: any) => e.volumeId))];
  const volumeRows = await db
    .select({
      id: volumes.id,
      name: volumes.name,
      referenceCode: volumes.referenceCode,
      projectId: volumes.projectId,
    })
    .from(volumes)
    .where(inArray(volumes.id, volumeIds))
    .all();

  const volumeMap = new Map<string, any>(volumeRows.map((v: any) => [v.id, v]));

  // Get latest reviewer comment for sent_back entries
  const sentBackIds = assignedEntries
    .filter((e: any) => e.descriptionStatus === "sent_back")
    .map((e: any) => e.id);

  let feedbackMap = new Map<string, string>();
  if (sentBackIds.length > 0) {
    // Get the most recent comment per entry
    const latestComments = await db
      .select({
        entryId: comments.entryId,
        text: comments.text,
        createdAt: comments.createdAt,
      })
      .from(comments)
      .where(inArray(comments.entryId, sentBackIds))
      .orderBy(desc(comments.createdAt))
      .all();

    // Keep only the latest per entry
    for (const c of latestComments) {
      if (!feedbackMap.has(c.entryId)) {
        feedbackMap.set(c.entryId, c.text);
      }
    }
  }

  return assignedEntries.map((e: any) => {
    const vol = volumeMap.get(e.volumeId);
    return {
      id: e.id,
      title: e.title,
      translatedTitle: e.translatedTitle,
      referenceCode: vol?.referenceCode ?? "",
      volumeTitle: vol?.name ?? "",
      volumeId: e.volumeId,
      projectId: vol?.projectId ?? "",
      startPage: e.startPage,
      endPage: e.endPage,
      descriptionStatus: e.descriptionStatus ?? "unassigned",
      reviewerFeedback: feedbackMap.get(e.id) ?? null,
      hasIdentificacion: !!(e.title || e.translatedTitle) && !!e.resourceType && !!e.dateExpression,
      hasFisica: !!e.extent,
      hasContenido: !!e.scopeContent && !!e.language,
      hasNotas: !!e.descriptionNotes,
    };
  });
}

/**
 * Load description data for reviewer's description tab:
 * reseg flags and entries assigned for description review.
 */
async function loadReviewerDescriptionData(
  db: any,
  userId: string,
  deps: any
): Promise<ReviewerDescriptionData> {
  const { eq, inArray, and, volumes, entries, resegmentationFlags } = deps;

  // Entries assigned to this reviewer for description review
  const reviewEntries = await db
    .select({
      id: entries.id,
      title: entries.title,
      translatedTitle: entries.translatedTitle,
      startPage: entries.startPage,
      endPage: entries.endPage,
      descriptionStatus: entries.descriptionStatus,
      volumeId: entries.volumeId,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(eq(entries.assignedDescriptionReviewer, userId))
    .all();

  // Get volume info
  const volumeIds = [...new Set(reviewEntries.map((e: any) => e.volumeId))];
  let volumeMap = new Map<string, { name: string; referenceCode: string; projectId: string }>();
  if (volumeIds.length > 0) {
    const volumeRows = await db
      .select({
        id: volumes.id,
        name: volumes.name,
        referenceCode: volumes.referenceCode,
        projectId: volumes.projectId,
      })
      .from(volumes)
      .where(inArray(volumes.id, volumeIds))
      .all();
    volumeMap = new Map(volumeRows.map((v: any) => [v.id, v]));
  }

  // Open resegmentation flags for volumes this reviewer handles
  const reviewerVolumes = await db
    .select({ id: volumes.id })
    .from(volumes)
    .where(eq(volumes.assignedReviewer, userId))
    .all();

  const reviewerVolumeIds = reviewerVolumes.map((v: any) => v.id);
  let resegFlags: ReviewerDescriptionData["resegFlags"] = [];
  if (reviewerVolumeIds.length > 0) {
    const flags = await db
      .select({
        id: resegmentationFlags.id,
        volumeId: resegmentationFlags.volumeId,
        problemType: resegmentationFlags.problemType,
        description: resegmentationFlags.description,
        createdAt: resegmentationFlags.createdAt,
      })
      .from(resegmentationFlags)
      .where(
        and(
          inArray(resegmentationFlags.volumeId, reviewerVolumeIds),
          eq(resegmentationFlags.status, "open")
        )
      )
      .all();

    // Get volume info for flags
    let flagVolumeMap = volumeMap;
    const missingVolumeIds = flags
      .map((f: any) => f.volumeId)
      .filter((vid: string) => !flagVolumeMap.has(vid));

    if (missingVolumeIds.length > 0) {
      const extraVolumes = await db
        .select({
          id: volumes.id,
          name: volumes.name,
          referenceCode: volumes.referenceCode,
          projectId: volumes.projectId,
        })
        .from(volumes)
        .where(inArray(volumes.id, missingVolumeIds))
        .all();
      for (const v of extraVolumes) {
        flagVolumeMap.set(v.id, v);
      }
    }

    resegFlags = flags.map((f: any) => {
      const vol = flagVolumeMap.get(f.volumeId);
      return {
        id: f.id,
        volumeId: f.volumeId,
        volumeTitle: vol?.name ?? "",
        referenceCode: vol?.referenceCode ?? "",
        projectId: vol?.projectId ?? "",
        problemType: f.problemType,
        description: f.description,
      };
    });
  }

  const entryCards = reviewEntries.map((e: any) => {
    const vol = volumeMap.get(e.volumeId);
    return {
      id: e.id,
      title: e.title,
      translatedTitle: e.translatedTitle,
      referenceCode: vol?.referenceCode ?? "",
      volumeTitle: vol?.name ?? "",
      volumeId: e.volumeId,
      projectId: vol?.projectId ?? "",
      startPage: e.startPage,
      endPage: e.endPage,
      descriptionStatus: e.descriptionStatus ?? "unassigned",
      updatedAt: e.updatedAt,
    };
  });

  return {
    resegFlags,
    awaitingReview: entryCards.filter((e: any) => e.descriptionStatus === "described"),
    reviewed: entryCards.filter((e: any) => e.descriptionStatus === "reviewed"),
    approved: entryCards.filter((e: any) => e.descriptionStatus === "approved"),
  };
}

/** Underline tabs for cataloguer dashboard */
function CataloguerTabs({
  activeTab,
  onTabChange,
  segCount,
  descCount,
}: {
  activeTab: "segmentation" | "description";
  onTabChange: (tab: "segmentation" | "description") => void;
  segCount: number;
  descCount: number;
}) {
  const { t } = useTranslation(["description", "dashboard"]);

  return (
    <div className="flex gap-6 border-b border-stone-200">
      <button
        onClick={() => onTabChange("segmentation")}
        className={`relative pb-3 text-sm font-medium transition-colors ${
          activeTab === "segmentation"
            ? "text-indigo"
            : "text-stone-500 hover:text-stone-700"
        }`}
      >
        {t("description:tabs.segmentacion")}
        {segCount > 0 && (
          <span className={`ml-1.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            activeTab === "segmentation"
              ? "bg-indigo-tint text-indigo"
              : "bg-stone-100 text-stone-500"
          }`}>
            {segCount}
          </span>
        )}
        {activeTab === "segmentation" && (
          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo" />
        )}
      </button>
      <button
        onClick={() => onTabChange("description")}
        className={`relative pb-3 text-sm font-medium transition-colors ${
          activeTab === "description"
            ? "text-indigo"
            : "text-stone-500 hover:text-stone-700"
        }`}
      >
        {t("description:tabs.descripcion")}
        {descCount > 0 && (
          <span className={`ml-1.5 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            activeTab === "description"
              ? "bg-indigo-tint text-indigo"
              : "bg-stone-100 text-stone-500"
          }`}>
            {descCount}
          </span>
        )}
        {activeTab === "description" && (
          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-indigo" />
        )}
      </button>
    </div>
  );
}

/** Pill tabs for reviewer dashboard */
function ReviewerTabs({
  activeTab,
  onTabChange,
  segCount,
  descCount,
}: {
  activeTab: "segmentation" | "description";
  onTabChange: (tab: "segmentation" | "description") => void;
  segCount: number;
  descCount: number;
}) {
  const { t } = useTranslation("description");

  return (
    <div className="flex gap-2">
      <button
        onClick={() => onTabChange("segmentation")}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
          activeTab === "segmentation"
            ? "bg-indigo-tint text-indigo"
            : "bg-stone-100 text-stone-500 hover:bg-stone-200"
        }`}
      >
        {t("tabs.segmentacion")}
        {segCount > 0 && (
          <span className="ml-1.5 text-xs">({segCount})</span>
        )}
      </button>
      <button
        onClick={() => onTabChange("description")}
        className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
          activeTab === "description"
            ? "bg-indigo-tint text-indigo"
            : "bg-stone-100 text-stone-500 hover:bg-stone-200"
        }`}
      >
        {t("tabs.descripcion")}
        {descCount > 0 && (
          <span className="ml-1.5 text-xs">({descCount})</span>
        )}
      </button>
    </div>
  );
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, primaryRole, data } = loaderData;
  const { t } = useTranslation("dashboard");
  const [activeTab, setActiveTab] = useState<"segmentation" | "description">("segmentation");

  // Compute tab counts for cataloguer
  const cataloguerData = primaryRole === "cataloguer" && data
    ? (data as { groups: CataloguerGroups; descriptionEntries: DescriptionEntryCardData[] })
    : null;

  const cataloguerSegCount = cataloguerData
    ? cataloguerData.groups.needsAttention.length +
      cataloguerData.groups.inProgress.length +
      cataloguerData.groups.readyToStart.length
    : 0;

  const cataloguerDescCount = cataloguerData
    ? cataloguerData.descriptionEntries.filter(
        (e) => e.descriptionStatus !== "described" &&
               e.descriptionStatus !== "reviewed" &&
               e.descriptionStatus !== "approved"
      ).length
    : 0;

  // Compute tab counts for reviewer
  const reviewerData = primaryRole === "reviewer" && data
    ? (data as { groups: ReviewerGroups; descriptionData: ReviewerDescriptionData })
    : null;

  const reviewerSegCount = reviewerData
    ? reviewerData.groups.awaitingReview.length +
      reviewerData.groups.reviewed.length
    : 0;

  const reviewerDescCount = reviewerData
    ? reviewerData.descriptionData.resegFlags.length +
      reviewerData.descriptionData.awaitingReview.length
    : 0;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[2.5rem] font-semibold text-stone-900">
          {primaryRole === "cataloguer"
            ? t("heading.my_work")
            : primaryRole === "reviewer"
              ? t("heading.my_reviews")
              : t("heading.dashboard")}
        </h1>
        {user.isAdmin && (
          <div className="flex items-center gap-3">
            <Link
              to="/admin/cataloguing/users"
              className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            >
              {t("nav.admin")}
            </Link>
            <Link
              to="/projects/new"
              className="rounded-md bg-indigo px-3 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep"
            >
              {t("new_project")}
            </Link>
          </div>
        )}
      </div>

      <div className="mt-6">
        {primaryRole === "none" || !data ? (
          <div className="mt-12 flex justify-center">
            <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm ring-1 ring-stone-100 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-indigo-tint">
                <svg className="h-7 w-7 text-indigo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h3 className="mt-4 font-serif text-[18px] font-semibold text-indigo">{t("empty.no_projects_title")}</h3>
              {user.isAdmin ? (
                <>
                  <p className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto">
                    {t("empty.no_projects_admin_body")}
                  </p>
                  <div className="mt-5 flex items-center justify-center gap-3">
                    <Link
                      to="/projects/new"
                      className="rounded-md bg-indigo px-3 py-2 text-sm font-medium text-parchment hover:bg-indigo-deep"
                    >
                      {t("new_project")}
                    </Link>
                    <Link
                      to="/admin/cataloguing/users"
                      className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
                    >
                      {t("manage_users")}
                    </Link>
                  </div>
                </>
              ) : (
                <p className="mt-2 font-serif text-[15px] text-stone-500 max-w-[36ch] mx-auto">
                  {t("empty.no_projects_member_body")}
                </p>
              )}
            </div>
          </div>
        ) : primaryRole === "cataloguer" ? (
          <div className="space-y-6">
            <CataloguerTabs
              activeTab={activeTab}
              onTabChange={setActiveTab}
              segCount={cataloguerSegCount}
              descCount={cataloguerDescCount}
            />
            {activeTab === "segmentation" ? (
              <CataloguerDashboard groups={cataloguerData!.groups} />
            ) : (
              <CataloguerDescriptionTab entries={cataloguerData!.descriptionEntries} />
            )}
          </div>
        ) : primaryRole === "reviewer" ? (
          <div className="space-y-6">
            <ReviewerTabs
              activeTab={activeTab}
              onTabChange={setActiveTab}
              segCount={reviewerSegCount}
              descCount={reviewerDescCount}
            />
            {activeTab === "segmentation" ? (
              <ReviewerDashboard groups={reviewerData!.groups} />
            ) : (
              <ReviewerDescriptionTab data={reviewerData!.descriptionData} />
            )}
          </div>
        ) : (
          <LeadDashboard
            projects={
              (data as { projects: ProjectOverview[]; attentionItems: AttentionItem[] })
                .projects
            }
            attentionItems={
              (data as { projects: ProjectOverview[]; attentionItems: AttentionItem[] })
                .attentionItems
            }
          />
        )}
      </div>
    </div>
  );
}
