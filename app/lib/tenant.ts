/**
 * Tenant Helpers
 *
 * This module deals with tenant-related runtime helpers. It carries
 * the two reserved UUID literals plus the request-boundary
 * primitives every authenticated route relies on:
 *
 *   - `getTenantFromRequest(db, request)` -- resolves the request
 *     `Host` header to a seeded `tenants` row. Three branches:
 *     legacy host `catalogacion.zasqua.org` (Neogranadina's
 *     pre-subdomain production host); subdomain hosts on
 *     `<slug>.localhost`, `<slug>.fisqua.test`, and
 *     `<slug>.fisqua.org` (slug looked up in `tenants.slug`); and
 *     unknown -- a bare `Response(null, {status: 404})` so no
 *     header or body leaks information about which slugs exist.
 *     Multi-level subdomains (`evil.neogranadina.fisqua.org`) are
 *     rejected by structural shape, not by lookup, to avoid host
 *     spoofing via DNS games.
 *
 *   - `hasCapability(tenant, cap)` / `requireCapability(tenant, cap)`
 *     -- the route-loader gates for the capability flags
 *     (`crowdsourcing`, `vocabulary_hub`, `publish_pipeline`,
 *     `multi_repository`, `authorities`). The `require` form throws a bare 404 so
 *     a disabled-capability surface looks identical to a missing
 *     route from the outside; v0.4 capabilities are operator-set
 *     and effectively immutable (multi-tenancy.md), so the "user
 *     bookmarked the route yesterday and it 404s today" scenario is
 *     not reachable.
 *
 *   - `isOperator(tenant)` / `assertOperator(tenant)` -- property
 *     check on `tenant.kind === "platform"`. The seeded `platform`
 *     row is the single operator-tenant; the schema CHECK on
 *     `tenants.kind` plus the rule that tenant-creation routes only
 *     accept `kind = "tenant"` keeps it single-row.
 *     `assertOperator` throws 403; used by `/operator/*` routes.
 *
 *   - `requireTenantUser(tenant, user)` -- single-equality assertion
 *     `user.tenantId === tenant.id` that 403s on mismatch. This is
 *     the runtime backstop the middleware calls right after
 *     resolving both the user and the tenant: a Neogranadina session
 *     reaching a `second-tenant.fisqua.test` URL (tenant-mismatch
 *     attack) is rejected before any loader sees the request.
 *
 *     `requireTenantUser` is default-deny: even operators get 403 on
 *     a tenant subdomain unless a route explicitly opts into the
 *     operator carve-out (`user.tenantId === PLATFORM_TENANT_ID &&
 *     route.allowsOperator`).
 *
 *   - `SlugSchema` -- Zod refinement for tenant-creation forms. The
 *     schema CHECK on `tenants.slug` already enforces the GLOB
 *     shape; the refinement adds the reserved-slug list (`platform`,
 *     `www`, `api`, `admin`, `app`) and length bounds. The operator
 *     tenant-create route is the first consumer.
 *
 * The two UUID literals (`PLATFORM_TENANT_ID`, `NEOGRANADINA_TENANT_ID`)
 * MUST match byte-for-byte the values in `0034_tenants_table.sql` and
 * the `0035_domain_table_tenant_ids.sql` back-fill INSERTs. Do not
 * regenerate either UUID; they are the schema-level identity of the
 * platform and Neogranadina rows and changing them silently breaks
 * the back-fill.
 *
 * v0.4 carve-outs documented in CONTEXT.md `<threat_model>`:
 *   - T-31-01-06 (suspended-tenant access): `getTenantFromRequest`
 *     does NOT yet gate on `tenants.status === "suspended"`. v0.4
 *     has no real suspended tenants; the gate ships alongside the
 *     operator soft-disable action.
 *   - T-31-01-07 (capability-off audit): not logged. `audit_log` is
 *     for operator actions touching tenant data; URL hits on
 *     disabled capabilities are not operator actions.
 *
 * @version v0.4.2
 */

import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
import { tenants } from "../db/schema";
import type { User, Tenant } from "../context";

export const PLATFORM_TENANT_ID = "0391baa2-0bab-44ae-ac08-9fa7eb7c6145" as const;
export const NEOGRANADINA_TENANT_ID = "c50bfa92-1223-4f00-ba15-d50c39ae3c0b" as const;
// AMPL — Archives, Memory, and Preservation Lab (UC Santa Barbara). Added
// 2026-05-02 as the second institutional tenant after Neogranadina. Slug
// 'ampl', all four capability flags ON, descriptive_standard 'isadg'.
export const AMPL_TENANT_ID = "8d235621-ae3b-4751-a241-20341efd6d3a" as const;
// AHR — Archivo Histórico de Rionegro. A member tenant of the
// Neogranadina federation (federation migration sequence step 6,
// migration 0051). Owns the co-ahr repository row and its descriptions;
// AHR crowdsourcing belongs to the Neogranadina lead tenant, not here
// (ruled). Slug 'ahr', descriptive_standard 'isadg'. Capability flags are
// all OFF: crowdsourcing OFF is ruled (AHR is catalogued collaboratively
// by the federation), the rest are conservative least-privilege
// placeholders that step 7 provisioning replaces with AHR's real profile.
// The literal MUST match drizzle/0051_partition_ahr_tenant.sql
// byte-for-byte.
export const AHR_TENANT_ID = "c82525bd-13d5-46dd-9c1b-e258507b966c" as const;

// SBMAL — Santa Barbara Mission Archive-Library. First member tenant of
// the AMPL federation (federation migration sequence step 7, migration
// 0056). Slug 'sbmal', descriptive_standard 'dacs'. Capability profile:
// vocabulary_hub ON (AMPL's own authority space, seeded from
// Neogranadina's canonical terms by the steward provisioning flow — the
// copy is deferred there, see 0056's header), crowdsourcing /
// publish_pipeline / multi_repository OFF. The literal MUST match
// drizzle/0056_provision_member_tenants.sql byte-for-byte.
export const SBMAL_TENANT_ID = "a0412263-176c-45be-96c7-6421c9d2ad51" as const;
// KOMUNI — Komuni (activist collective, Neogranadina/AMPL MEAP project).
// A member tenant of the Neogranadina federation (federation migration
// sequence step 7, migration 0056). Slug 'komuni', descriptive_standard
// 'isadg'. Capability profile identical to ahr: vocabulary_hub ON (shares
// Neogranadina's authority space), the other three OFF. The literal MUST
// match drizzle/0056_provision_member_tenants.sql byte-for-byte.
export const KOMUNI_TENANT_ID = "7f17a2e6-a673-454a-ad35-9e06acc02d90" as const;

// DACS test tenant — fixture for standard-toggle integration tests.
// Slug 'dacs-test', all four capability flags ON, descriptive_standard
// 'dacs'. UUID prefix '6...' chosen to avoid collision with
// OPERATOR_TEST_USER_ID (the '4...' octet); '5...' is reserved for
// impersonation-handoff fixtures. Production-distinct so query logs
// are debuggable.
export const DACS_TEST_TENANT_ID = "66666666-6666-4666-8666-666666666666" as const;

// RAD test tenant — same shape as DACS, descriptive_standard 'rad'.
// Standard-toggle integration tests fixture.
export const RAD_TEST_TENANT_ID = "77777777-7777-4777-8777-777777777777" as const;

// Federation identities (federation spec §2/§3, migration 0044). Each
// tenant belongs to exactly one federation; a standalone tenant is a
// federation of one. These three back the current tenant set:
//   - Neogranadina federation, lead = the neogranadina tenant.
//   - AMPL federation, lead = the ampl tenant (SBMAL joins as a member
//     in a later provisioning step).
//   - Platform federation-of-one, lead = the platform tenant.
// The literals MUST match drizzle/0044_federations.sql byte-for-byte —
// they are the schema-level identity of these federation rows.
// Neogranadina and AMPL ship with multiMemberEnabled ON; platform stays
// OFF (a degenerate federation-of-one that never gains members).
export const NEOGRANADINA_FEDERATION_ID = "b4462493-6170-44f8-ae07-24666606d1f1" as const;
export const AMPL_FEDERATION_ID = "113c1dab-e201-46fc-9620-0642131613ae" as const;
export const PLATFORM_FEDERATION_ID = "de8b3778-6aca-44f7-a849-f93efd27e542" as const;

/**
 * Reserved slugs that the tenant-creation route must reject. These
 * are the strings that would collide with the platform tenant
 * (`platform`), with the future operator subdomain (`app.fisqua.org`
 * as a possible operator entry point), or with common service
 * subdomain conventions (`www`, `api`, `admin`).
 */
export const RESERVED_SLUGS: ReadonlyArray<string> = [
  "platform",
  "www",
  "api",
  "admin",
  "app",
];

/**
 * Zod schema for validating tenant slugs at the application layer.
 * The schema's `.regex` mirrors the SQLite CHECK on `tenants.slug`
 * (lowercase ASCII, leading letter, no leading/trailing hyphen);
 * the `.refine` adds the reserved-slug ban.
 */
export const SlugSchema = z
  .string()
  .min(1, { message: "Slug must be at least 1 character" })
  .max(63, { message: "Slug must be at most 63 characters" })
  .regex(/^[a-z]([a-z0-9-]*[a-z0-9])?$/, {
    message:
      "Slug must be lowercase, start with a letter, and contain only letters, digits, and hyphens",
  })
  .refine((s) => !RESERVED_SLUGS.includes(s), {
    message: "Slug is reserved",
  });

/**
 * Legacy production host map. `catalogacion.zasqua.org` is the
 * pre-subdomain Fisqua URL (now Neogranadina-only); the production
 * cutover to `neogranadina.fisqua.org` shipped with subdomain routing.
 * Remove this branch when the legacy host is fully retired (deferred
 * to a v0.5 release-prep sweep).
 */
export const LEGACY_HOST_MAP: Readonly<Record<string, string>> = {
  "catalogacion.zasqua.org": "neogranadina",
};

/**
 * Recognised subdomain suffixes for slug-based tenant resolution.
 * Browsers resolve `*.localhost` to 127.0.0.1 by default (no DNS
 * setup needed for dev); `*.fisqua.test` is the test convention;
 * `*.fisqua.org` is the production subdomain. Each suffix is matched
 * with a leading `.` so a top-level host such as `fisqua.org` does
 * not accidentally resolve to an empty slug.
 */
export const SUBDOMAIN_HOST_SUFFIXES = [
  ".localhost",
  ".fisqua.test",
  ".fisqua.org",
] as const;

/**
 * Hosts that match a `SUBDOMAIN_HOST_SUFFIXES` strip pattern
 * structurally (e.g. `staging.fisqua.org` ends with `.fisqua.org`)
 * but must NOT be treated as tenant subdomains. Used for the
 * staging deploy's apex (`staging.fisqua.org`), which serves as a
 * deploy-smoke environment rather than hosting tenants.
 *
 * Staging is a sandbox/smoke environment, not a per-tenant mirror.
 * Per-tenant testing happens locally via `wrangler dev` +
 * `seed:dev-tenant`. So `staging.fisqua.org` is
 * apex-equivalent for the landing render and 404s on tenant-scoped
 * routes (correctly — there are no tenants on staging).
 *
 * `getTenantFromRequest` short-circuits to 404 for these hosts so a
 * tenant-scoped route on `staging.fisqua.org/<...>` returns the same
 * bare 404 as any other unknown host — no DB query, no leak.
 *
 * `isTenantHost` (in `app/routes/_index.tsx`) reuses this set to
 * route the apex landing on `staging.fisqua.org/` to the marketing
 * surface rather than redirecting into `/dashboard`.
 */
export const RESERVED_NON_TENANT_SUBDOMAINS: ReadonlySet<string> = new Set([
  "staging.fisqua.org",
  "staging.fisqua.test",
]);

/**
 * Legacy literal allowlist of pathnames reachable on the platform-
 * tenant host. Kept as `[]` for backward-compat (no caller depends on
 * it carrying entries); the actual operator-host gating delegates to
 * `OPERATOR_ROUTE_PREFIXES` below. Removing this export would be a
 * needless break of the v0.4 surface; widening the prefix list is the
 * supported way to expose new operator paths.
 */
export const OPERATOR_ROUTE_ALLOWLIST: ReadonlyArray<string> = [];

/**
 * Path prefixes reachable on the platform-tenant host. A prefix
 * matcher avoids enumerating every nested operator route as the
 * surface grows. The four entries are:
 *
 *   - `/login`               — operator login.
 *   - `/operator`            — every operator surface. Prefix-matched
 *                              so `/operator/tenants`,
 *                              `/operator/tenants/new`, and any
 *                              future nested route inherits the
 *                              allowance without enumeration churn.
 *   - `/end-impersonation`   — banner action; lives on tenant
 *                              subdomains in practice but listed
 *                              here for symmetry — the prefix on
 *                              platform host is a defence-in-depth
 *                              no-op (no real route at this prefix
 *                              on platform).
 *   - `/handoff/impersonation` — inbound from platform; the actual
 *                              route lives on tenant subdomains
 *                              (where the consume runs). On the
 *                              platform host this prefix is also a
 *                              defence-in-depth no-op.
 *
 * Matching shape: `pathname.startsWith(prefix)`. Each entry is an
 * absolute path; the `/` boundary makes `/operator` match
 * `/operator/...` and `/operator` itself but NOT `/operatorial`
 * (that would still 404 via the prefix-mismatch fall-through —
 * `startsWith("/operator")` actually does match `/operatorial`
 * unfortunately, so callers add a route-tree match downstream that
 * 404s anything not in the operator route file map; the prefix
 * here is the OUTER boundary, not the only check).
 */
export const OPERATOR_ROUTE_PREFIXES: ReadonlyArray<string> = [
  "/login",
  "/operator",
  "/end-impersonation",
  "/handoff/impersonation",
] as const;

/**
 * Asserts that requests on the platform tenant only reach allowlisted
 * paths. Throws `Response(null, {status: 404})` (bare body, no
 * enumeration leak) when the tenant is the platform tenant and the
 * path is neither in the legacy literal allowlist
 * (`OPERATOR_ROUTE_ALLOWLIST`, currently `[]`) nor a prefix-match
 * against `OPERATOR_ROUTE_PREFIXES`. The 404 is externally
 * indistinguishable from `getTenantFromRequest`'s unknown-host 404,
 * which is the structural mitigation that prevents the `platform`
 * slug from being enumerable.
 *
 * Dual-check shape: the legacy literal allowlist is kept as an empty
 * back-compat surface; `OPERATOR_ROUTE_PREFIXES` carries the actual
 * operator routes. A pathname passes if either branch admits it.
 * Future routes go in the prefix list.
 *
 * Called from `authMiddleware` between tenant resolution and
 * user/tenant alignment. The order matters: a 404 here must fire
 * before a 403 from `requireTenantUser` so a hostile authenticated
 * platform user cannot probe whether platform authentication
 * succeeds.
 */
export function assertNonPlatformOrAllowlisted(
  tenant: Tenant,
  pathname: string,
): void {
  if (tenant.kind !== "platform") return;
  if (OPERATOR_ROUTE_ALLOWLIST.includes(pathname)) return;
  for (const prefix of OPERATOR_ROUTE_PREFIXES) {
    if (pathname.startsWith(prefix)) return;
  }
  throw new Response(null, { status: 404 });
}

/**
 * The capability flag identifiers. Adding one here forces
 * `hasCapability`'s exhaustive switch to break compilation, which is
 * the intended fail-loud signal.
 */
export type Capability =
  | "crowdsourcing"
  | "vocabulary_hub"
  | "publish_pipeline"
  | "multi_repository"
  | "authorities";

/**
 * Returns the boolean value of the matching `*Enabled` field on
 * the tenant. Pure function; no DB. The exhaustive switch (no
 * `default`) is a compile-time guarantee that adding a new
 * `Capability` member without extending the switch is a type error.
 */
export function hasCapability(tenant: Tenant, cap: Capability): boolean {
  switch (cap) {
    case "crowdsourcing":
      return tenant.crowdsourcingEnabled;
    case "vocabulary_hub":
      return tenant.vocabularyHubEnabled;
    case "publish_pipeline":
      return tenant.publishPipelineEnabled;
    case "multi_repository":
      return tenant.multiRepositoryEnabled;
    case "authorities":
      return tenant.authoritiesEnabled;
  }
}

/**
 * Throws a bare 404 `Response` (no body, no leak) when the
 * capability is off. Drop into a route loader as the first
 * statement after `requireAdmin` / tenant-context read.
 */
export function requireCapability(tenant: Tenant, cap: Capability): void {
  if (!hasCapability(tenant, cap)) {
    throw new Response(null, { status: 404 });
  }
}

/**
 * Property-based operator check. Returns `true` only for the seeded
 * `platform` tenant row; every `kind: "tenant"` row -- including the
 * Neogranadina production tenant -- returns `false`.
 */
export function isOperator(tenant: Tenant): boolean {
  return tenant.kind === "platform";
}

/**
 * Throws a 403 `Response` when the tenant is not the operator
 * tenant. Used by `/operator/*` routes to gate access server-side
 * after the tenant context resolves.
 */
export function assertOperator(tenant: Tenant): void {
  if (!isOperator(tenant)) {
    throw new Response("Forbidden", { status: 403 });
  }
}

/**
 * Asserts that the user may act in the resolved tenant. Default-deny:
 * any mismatch throws 403 unless one of the two cross-tenant carve-outs
 * applies -- a federation grant, or the operator impersonation opt-in.
 *
 * Three admit paths, in order:
 *   (a) HOME access: `user.tenantId === tenant.id` (unchanged).
 *   (b) GRANT access: the caller passes a `grant` (resolved from
 *       `federation_memberships` by `app/lib/federation.server.ts`) whose
 *       `federationId` matches `tenant.federationId`, and the user is not
 *       already home (`tenant.id !== user.tenantId`). This is the
 *       federation-lead-staff-into-member-tenant path (spec §4). The
 *       helper trusts the caller (the middleware) to have looked the
 *       grant up FOR THIS tenant's federation and to have applied the
 *       liveness checks; the `federationId` re-match here is the
 *       structural belt-and-braces.
 *   (c) IMPERSONATION: the operator's user lives in the platform tenant;
 *       impersonation routes on tenant subdomains legitimately accept the
 *       operator when the caller sets `allowImpersonation: true`. It
 *       admits exactly `user.tenantId === PLATFORM_TENANT_ID &&
 *       tenant.kind === "tenant"` -- never an ordinary tenant user
 *       mismatching tenants.
 *
 * This helper is the SINGLE chokepoint for cross-tenant access. Do not
 * duplicate the check elsewhere; the auth middleware resolves the grant
 * and the impersonation envelope per-request and threads them in, and
 * every other caller receives default-deny.
 */
export function requireTenantUser(
  tenant: Tenant,
  user: User,
  options?: {
    allowImpersonation?: boolean;
    grant?: { federationId: string } | null;
  },
): void {
  // (a) Home access.
  if (user.tenantId === tenant.id) {
    return;
  }
  // (b) Federation grant access into a member tenant.
  if (
    options?.grant != null &&
    tenant.id !== user.tenantId &&
    options.grant.federationId === tenant.federationId
  ) {
    return;
  }
  // (c) Operator impersonation carve-out.
  if (
    options?.allowImpersonation === true &&
    user.tenantId === PLATFORM_TENANT_ID &&
    tenant.kind === "tenant"
  ) {
    return;
  }
  throw new Response("Forbidden", { status: 403 });
}

/**
 * Resolve a tenant from the request's `Host` header. Three branches
 * (legacy host map; subdomain suffix list; unknown -> 404). Host is
 * lowercased before any comparison so client-side casing variation
 * (`CATALOGACION.ZASQUA.ORG`) cannot bypass the legacy-host map.
 *
 * Multi-level subdomains are rejected structurally: after stripping
 * the suffix, if the remainder contains a `.`, the request is
 * 404'd. This blocks host-spoof attempts such as
 * `evil.neogranadina.fisqua.org` from resolving as the
 * `neogranadina` tenant.
 *
 * Soft-disable carve-out: when `loadTenantBySlug` resolves a tenant
 * whose `disabledAt` is non-null AND the request pathname does not
 * start with `/operator/`, the helper throws 404 (same shape as the
 * unknown-host branch). Operator routes carve out
 * so the operator can recover a disabled tenant from the operator
 * surface. The platform host never reaches this branch (Branch 1.5
 * + the subdomain logic resolves it differently); the carve-out is
 * specifically for tenant subdomains.
 */
export async function getTenantFromRequest(
  db: DrizzleD1Database<any>,
  request: Request,
): Promise<Tenant> {
  const host = new URL(request.url).hostname.toLowerCase();

  // Branch 1: legacy host map (exact-match lookup, never substring).
  const legacySlug = LEGACY_HOST_MAP[host];
  if (legacySlug) {
    return loadTenantBySlug(db, legacySlug, request);
  }

  // Branch 1.5: reserved infrastructure subdomains. `staging.fisqua.org`
  // structurally matches `.fisqua.org` but is the staging deploy's apex,
  // not a tenant. Short-circuit to bare 404 — same shape as the unknown-
  // host branch — so tenant-scoped routes on staging return 404 without
  // a DB query.
  if (RESERVED_NON_TENANT_SUBDOMAINS.has(host)) {
    throw new Response(null, { status: 404 });
  }

  // Branch 2: subdomain suffixes. Match the longest suffix first by
  // iterating the static list; each entry is a literal `.<suffix>`
  // so the leading-dot anchoring is implicit.
  for (const suffix of SUBDOMAIN_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const slug = host.slice(0, host.length - suffix.length);
      // Reject empty slug ("just the suffix") and multi-level
      // subdomains (slug containing a dot).
      if (slug.length === 0 || slug.includes(".")) {
        throw new Response(null, { status: 404 });
      }
      return loadTenantBySlug(db, slug, request);
    }
  }

  // Branch 3: unknown host -- bare 404, no header or body leak.
  throw new Response(null, { status: 404 });
}

async function loadTenantBySlug(
  db: DrizzleD1Database<any>,
  slug: string,
  request: Request,
): Promise<Tenant> {
  const row = await findTenantBySlug(db, slug);
  if (!row) {
    throw new Response(null, { status: 404 });
  }
  // A soft-disabled tenant subdomain hits 404 the same shape as an
  // unknown host. Operator routes carve out so the
  // operator can recover; everything else 404s. The check is
  // deliberately path-aware (not session-aware) — the resolver runs
  // before the user is loaded, so the only signal we have is the
  // request pathname.
  if (row.disabledAt !== null) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith("/operator/")) {
      throw new Response(null, { status: 404 });
    }
  }
  return row;
}

/**
 * Non-throwing tenant lookup. Returns the row if a tenant with the
 * given slug exists, `null` otherwise. Use this from contexts that
 * want to handle the miss as data (e.g. the apex picker action,
 * which surfaces a "no such workspace" inline error rather than
 * 404'ing). Resolver-style call sites that should short-circuit to
 * a bare 404 on miss should use `loadTenantBySlug` instead.
 */
export async function findTenantBySlug(
  db: DrizzleD1Database<any>,
  slug: string,
): Promise<Tenant | null> {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1)
    .all();
  return (row as Tenant | undefined) ?? null;
}

/**
 * Non-throwing tenant lookup by primary key. Mirrors
 * `findTenantBySlug` in shape but keys on `tenants.id`. Used by the
 * auth middleware and the wrong-workspace interstitial route to
 * resolve a user's home tenant from `users.tenantId` without a
 * second `findTenantBySlug` round-trip.
 */
export async function findTenantById(
  db: DrizzleD1Database<any>,
  id: string,
): Promise<Tenant | null> {
  const [row] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, id))
    .limit(1)
    .all();
  return (row as Tenant | undefined) ?? null;
}

/**
 * Build a fully-qualified tenant subdomain origin string from a
 * request URL and a target slug. The wrong-workspace interstitial
 * uses this to construct the "go to your <Name> workspace" CTA URL.
 *
 * Returns `null` when the current request host is not a recognised
 * subdomain host (legacy host map, reserved non-tenant subdomains,
 * raw apex). Callers treat `null` as "no interstitial possible, fall
 * through to the existing 403 / no-account behaviour" -- the host is
 * not one where we can sensibly construct a sibling-subdomain URL.
 *
 * Preserves protocol and port from the request URL so `wrangler dev`
 * (http, port 5173) and the vitest integration test environment
 * (http, port 8787) both construct correct URLs without environment
 * lookups.
 */
export function buildTenantOriginUrl(
  requestUrl: URL,
  targetSlug: string,
): string | null {
  const host = requestUrl.hostname.toLowerCase();
  for (const suffix of SUBDOMAIN_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      const port = requestUrl.port ? `:${requestUrl.port}` : "";
      return `${requestUrl.protocol}//${targetSlug}${suffix}${port}`;
    }
  }
  return null;
}
