/**
 * Volume Workflow API
 *
 * This API endpoint is the volume-level status-transition spine.
 * Action-only — no loader, no component. POST accepts a form body
 * carrying `volumeId`, `projectId`, `targetStatus`, and an optional
 * `comment`, then delegates to `transitionVolumeStatus` which runs
 * the workflow state-machine check (only certain transitions are
 * allowed, only from certain roles), writes the new status to the
 * `volumes` row, and records an audit-log entry so the lead can see
 * who moved the volume and when.
 *
 * Submit-for-review dialogs, the lead's overview kanban, and the
 * reviewer footer actions all post here rather than mutating
 * `volumes` directly — keeping every status change behind one
 * guarded handler is what lets the state machine stay enforceable.
 *
 * @version v0.3.0
 */

import { userContext } from "../context";
import type { VolumeStatus, WorkflowRole } from "../lib/workflow";
import type { Route } from "./+types/api.workflow";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { transitionVolumeStatus } = await import("../lib/workflow.server");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const formData = await request.formData();
  const volumeId = formData.get("volumeId") as string;
  const projectId = formData.get("projectId") as string;
  const targetStatus = formData.get("targetStatus") as string;
  const comment = (formData.get("comment") as string) || undefined;

  if (!volumeId || !projectId || !targetStatus) {
    return Response.json(
      { ok: false, error: "volumeId, projectId, and targetStatus are required" },
      { status: 400 }
    );
  }

  // Get user's role on this project
  const memberships = await requireProjectRole(
    db,
    user.id,
    projectId,
    ["lead", "cataloguer", "reviewer"],
    user.isAdmin
  );

  const userRole: WorkflowRole =
    (memberships[0]?.role as WorkflowRole) ?? "cataloguer";

  try {
    await transitionVolumeStatus(
      db,
      volumeId,
      targetStatus as VolumeStatus,
      user.id,
      userRole,
      comment
    );
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Response) {
      const text = await err.text();
      return Response.json(
        { ok: false, error: text },
        { status: err.status }
      );
    }
    const message = err instanceof Error ? err.message : "Transition failed";
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
