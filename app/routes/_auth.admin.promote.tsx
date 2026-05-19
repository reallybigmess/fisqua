/**
 * Legacy Promote Redirect
 *
 * This route is the legacy crowdsourcing promotion URL. It issues a
 * 301 to the new path under `/admin/cataloguing/promote` so existing
 * bookmarks keep working.
 *
 * Capability gate runs before the redirect. Even on a redirect
 * route, `requireCapability(tenant, "publish_pipeline")` runs first
 * so a `publish_pipeline=off` tenant 404s here rather than chasing
 * the 301 into a (separately gated) `/admin/cataloguing/promote`
 * surface. Promote bridges crowdsourcing and the publish pipeline;
 * the sidebar's capability gate also requires `publish_pipeline` to
 * be on, so the 404 here keeps the structural surface aligned with
 * the UX surface.
 *
 * @version v0.4.0
 */

import { redirect } from "react-router";
import { tenantContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.promote";

export function loader({ context }: Route.LoaderArgs) {
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "publish_pipeline");
  return redirect("/admin/cataloguing/promote", 301);
}
