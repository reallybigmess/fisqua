/**
 * Descriptions Admin — Children API
 *
 * This API endpoint is a thin JSON surface the description tree and
 * Miller columns call to lazy-load the direct children of a given parent. Keeps the initial
 * page weight small by deferring deeper branches until the user expands
 * them, and avoids a full recursive CTE on every tree render.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. Repository, description-count, and child-list
 * queries are filtered by `tenant.id`.
 *
 * @version v0.4.0
 */

import type { Route } from "./+types/_auth.admin.descriptions.api.children.$parentId";
import { tenantContext, userContext } from "../context";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq, and, asc, sql } = await import("drizzle-orm");
  const { descriptions, repositories } = await import("~/db/schema");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);

  const db = drizzle(context.cloudflare.env.DB);
  const parentId = params.parentId;

  const selectFields = {
    id: descriptions.id,
    title: descriptions.title,
    referenceCode: descriptions.referenceCode,
    descriptionLevel: descriptions.descriptionLevel,
    dateExpression: descriptions.dateExpression,
    scopeContent: descriptions.scopeContent,
    childCount: descriptions.childCount,
    isPublished: descriptions.isPublished,
    position: descriptions.position,
    repositoryId: descriptions.repositoryId,
  };

  // Root → list repositories (with count of their depth-0 descriptions)
  if (parentId === "root") {
    const repos = await db
      .select({ id: repositories.id, name: repositories.name, code: repositories.code })
      .from(repositories)
      .where(eq(repositories.tenantId, tenant.id))
      .orderBy(asc(repositories.name))
      .all();

    // Count depth-0 descriptions per repository
    const counts = await db
      .select({
        repositoryId: descriptions.repositoryId,
        n: sql<number>`COUNT(*)`,
      })
      .from(descriptions)
      .where(
        and(eq(descriptions.tenantId, tenant.id), eq(descriptions.depth, 0))
      )
      .groupBy(descriptions.repositoryId)
      .all();
    const countByRepo = new Map(counts.map((c) => [c.repositoryId, Number(c.n)]));

    const items = repos.map((r, i) => ({
      id: `repo__${r.id}`,
      title: r.name,
      referenceCode: r.code ?? "",
      descriptionLevel: "repository",
      dateExpression: null,
      scopeContent: null,
      childCount: countByRepo.get(r.id) ?? 0,
      isPublished: true,
      position: i,
      repositoryId: r.id,
      kind: "repository" as const,
    }));
    return Response.json(items);
  }

  // repo__<uuid> → top-level descriptions (depth 0) for that repository
  if (parentId.startsWith("repo__")) {
    const repoId = parentId.slice(6);
    const roots = await db
      .select(selectFields)
      .from(descriptions)
      .where(
        and(
          eq(descriptions.tenantId, tenant.id),
          eq(descriptions.repositoryId, repoId),
          eq(descriptions.depth, 0)
        )
      )
      .orderBy(asc(descriptions.position))
      .all();
    return Response.json(roots);
  }

  const children = await db
    .select(selectFields)
    .from(descriptions)
    .where(
      and(eq(descriptions.tenantId, tenant.id), eq(descriptions.parentId, parentId))
    )
    .orderBy(asc(descriptions.position))
    .all();

  return Response.json(children);
}
