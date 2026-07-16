/**
 * QC Flags API
 *
 * This API endpoint is the back-end for the QC-flag workflow. POST
 * raises a new QC flag against a page; PATCH resolves an open flag.
 * Both routes are behind the project-role guard, and the PATCH
 * additionally enforces the lead-only resolver rule. GET lists open
 * flags for the requested volume or entry.
 *
 * @version v0.3.0
 */
import { userContext } from "../context";
import type { Route } from "./+types/api.qc-flags";
import {
  QC_PROBLEM_TYPES,
  QC_RESOLUTION_ACTIONS,
  PROJECT_ROLES,
} from "../lib/validation/enums";

// Canonical QC vocabularies live in validation/enums.ts so the schema
// column, this validator, and the UI cannot drift. Local aliases keep
// the call sites below readable.
const ALLOWED_PROBLEM_TYPES = QC_PROBLEM_TYPES;
const ALLOWED_RESOLUTION_ACTIONS = QC_RESOLUTION_ACTIONS;

// Subset of the qc-flag status enum: the statuses a flag may be resolved
// *to* (excludes "open"). Intentionally not the full enum.
const ALLOWED_RESOLVE_STATUSES = ["resolved", "wontfix"] as const;

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { requireProjectRole, requirePageAccess } = await import(
 "../lib/permissions.server"
  );
  const { createQcFlag, resolveQcFlag } = await import(
 "../lib/qc-flags.server"
  );
  const { logActivity } = await import("../lib/workflow.server");
  const { qcFlags, volumes, volumePages } = await import("../db/schema");
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

 // Pre-follow-up Zod shape: no region hint, no mutual exclusion.
 const CreateFlagSchema = z.object({
 volumeId: z
 .string({ error: "volumeId is required" })
 .min(1, "volumeId is required"),
 pageId: z
 .string({ error: "pageId is required" })
 .min(1, "pageId is required"),
 problemType: z.enum(ALLOWED_PROBLEM_TYPES, {
 error: "invalid problemType",
 }),
 description: z
 .string({ error: "description is required" })
 .min(1, "description is required"),
 });

 const parsed = CreateFlagSchema.safeParse(body);
 if (!parsed.success) {
 return Response.json(
 { error: parsed.error.issues[0]?.message ?? "Invalid body" },
 { status: 400 }
 );
 }

 const { volumeId, pageId, problemType, description } = parsed.data;

 try {
 // Access guard — any project member can raise a flag.
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

 // Membership check for role-gated access (the project role is
 // also the place where non-members get a 403). `requirePageAccess`
 // already performed the membership read indirectly; this explicit
 // call mirrors other mutation sites for parity.
 await requireProjectRole(
 db,
 user.id,
 volume.projectId,
 [...PROJECT_ROLES],
 user.isAdmin
 );

 const result = await createQcFlag(db, {
 volumeId,
 pageId,
 reportedBy: user.id,
 problemType,
 description,
 });

 // Derive pageLabel from volume_pages.position so the Messages feed
 // () can render "page {{pageLabel}}" without a join at read
 // time. We already passed requirePageAccess so the row exists.
 const [pageRow] = await db
 .select({ position: volumePages.position })
 .from(volumePages)
 .where(eq(volumePages.id, pageId))
 .limit(1)
 .all();
 const pageLabel = pageRow ? String(pageRow.position) : pageId;

 await logActivity(db, user.id, "qc_flag_raised", {
 projectId: volume.projectId,
 volumeId,
 detail: JSON.stringify({
 pageId,
 pageLabel,
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
 err instanceof Error ? err.message : "Failed to create QC flag";
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

 const { flagId, status, resolutionAction, resolverNote } = body ?? {};
 if (!flagId || !status || !resolutionAction) {
 return Response.json(
 { error: "flagId, status, and resolutionAction are required" },
 { status: 400 }
 );
 }
 if (!ALLOWED_RESOLVE_STATUSES.includes(status)) {
 return Response.json(
 { error: "status must be 'resolved' or 'wontfix'" },
 { status: 400 }
 );
 }
 if (!ALLOWED_RESOLUTION_ACTIONS.includes(resolutionAction)) {
 return Response.json(
 { error: "invalid resolutionAction" },
 { status: 400 }
 );
 }

 try {
 // Resolve the flag -> volume -> project server-side, THEN authorize
 // as a lead on that project. Client-supplied flagId is the only
 // input; projectId is derived. This prevents cross-project
 // elevation ().
 const [flag] = await db
 .select({
 id: qcFlags.id,
 volumeId: qcFlags.volumeId,
 pageId: qcFlags.pageId,
 })
 .from(qcFlags)
 .where(eq(qcFlags.id, flagId))
 .limit(1)
 .all();
 if (!flag) {
 return Response.json({ error: "Flag not found" }, { status: 404 });
 }

 const [volume] = await db
 .select({ id: volumes.id, projectId: volumes.projectId })
 .from(volumes)
 .where(eq(volumes.id, flag.volumeId))
 .limit(1)
 .all();
 if (!volume) {
 return Response.json(
 { error: "Volume not found" },
 { status: 404 }
 );
 }

 await requireProjectRole(
 db,
 user.id,
 volume.projectId,
 ["lead"],
 user.isAdmin
 );

 await resolveQcFlag(
 db,
 flagId,
 user.id,
 status,
 resolutionAction,
 resolverNote ?? null
 );

 const [pageRow] = await db
 .select({ position: volumePages.position })
 .from(volumePages)
 .where(eq(volumePages.id, flag.pageId))
 .limit(1)
 .all();
 const pageLabel = pageRow ? String(pageRow.position) : flag.pageId;

 await logActivity(db, user.id, "qc_flag_resolved", {
 projectId: volume.projectId,
 volumeId: flag.volumeId,
 detail: JSON.stringify({
 flagId,
 pageId: flag.pageId,
 pageLabel,
 resolutionAction,
 status,
 }),
 });

 return Response.json({ ok: true });
 } catch (err) {
 if (err instanceof Response) {
 const errText = await err.text();
 return Response.json({ error: errText }, { status: err.status });
 }
 const message =
 err instanceof Error ? err.message : "Failed to resolve QC flag";
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
  const { getQcFlagsForVolume } = await import("../lib/qc-flags.server");
  const { volumes } = await import("../db/schema");

  const user = context.get(userContext);
  const db = drizzle(context.cloudflare.env.DB);

  const url = new URL(request.url);
  const volumeId = url.searchParams.get("volumeId");
  const statusParam = url.searchParams.get("status");

  if (!volumeId) {
 return Response.json(
 { error: "volumeId query parameter is required" },
 { status: 400 }
 );
  }

  const allowedStatuses = ["open", "resolved", "wontfix"] as const;
  type QcStatusParam = (typeof allowedStatuses)[number];
  let statuses: QcStatusParam[] | undefined;
  if (statusParam) {
 if (!allowedStatuses.includes(statusParam as QcStatusParam)) {
 return Response.json(
 { error: "invalid status" },
 { status: 400 }
 );
 }
 statuses = [statusParam as QcStatusParam];
  }

  try {
 const [volume] = await db
 .select({ id: volumes.id, projectId: volumes.projectId })
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
 [...PROJECT_ROLES],
 user.isAdmin
 );

 const flags = await getQcFlagsForVolume(db, volumeId, { statuses });
 return Response.json({ flags });
  } catch (err) {
 if (err instanceof Response) {
 const errText = await err.text();
 return Response.json({ error: errText }, { status: err.status });
 }
 const message =
 err instanceof Error ? err.message : "Failed to load QC flags";
 return Response.json({ error: message }, { status: 500 });
  }
}

