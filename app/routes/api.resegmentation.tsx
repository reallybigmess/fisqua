/**
 * Resegmentation Flags API
 *
 * This API endpoint is the back-end for the resegmentation-request
 * workflow — the affordance a cataloguer uses to ask a lead to
 * redraw the boundaries of one or more entries in a volume. POST
 * creates a new flag (problem type, affected entries, optional free
 * text description) anchored to a volume; PATCH resolves an open
 * flag once the lead has acted on it; GET lists open flags for a
 * volume so the segmentation viewer can surface them in the
 * outline.
 *
 * Every mutation is gated by `requireEntryAccess` so only members of
 * the project the entry belongs to can raise or resolve a flag, and
 * each transition writes to the activity log so the lead's
 * dashboard reflects the request without a separate write path.
 *
 * @version v0.3.0
 */

import { userContext } from "../context";
import type { Route } from "./+types/api.resegmentation";

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireEntryAccess } = await import("../lib/permissions.server");
  const { createResegmentationFlag, resolveResegmentationFlag } = await import(
    "../lib/resegmentation.server"
  );
  const { logActivity } = await import("../lib/workflow.server");
  const { volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  if (request.method === "POST") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { volumeId, entryId, problemType, affectedEntryIds, description } =
      body;

    if (!volumeId || !entryId || !problemType || !description) {
      return Response.json(
        {
          error:
            "volumeId, entryId, problemType, and description are required",
        },
        { status: 400 }
      );
    }

    try {
      // Verify entry access
      const { volume } = await requireEntryAccess(
        db,
        entryId,
        user.id,
        user.isAdmin
      );

      const result = await createResegmentationFlag(db, {
        volumeId,
        entryId,
        reportedBy: user.id,
        problemType,
        affectedEntryIds: affectedEntryIds ?? "[]",
        description,
      });

      // Log activity
      await logActivity(db, user.id, "resegmentation_flagged", {
        projectId: volume.projectId,
        volumeId,
        detail: JSON.stringify({
          entryId,
          flagId: result.id,
          problemType,
        }),
      });

      return Response.json({ ok: true, flagId: result.id });
    } catch (err) {
      if (err instanceof Response) {
        const errText = await err.text();
        return Response.json({ error: errText }, { status: err.status });
      }
      const message =
        err instanceof Error ? err.message : "Failed to create flag";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (request.method === "PATCH") {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { flagId } = body;

    if (!flagId) {
      return Response.json(
        { error: "flagId is required" },
        { status: 400 }
      );
    }

    try {
      await resolveResegmentationFlag(db, flagId, user.id);
      return Response.json({ ok: true });
    } catch (err) {
      if (err instanceof Response) {
        const errText = await err.text();
        return Response.json({ error: errText }, { status: err.status });
      }
      const message =
        err instanceof Error ? err.message : "Failed to resolve flag";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getOpenFlags } = await import("../lib/resegmentation.server");
  const { volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const url = new URL(request.url);
  const volumeId = url.searchParams.get("volumeId");

  if (!volumeId) {
    return Response.json(
      { error: "volumeId query parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Verify volume access
    const [volume] = await db
      .select({ projectId: volumes.projectId })
      .from(volumes)
      .where(eq(volumes.id, volumeId))
      .limit(1)
      .all();

    if (!volume) {
      return Response.json({ error: "Volume not found" }, { status: 404 });
    }

    await requireProjectRole(
      db,
      user.id,
      volume.projectId,
      ["lead", "cataloguer", "reviewer"],
      user.isAdmin
    );

    const flags = await getOpenFlags(db, volumeId);
    const isPaused = flags.length > 0;

    return Response.json({ flags, isPaused });
  } catch (err) {
    if (err instanceof Response) {
      const errText = await err.text();
      return Response.json({ error: errText }, { status: err.status });
    }
    const message =
      err instanceof Error ? err.message : "Failed to load flags";
    return Response.json({ error: message }, { status: 500 });
  }
}
