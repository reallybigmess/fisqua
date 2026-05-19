/**
 * Comments API — Resolve
 *
 * This API endpoint accepts a POST that marks one comment thread as
 * resolved. Scoped to project leads and reviewers; it writes the
 * resolve timestamp and resolver id onto
 * the thread row so the audit trail survives.
 *
 * @version v0.3.0
 */
import { userContext } from "../context";
import type { Route } from "./+types/api.comments.$id.resolve";

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
 return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const commentId = params.id;
  if (!commentId) {
 return Response.json({ error: "Missing comment id" }, { status: 400 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireEntryAccess, requirePageAccess, requireProjectRole } =
 await import("../lib/permissions.server");
  const { resolveComment } = await import("../lib/comments.server");
  const { logActivity } = await import("../lib/workflow.server");
  const { z } = await import("zod");
  const { comments, volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  let body: any;
  try {
 body = await request.json();
  } catch {
 return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ResolveSchema = z.object({ resolved: z.boolean() }).strict();
  const parsed = ResolveSchema.safeParse(body);
  if (!parsed.success) {
 return Response.json(
 { error: parsed.error.issues[0]?.message ?? "Invalid body" },
 { status: 400 },
 );
  }
  const { resolved } = parsed.data;

  // Resolve project context from the comment's volume so we can run the
  // role gate before the state mutation.
  const [row] = await db
 .select({
 volumeId: comments.volumeId,
 pageId: comments.pageId,
 entryId: comments.entryId,
 })
 .from(comments)
 .where(eq(comments.id, commentId))
 .limit(1)
 .all();
  if (!row) {
 return Response.json({ error: "Comment not found" }, { status: 404 });
  }

  const [volume] = await db
 .select({ projectId: volumes.projectId })
 .from(volumes)
 .where(eq(volumes.id, row.volumeId))
 .limit(1)
 .all();
  if (!volume) {
 return Response.json({ error: "Volume not found" }, { status: 404 });
  }

  try {
 // Asymmetric role gate: resolve is any-editor, un-resolve is lead-only.
 const requiredRoles = resolved
 ? (["lead", "reviewer", "cataloguer"] as const)
 : (["lead"] as const);
 await requireProjectRole(
 db,
 user.id,
 volume.projectId,
 requiredRoles as any,
 user.isAdmin,
 );

 if (row.pageId) {
 await requirePageAccess(db, row.pageId, user.id, user.isAdmin);
 } else if (row.entryId) {
 await requireEntryAccess(db, row.entryId, user.id, user.isAdmin);
 }

 const result = await resolveComment(db, commentId, user.id, resolved);

 if (result.changed) {
 await logActivity(
 db,
 user.id,
 resolved ? "comment_resolved" : "comment_unresolved",
 {
 projectId: volume.projectId,
 volumeId: row.volumeId,
 detail: JSON.stringify({
 commentId,
 pageId: result.pageId,
 entryId: result.entryId,
 }),
 },
 );
 }

 return Response.json({ ok: true, changed: result.changed });
  } catch (err) {
 if (err instanceof Response) {
 const errText = await err.text();
 return Response.json({ error: errText }, { status: err.status });
 }
 const message =
 err instanceof Error ? err.message : "Failed to update resolve state";
 return Response.json({ error: message }, { status: 500 });
  }
}

