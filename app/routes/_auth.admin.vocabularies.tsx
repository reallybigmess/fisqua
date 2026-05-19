/**
 * Vocabularies Hub Layout
 *
 * This layout is the parent route for the vocabularies admin
 * subsection. It renders the secondary navigation between Enums,
 * Functions, and Review, loads
 * the shared counts panel, and routes each child page into the
 * shared layout.
 *
 * Layout-level capability gate. The loader calls
 * `requireCapability(tenant, "vocabulary_hub")` immediately after the
 * admin guard, throwing a bare `Response(null, {status: 404})` when
 * the tenant's `vocabulary_hub` flag is off. Pairs with the
 * sidebar's capability gate as belt-and-braces against direct-URL
 * access.
 *
 * @version v0.4.0
 */

import { Outlet } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import type { Route } from "./+types/_auth.admin.vocabularies";

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("../lib/permissions.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "vocabulary_hub");

  return { user };
}

export default function AdminVocabulariesLayout() {
  return <Outlet />;
}
