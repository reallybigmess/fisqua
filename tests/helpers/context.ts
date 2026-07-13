/**
 * Tests — context
 *
 * This module deals with lightweight builders that return objects
 * matching the runtime shapes of `userContext` and `tenantContext`
 * from `app/context.ts`.
 * Tests that exercise pure helpers (`hasCapability`,
 * `requireCapability`, `isOperator`, `requireTenantUser`) need to
 * pass a `User` or `Tenant` value without spinning up the real
 * `authMiddleware` or hitting D1 -- these factories produce that
 * value with safe defaults that callers override field-by-field.
 *
 * `makeUserContext` defaults every role flag to `false`, defaults
 * `tenantId` to `DEFAULT_TEST_TENANT_ID` (the seeded Neogranadina
 * row), and accepts a `Partial<User>` to override any field.
 *
 * `makeTenantContext` defaults to a `kind: "tenant"` row with all
 * four capability flags ON (matching the Neogranadina seed) and
 * `descriptiveStandard: "isadg"`. Pass overrides to flip
 * capabilities, change `kind` to `"platform"` (operator carve-out
 * tests), or seed a different tenant id.
 *
 * Neither helper writes to D1 or invokes React Router middleware;
 * they just return plain objects. Tests that need real middleware
 * round-trip should use the integration scaffolding in
 * `tests/middleware/auth.test.ts` instead.
 *
 * @version v0.4.2
 */
import type { User, Tenant } from "../../app/context";
import { DEFAULT_TEST_TENANT_ID } from "./db";
import { NEOGRANADINA_FEDERATION_ID } from "../../app/lib/tenant";

/**
 * Build a `User` value with safe defaults for tests. Override any
 * field via the `overrides` argument; missing fields fall back to
 * the v0.3 baseline (every role flag false, no GitHub link, no
 * lastActiveAt) plus `tenantId = DEFAULT_TEST_TENANT_ID`.
 */
export function makeUserContext(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? "test-user-id",
    tenantId: overrides.tenantId ?? DEFAULT_TEST_TENANT_ID,
    email: overrides.email ?? "test@example.com",
    name: overrides.name ?? null,
    isAdmin: overrides.isAdmin ?? false,
    isSuperAdmin: overrides.isSuperAdmin ?? false,
    isCollabAdmin: overrides.isCollabAdmin ?? false,
    isArchiveUser: overrides.isArchiveUser ?? false,
    isUserManager: overrides.isUserManager ?? false,
    isCataloguer: overrides.isCataloguer ?? false,
    lastActiveAt: overrides.lastActiveAt ?? null,
    githubId: overrides.githubId ?? null,
  };
}

/**
 * Build a `Tenant` value matching the seeded Neogranadina row by
 * default (kind="tenant", all four capabilities ON, isadg
 * descriptive standard, active status). Override any field via the
 * `overrides` argument; common test patterns include flipping
 * `crowdsourcingEnabled` to false (capability-off route 404 cases)
 * and switching `kind` to `"platform"` (operator carve-out cases).
 */
export function makeTenantContext(overrides: Partial<Tenant> = {}): Tenant {
  const now = Date.now();
  return {
    id: overrides.id ?? DEFAULT_TEST_TENANT_ID,
    slug: overrides.slug ?? "neogranadina",
    name: overrides.name ?? "Neogranadina",
    kind: overrides.kind ?? "tenant",
    descriptiveStandard: overrides.descriptiveStandard ?? "isadg",
    status: overrides.status ?? "active",
    crowdsourcingEnabled: overrides.crowdsourcingEnabled ?? true,
    vocabularyHubEnabled: overrides.vocabularyHubEnabled ?? true,
    publishPipelineEnabled: overrides.publishPipelineEnabled ?? true,
    multiRepositoryEnabled: overrides.multiRepositoryEnabled ?? true,
    authoritiesEnabled: overrides.authoritiesEnabled ?? true,
    quotaStorageBytes: overrides.quotaStorageBytes ?? null,
    disabledAt: overrides.disabledAt ?? null,
    federationId: overrides.federationId ?? NEOGRANADINA_FEDERATION_ID,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}
