/**
 * Project Root Redirect
 *
 * This route lands on `/projects/:id` and forwards the caller to the
 * project overview so the sidebar never surfaces a blank panel when a
 * project is selected.
 *
 * @version v0.3.0
 */

import { redirect } from "react-router";
import type { Route } from "./+types/_auth.projects.$id._index";

export function loader({ params }: Route.LoaderArgs) {
  // Redirect to overview kanban by default
  throw redirect(`/projects/${params.id}/overview`);
}
