/**
 * Comments API — Collection
 *
 * This API endpoint owns the comment-thread collection. POST creates
 * a new comment thread anchored to an entry or a region; GET lists
 * the threads for the requested entry. Every request is behind the
 * project-role guard so a cataloguer never sees a thread on a project
 * they do not belong to.
 *
 * @version v0.3.0
 */
import { userContext } from "../context";
import type { WorkflowRole } from "../lib/workflow";
import type { Route } from "./+types/api.comments";

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireEntryAccess, requirePageAccess, requireProjectRole } =
 await import("../lib/permissions.server");
  const { createComment } = await import("../lib/comments.server");
  const { logActivity } = await import("../lib/workflow.server");
  const { qcFlags, volumes } = await import("../db/schema");
  const { z } = await import("zod");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  if (request.method === "POST") {
 let body: any;
 try {
 body = await request.json();
 } catch {
 return Response.json({ error: "Invalid JSON body" }, { status: 400 });
 }

 const RegionSchema = z.object({
 x: z.number(),
 y: z.number(),
 w: z.number(),
 h: z.number(),
 });

 const CreateCommentSchema = z
 .object({
 volumeId: z.string().min(1),
 parentId: z.string().nullish(),
 text: z.string().min(1),
 entryId: z.string().optional(),
 pageId: z.string().optional(),
 qcFlagId: z.string().optional(),
 region: RegionSchema.optional(),
 })
 .refine(
 (v) =>
 [v.entryId, v.pageId, v.qcFlagId].filter((x) => Boolean(x)).length ===
 1,
 {
 message: "Exactly one of entryId, pageId, or qcFlagId must be set",
 }
 )
 // Check the more specific qcFlag-incompatibility BEFORE the
 // page-anchor rule so that `{region, qcFlagId}` surfaces the
 // meaningful "regions are comments-only on pages" error rather
 // than the generic "region requires pageId" one.
 .refine((v) => !(v.region && v.qcFlagId), {
 message:
 "region cannot be combined with qcFlagId (regions are comments-only on pages)",
 })
 .refine((v) => !(v.region && !v.pageId), {
 message: "region requires pageId (regions are page-anchored)",
 });

 const parsed = CreateCommentSchema.safeParse(body);
 if (!parsed.success) {
 return Response.json(
 { error: parsed.error.issues[0]?.message ?? "Invalid body" },
 { status: 400 }
 );
 }

 const { volumeId, parentId, text, entryId, pageId, qcFlagId, region } =
 parsed.data;

 try {
 let authorRole: WorkflowRole;
 let projectId: string;

 if (entryId) {
 const { member, volume } = await requireEntryAccess(
 db,
 entryId,
 user.id,
 user.isAdmin
 );
 if (volume.id !== volumeId) {
 return Response.json(
 { error: "volumeId does not match entry's volume" },
 { status: 400 }
 );
 }
 authorRole = (member?.role as WorkflowRole) ?? "cataloguer";
 projectId = volume.projectId;
 } else if (pageId) {
 const { volume } = await requirePageAccess(
 db,
 pageId,
 user.id,
 user.isAdmin
 );
 if (volume.id !== volumeId) {
 return Response.json(
 { error: "volumeId does not match page's volume" },
 { status: 400 }
 );
 }
 // requirePageAccess does not return the member row; resolve the
 // caller's effective role on the project so comments carry the
 // correct provenance on page-targeted posts too.
 const memberships = await requireProjectRole(
 db,
 user.id,
 volume.projectId,
 ["lead", "cataloguer", "reviewer"],
 user.isAdmin
 );
 const roleOrder: WorkflowRole[] = ["lead", "reviewer", "cataloguer"];
 authorRole =
 roleOrder.find((r) => memberships.some((m) => m.role === r)) ??
 "cataloguer";
 projectId = volume.projectId;
 } else {
 // qcFlag-targeted post. Resolve flag → volume → projectId server-
 // side; never trust a client-supplied projectId ().
 const [flag] = await db
 .select({ id: qcFlags.id, volumeId: qcFlags.volumeId })
 .from(qcFlags)
 .where(eq(qcFlags.id, qcFlagId!))
 .limit(1)
 .all();
 if (!flag) {
 return Response.json(
 { error: "QC flag not found" },
 { status: 404 }
 );
 }

 const [volume] = await db
 .select({ id: volumes.id, projectId: volumes.projectId })
 .from(volumes)
 .where(eq(volumes.id, flag.volumeId))
 .limit(1)
 .all();
 if (!volume) {
 return Response.json(
 { error: "Volume not found for flag" },
 { status: 404 }
 );
 }
 if (volume.id !== volumeId) {
 return Response.json(
 { error: "volumeId does not match flag's volume" },
 { status: 400 }
 );
 }

 const memberships = await requireProjectRole(
 db,
 user.id,
 volume.projectId,
 ["lead", "cataloguer", "reviewer"],
 user.isAdmin
 );
 const roleOrder: WorkflowRole[] = ["lead", "reviewer", "cataloguer"];
 authorRole =
 roleOrder.find((r) => memberships.some((m) => m.role === r)) ??
 "cataloguer";
 projectId = volume.projectId;
 }

 const result = await createComment(db, {
 target: entryId
 ? { kind: "entry", entryId }
 : pageId
 ? { kind: "page", pageId, region: region ?? null }
 : { kind: "qcFlag", qcFlagId: qcFlagId! },
 volumeId,
 parentId: parentId ?? null,
 authorId: user.id,
 authorRole,
 text,
 });

 // Log activity. The event literal stays `comment_added`; the detail
 // blob carries whichever target id is set so the Messages feed can
 // render the correct link on replay. Region coords flow through so
 // downstream renderers can highlight the pin when revisited.
 await logActivity(db, user.id, "comment_added", {
 projectId,
 volumeId,
 detail: JSON.stringify({
 ...(entryId ? { entryId } : {}),
 ...(pageId ? { pageId } : {}),
 ...(qcFlagId ? { qcFlagId } : {}),
 ...(region ? { region } : {}),
 commentId: result.id,
 }),
 });

 return Response.json({ ok: true, commentId: result.id });
 } catch (err) {
 if (err instanceof Response) {
 const errText = await err.text();
 return Response.json({ error: errText }, { status: err.status });
 }
 const message =
 err instanceof Error ? err.message : "Failed to create comment";
 return Response.json({ error: message }, { status: 500 });
 }
  }

  // the collection DELETE branch was retired in favour of
  // REST-y `DELETE /api/comments/:id` in `api.comments.$id.tsx`. The
  // new endpoint supports soft-delete + cascade-on-root and the
  // author-or-lead gate.

  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (request.method !== "GET") {
 return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { drizzle } = await import("drizzle-orm/d1");
  const { requireEntryAccess, requirePageAccess } = await import(
 "../lib/permissions.server"
  );
  const { getCommentsForEntry, getCommentsForPage } = await import(
 "../lib/comments.server"
  );

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");
  const pageId = url.searchParams.get("pageId");

  if (Boolean(entryId) === Boolean(pageId)) {
 return Response.json(
 {
 error:
 "Exactly one of entryId or pageId query parameter is required",
 },
 { status: 400 }
 );
  }

  try {
 if (entryId) {
 await requireEntryAccess(db, entryId, user.id, user.isAdmin);
 const comments = await getCommentsForEntry(db, entryId);
 return Response.json({ comments });
 }

 await requirePageAccess(db, pageId!, user.id, user.isAdmin);
 const comments = await getCommentsForPage(db, pageId!);
 return Response.json({ comments });
  } catch (err) {
 if (err instanceof Response) {
 const errText = await err.text();
 return Response.json({ error: errText }, { status: err.status });
 }
 const message =
 err instanceof Error ? err.message : "Failed to load comments";
 return Response.json({ error: message }, { status: 500 });
  }
}

