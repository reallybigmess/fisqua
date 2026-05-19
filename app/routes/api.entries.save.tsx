/**
 * Entries Save API
 *
 * This API endpoint is the persistence path for the segmentation
 * viewer's outline. Action-only — no loader, no component. The
 * cataloguing workspace POSTs here both on debounced autosave and on
 * an explicit "accept corrections" click, multiplexed through the
 * `_action` form field.
 *
 * The normal save flow looks up the target volume, runs the
 * project-role guard (`requireProjectRole`) and the volume-access
 * guard (`requireVolumeAccess`) so neither a non-member of the
 * project nor a member without an assignment to this volume can mutate
 * the entries, then delegates to `saveEntries` which writes the
 * outline atomically and bumps the volume's workflow timestamps.
 * `accept-corrections` clears the `reviewer_comment` field on every
 * sent-back entry in the volume, signalling that the cataloguer has
 * acknowledged the reviewer's notes and is taking another pass.
 *
 * Activity is logged through `logActivity` so the dashboards and the
 * per-user activity timeline reflect the change without a separate
 * write path.
 *
 * @version v0.3.0
 */

import { userContext } from "../context";
import type { Route } from "./+types/api.entries.save";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, isNotNull } = await import("drizzle-orm");
  const {
    requireProjectRole,
    requireVolumeAccess,
  } = await import("../lib/permissions.server");
  const { saveEntries } = await import("../lib/entries.server");
  const { logActivity } = await import("../lib/workflow.server");
  const { volumes, entries } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const actionType = formData.get("_action") as string | null;
  const volumeId = formData.get("volumeId") as string;

  // --- Accept corrections action ---
  if (actionType === "accept-corrections") {
    if (!volumeId) {
      return Response.json({ error: "volumeId is required" }, { status: 400 });
    }
    return handleAcceptCorrections(db, user.id, user.isAdmin, volumeId, {
      eq, and, isNotNull, requireProjectRole, requireVolumeAccess, logActivity, volumes, entries,
    });
  }

  // --- Normal save flow ---
  const entriesJson = formData.get("entries") as string;

  if (!volumeId || !entriesJson) {
    return Response.json(
      { error: "volumeId and entries are required" },
      { status: 400 }
    );
  }

  // Look up volume to get projectId, status, and assignment info
  const volume = await db
    .select({
      projectId: volumes.projectId,
      status: volumes.status,
      assignedTo: volumes.assignedTo,
      assignedReviewer: volumes.assignedReviewer,
    })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    return Response.json({ error: "Volume not found" }, { status: 404 });
  }

  // Extend access: lead, cataloguer, and reviewer can save (not just lead)
  const memberships = await requireProjectRole(
    db,
    user.id,
    volume.projectId,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  const userRole = memberships[0]?.role ?? "cataloguer";

  // Check volume-level access: only "edit" or "review" can save
  const accessLevel = requireVolumeAccess(
    user.id,
    volume,
    userRole,
    user.isAdmin
  );

  if (accessLevel === "readonly") {
    return Response.json(
      { error: "You do not have edit access to this volume" },
      { status: 403 }
    );
  }

  // Parse and save entries
  let parsedEntries;
  try {
    parsedEntries = JSON.parse(entriesJson);
  } catch {
    return Response.json({ error: "Invalid entries JSON" }, { status: 400 });
  }

  try {
    await saveEntries(db, volumeId, parsedEntries);

    // Auto-transition: if volume is "unstarted", move to "in_progress"
    // Uses conditional UPDATE to handle race conditions atomically
    if (volume.status === "unstarted") {
      const result = await db
        .update(volumes)
        .set({ status: "in_progress", updatedAt: Date.now() })
        .where(
          and(eq(volumes.id, volumeId), eq(volumes.status, "unstarted"))
        );

      // Log the auto-transition
      await logActivity(db, user.id, "status_changed", {
        projectId: volume.projectId,
        volumeId,
        detail: JSON.stringify({
          from: "unstarted",
          to: "in_progress",
          auto: true,
        }),
      });
    }

    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * Accept corrections: clear all modifiedBy values for a volume's entries
 * and auto-transition from sent_back to in_progress.
 */
async function handleAcceptCorrections(
  db: ReturnType<typeof import("drizzle-orm/d1").drizzle>,
  userId: string,
  isAdmin: boolean,
  volumeId: string,
  deps: {
    eq: typeof import("drizzle-orm").eq;
    and: typeof import("drizzle-orm").and;
    isNotNull: typeof import("drizzle-orm").isNotNull;
    requireProjectRole: typeof import("../lib/permissions.server").requireProjectRole;
    requireVolumeAccess: typeof import("../lib/permissions.server").requireVolumeAccess;
    logActivity: typeof import("../lib/workflow.server").logActivity;
    volumes: typeof import("../db/schema").volumes;
    entries: typeof import("../db/schema").entries;
  }
) {
  const { eq, and, isNotNull, requireProjectRole, requireVolumeAccess, logActivity, volumes, entries } = deps;

  // Look up volume
  const volume = await db
    .select({
      projectId: volumes.projectId,
      status: volumes.status,
      assignedTo: volumes.assignedTo,
      assignedReviewer: volumes.assignedReviewer,
    })
    .from(volumes)
    .where(eq(volumes.id, volumeId))
    .get();

  if (!volume) {
    return Response.json({ error: "Volume not found" }, { status: 404 });
  }

  // Verify access: only the assigned cataloguer (or lead/admin) can accept corrections
  const memberships = await requireProjectRole(
    db,
    userId,
    volume.projectId,
    ["lead", "cataloguer"],
    isAdmin
  );

  const userRole = memberships[0]?.role ?? "cataloguer";
  const accessLevel = requireVolumeAccess(userId, volume, userRole, isAdmin);

  if (accessLevel !== "edit") {
    return Response.json(
      { error: "You do not have edit access to this volume" },
      { status: 403 }
    );
  }

  const now = Date.now();

  // Clear modifiedBy on all entries for this volume
  await db
    .update(entries)
    .set({
      modifiedBy: null,
      updatedAt: now,
    })
    .where(
      and(eq(entries.volumeId, volumeId), isNotNull(entries.modifiedBy))
    );

  // Auto-transition: sent_back -> in_progress
  if (volume.status === "sent_back") {
    await db
      .update(volumes)
      .set({ status: "in_progress", reviewComment: null, updatedAt: now })
      .where(and(eq(volumes.id, volumeId), eq(volumes.status, "sent_back")));

    await logActivity(db, userId, "status_changed", {
      projectId: volume.projectId,
      volumeId,
      detail: JSON.stringify({
        from: "sent_back",
        to: "in_progress",
        auto: true,
        action: "accept-corrections",
      }),
    });
  }

  return Response.json({ success: true });
}
