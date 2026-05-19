/**
 * Operator — Tenant Detail
 *
 * This page renders GET `/operator/tenants/:slug` — the tenant
 * overview, the capabilities edit form, the role-picker for
 * login-as, and the
 * danger-zone (soft-disable / re-enable). The platform tenant detail
 * page hides every editable surface; only the overview is shown — the
 * operator never impersonates INTO themselves and soft-disabling the
 * platform tenant would lock the operator out.
 *
 * POST is a multi-intent action handler that switches over `intent`:
 *
 *   - `set_capability` — diff submitted vs current capabilities; if
 *     non-empty, write a `set_capability` audit row carrying the change
 *     list in `details.changes`. No-ops (no flips) skip the audit
 *     write entirely so an idempotent submission produces no DB churn.
 *   - `soft_disable`   — confirmSlug must equal the URL slug (a
 *     simple anti-misclick guard); writes `disabled_at = now` + a
 *     `soft_disable_tenant` audit row. The platform tenant rejects
 *     this with 400 — operator does not lock themselves out.
 *   - `re_enable`      — clears `disabled_at`. The audit row uses the
 *     `set_capability` action (deliberate repurposing: avoid amending
 *     the audit_log enum invariant) and carries
 *     `details.capabilityChanged='re_enable_tenant'` so audit-UI
 *     consumers can distinguish re-enable from a real capability flip.
 *
 * Each `case` arm wraps its DB writes in `withAuditLog` exactly once
 * — the audit-coverage CI keystone enforces this per-arm. Splitting
 * the work across multiple batches would defeat atomicity; a
 * single-batch arm with a wrapper is the only allowed shape.
 *
 * The role-picker form's POST target is
 * `/operator/tenants/:slug/login-as`.
 *
 * @version v0.4.0
 */

import { Form, useLoaderData, useActionData } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { tenants } from "../db/schema";
import { PLATFORM_TENANT_ID } from "../lib/tenant";
import { withAuditLog } from "../lib/audit.server";
import {
  SetCapabilitySchema,
  SoftDisableSchema,
  diffCapabilities,
} from "../lib/operator-actions.server";
import { userContext } from "../context";
import type { Route } from "./+types/_operator.tenants.$slug";

export async function loader({ params, context }: Route.LoaderArgs) {
  const env = (context as any).cloudflare.env;
  const db = drizzle(env.DB);
  // Cross-tenant read by design — operator surface; no `where(tenantId, ...)`
  // predicate needed (the cross-tenant keystone deliberately scopes
  // out _operator.* routes).
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, params.slug))
    .limit(1)
    .all();
  if (!tenant) {
    throw new Response(null, { status: 404 });
  }

  // Management flags — the platform tenant gets every editable surface
  // suppressed (operators do not lock themselves out). canDisable is
  // suppressed for both the platform tenant AND any tenant already
  // disabled (the latter shows the re-enable form via canReEnable
  // instead).
  const isPlatform = tenant.kind === "platform";
  const isDisabled = tenant.disabledAt !== null;
  return {
    tenant,
    canEdit: !isPlatform,
    canImpersonate: !isPlatform && !isDisabled,
    canDisable: !isPlatform && !isDisabled,
    canReEnable: !isPlatform && isDisabled,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const env = (context as any).cloudflare.env;
  const db = drizzle(env.DB);
  const user = context.get(userContext);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, params.slug))
    .limit(1)
    .all();
  if (!tenant) {
    throw new Response(null, { status: 404 });
  }

  // Defence-in-depth: the platform tenant cannot be the target of any
  // multi-intent write. The component-side suppression (canEdit /
  // canDisable / canImpersonate all false on platform) is the primary
  // gate; this guard catches a hostile direct-POST that bypasses the
  // UI affordances.
  if (tenant.kind === "platform") {
    return new Response("Cannot modify platform tenant", { status: 400 });
  }

  switch (intent) {
    case "set_capability": {
      const parsed = SetCapabilitySchema.safeParse(
        Object.fromEntries(formData),
      );
      if (!parsed.success) {
        return { fieldErrors: parsed.error.flatten().fieldErrors };
      }
      const changes = diffCapabilities(
        {
          crowdsourcingEnabled: tenant.crowdsourcingEnabled as unknown as boolean,
          vocabularyHubEnabled: tenant.vocabularyHubEnabled as unknown as boolean,
          publishPipelineEnabled: tenant.publishPipelineEnabled as unknown as boolean,
          multiRepositoryEnabled: tenant.multiRepositoryEnabled as unknown as boolean,
        },
        {
          crowdsourcingEnabled: parsed.data.crowdsourcingEnabled,
          vocabularyHubEnabled: parsed.data.vocabularyHubEnabled,
          publishPipelineEnabled: parsed.data.publishPipelineEnabled,
          multiRepositoryEnabled: parsed.data.multiRepositoryEnabled,
        },
      );
      if (changes.length === 0) {
        // Idempotent submission — no audit row, no DB churn. The
        // "Audit failure rolls back work" rule only applies when
        // there IS work; an empty diff is no work. The keystone
        // scanner allows zero wrappers per case arm because `case`
        // arms may legitimately no-op.
        return { saved: true, noop: true };
      }
      const now = Date.now();
      await withAuditLog(
        db,
        {
          action: "set_capability",
          actorUserId: user.id,
          actorUserIdText: user.email,
          actorTenantId: PLATFORM_TENANT_ID,
          targetTenantId: tenant.id,
          targetObjectKind: "tenant",
          targetObjectId: tenant.id,
          details: { slug: tenant.slug, changes },
          now,
        },
        async (txDb) => {
          const update = txDb
            .update(tenants)
            .set({
              crowdsourcingEnabled: parsed.data.crowdsourcingEnabled,
              vocabularyHubEnabled: parsed.data.vocabularyHubEnabled,
              publishPipelineEnabled: parsed.data.publishPipelineEnabled,
              multiRepositoryEnabled: parsed.data.multiRepositoryEnabled,
              updatedAt: now,
            })
            .where(eq(tenants.id, tenant.id));
          return {
            workStatements: [update],
            result: { saved: true, changes },
          };
        },
      );
      return { saved: true, noop: false };
    }

    case "soft_disable": {
      const parsed = SoftDisableSchema.safeParse(
        Object.fromEntries(formData),
      );
      if (!parsed.success || parsed.data.confirmSlug !== tenant.slug) {
        return {
          fieldErrors: { confirmSlug: ["confirm_slug_mismatch"] },
        };
      }
      const now = Date.now();
      await withAuditLog(
        db,
        {
          action: "soft_disable_tenant",
          actorUserId: user.id,
          actorUserIdText: user.email,
          actorTenantId: PLATFORM_TENANT_ID,
          targetTenantId: tenant.id,
          targetObjectKind: "tenant",
          targetObjectId: tenant.id,
          details: { slug: tenant.slug, action: "disable" },
          now,
        },
        async (txDb) => {
          const update = txDb
            .update(tenants)
            .set({ disabledAt: now, updatedAt: now })
            .where(eq(tenants.id, tenant.id));
          return {
            workStatements: [update],
            result: { disabled: true },
          };
        },
      );
      return { disabled: true };
    }

    case "re_enable": {
      // The re-enable transition is audited as `set_capability`
      // rather than introducing a new `re_enable_tenant` enum value
      // (which would amend the audit_log.action CHECK invariant).
      // The details payload carries
      // `capabilityChanged='re_enable_tenant'` so audit-UI consumers
      // can distinguish re-enable from a real capability flip.
      const now = Date.now();
      await withAuditLog(
        db,
        {
          action: "set_capability",
          actorUserId: user.id,
          actorUserIdText: user.email,
          actorTenantId: PLATFORM_TENANT_ID,
          targetTenantId: tenant.id,
          targetObjectKind: "tenant",
          targetObjectId: tenant.id,
          details: {
            slug: tenant.slug,
            capabilityChanged: "re_enable_tenant",
            from: "disabled",
            to: "active",
          },
          now,
        },
        async (txDb) => {
          const update = txDb
            .update(tenants)
            .set({ disabledAt: null, updatedAt: now })
            .where(eq(tenants.id, tenant.id));
          return {
            workStatements: [update],
            result: { reenabled: true },
          };
        },
      );
      return { reenabled: true };
    }

    default:
      return new Response("Unknown intent", { status: 400 });
  }
}

const ROLE_FLAGS = [
  "isAdmin",
  "isSuperAdmin",
  "isCollabAdmin",
  "isArchiveUser",
  "isUserManager",
  "isCataloguer",
] as const;

interface ActionData {
  saved?: boolean;
  noop?: boolean;
  disabled?: boolean;
  reenabled?: boolean;
  fieldErrors?: Record<string, string[] | undefined>;
}

export default function TenantDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as ActionData | undefined;
  const { t } = useTranslation("operator");
  const { tenant, canEdit, canImpersonate, canDisable, canReEnable } = data;

  return (
    <section className="max-w-3xl space-y-8">
      <header>
        <h1 className="font-display text-2xl font-semibold text-stone-900">
          {t("tenant_detail.page_title", { name: tenant.name })}
        </h1>
      </header>

      {/* Overview — visible for every tenant, including platform. */}
      <section className="space-y-2">
        <h2 className="font-display text-lg font-semibold text-stone-800">
          {t("tenant_detail.sections.overview")}
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 font-sans text-sm">
          <dt className="text-stone-500">{t("tenant_detail.overview.slug")}</dt>
          <dd className="font-mono text-stone-900">{tenant.slug}</dd>
          <dt className="text-stone-500">{t("tenant_detail.overview.kind")}</dt>
          <dd className="text-stone-900">{tenant.kind}</dd>
          <dt className="text-stone-500">
            {t("tenant_detail.overview.descriptive_standard")}
          </dt>
          <dd className="text-stone-900">{tenant.descriptiveStandard ?? "—"}</dd>
          <dt className="text-stone-500">
            {t("tenant_detail.overview.created_at")}
          </dt>
          <dd className="text-stone-900">
            {new Date(tenant.createdAt).toISOString()}
          </dd>
          {tenant.disabledAt !== null ? (
            <>
              <dt className="text-stone-500">
                {t("tenant_detail.overview.disabled_at")}
              </dt>
              <dd className="text-rust">
                {new Date(tenant.disabledAt).toISOString()}
              </dd>
            </>
          ) : null}
        </dl>
      </section>

      {canEdit ? (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-semibold text-stone-800">
            {t("tenant_detail.sections.capabilities")}
          </h2>
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="set_capability" />
            <div className="grid grid-cols-2 gap-2 font-sans text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="crowdsourcingEnabled"
                  value="true"
                  defaultChecked={
                    tenant.crowdsourcingEnabled as unknown as boolean
                  }
                />
                <span>{t("tenants_list.capabilities.crowdsourcing")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="vocabularyHubEnabled"
                  value="true"
                  defaultChecked={
                    tenant.vocabularyHubEnabled as unknown as boolean
                  }
                />
                <span>{t("tenants_list.capabilities.vocabulary_hub")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="publishPipelineEnabled"
                  value="true"
                  defaultChecked={
                    tenant.publishPipelineEnabled as unknown as boolean
                  }
                />
                <span>{t("tenants_list.capabilities.publish_pipeline")}</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="multiRepositoryEnabled"
                  value="true"
                  defaultChecked={
                    tenant.multiRepositoryEnabled as unknown as boolean
                  }
                />
                <span>{t("tenants_list.capabilities.multi_repository")}</span>
              </label>
            </div>
            <button
              type="submit"
              className="rounded bg-verdigris px-4 py-2 font-sans text-sm font-medium text-white hover:bg-verdigris/90"
            >
              {t("tenant_detail.capabilities_form.submit")}
            </button>
            {actionData?.saved ? (
              <p className="font-sans text-sm text-verdigris">
                {t("tenant_detail.capabilities_form.success")}
              </p>
            ) : null}
          </Form>
        </section>
      ) : null}

      {canImpersonate ? (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-semibold text-stone-800">
            {t("tenant_detail.sections.impersonate")}
          </h2>
          {/*
            Role-picker for the login-as flow. The form POSTs to
            `/operator/tenants/:slug/login-as`.
          */}
          <Form
            method="post"
            action={`/operator/tenants/${tenant.slug}/login-as`}
            className="space-y-3"
          >
            <fieldset>
              <legend className="block font-sans text-sm font-medium text-indigo">
                {t("tenant_detail.impersonate_form.role_legend")}
              </legend>
              <div className="mt-2 grid grid-cols-2 gap-2 font-sans text-sm">
                {ROLE_FLAGS.map((role) => (
                  <label key={role} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="target_role"
                      value={role}
                      required
                    />
                    <span className="font-mono">{role}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label
                htmlFor="reason"
                className="block font-sans text-sm font-medium text-indigo"
              >
                {t("tenant_detail.impersonate_form.reason_label")}
              </label>
              <textarea
                id="reason"
                name="reason"
                rows={2}
                className="mt-1 block w-full rounded border border-stone-300 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
              />
              <p className="mt-1 font-sans text-xs text-stone-500">
                {t("tenant_detail.impersonate_form.reason_help")}
              </p>
            </div>
            <button
              type="submit"
              className="rounded bg-indigo px-4 py-2 font-sans text-sm font-medium text-white hover:bg-indigo/90"
            >
              {t("tenant_detail.impersonate_form.submit", { role: "..." })}
            </button>
          </Form>
        </section>
      ) : null}

      {canDisable ? (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-semibold text-rust">
            {t("tenant_detail.sections.danger_zone")}
          </h2>
          <p className="font-sans text-sm text-stone-700">
            {t("tenant_detail.soft_disable.help")}
          </p>
          <Form method="post" className="space-y-2">
            <input type="hidden" name="intent" value="soft_disable" />
            <label
              htmlFor="confirmSlug"
              className="block font-sans text-sm font-medium text-stone-700"
            >
              {t("tenant_detail.soft_disable.confirm_disable", {
                slug: tenant.slug,
              })}
            </label>
            <input
              id="confirmSlug"
              name="confirmSlug"
              type="text"
              required
              className="block h-10 w-full rounded border border-stone-300 px-3 font-mono text-sm shadow-sm focus:border-rust focus:outline-none focus:ring-1 focus:ring-rust"
            />
            <button
              type="submit"
              className="rounded bg-rust px-4 py-2 font-sans text-sm font-medium text-white hover:bg-rust/90"
            >
              {t("tenant_detail.soft_disable.submit")}
            </button>
          </Form>
        </section>
      ) : null}

      {canReEnable ? (
        <section className="space-y-2">
          <h2 className="font-display text-lg font-semibold text-verdigris">
            {t("tenant_detail.sections.danger_zone")}
          </h2>
          <Form method="post">
            <input type="hidden" name="intent" value="re_enable" />
            <button
              type="submit"
              className="rounded bg-verdigris px-4 py-2 font-sans text-sm font-medium text-white hover:bg-verdigris/90"
            >
              {t("tenant_detail.soft_disable.reenable")}
            </button>
          </Form>
        </section>
      ) : null}
    </section>
  );
}

// @version v0.4.0
