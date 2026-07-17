/**
 * Operator — Create Tenant
 *
 * This route handles the create-tenant flow. GET
 * `/operator/tenants/new` renders the create-tenant form. POST
 * `/operator/tenants/new` validates the payload, atomically
 * creates the tenant + bootstrap superadmin user + audit_log row in a
 * single `withAuditLog` batch, then sends the bootstrap user a
 * magic-link sign-in email and redirects to the new tenant's detail
 * page.
 *
 * ## Atomicity contract
 *
 * Writes land in one D1 batch composed by `withAuditLog`:
 *
 *   1. INSERT INTO tenants — the new tenant row, with federation_id
 *      NULL initially (set in step 3).
 *   2. INSERT INTO federations — the tenant's federation-of-one
 *      (lead_tenant_id = the new tenant), since every tenant belongs to
 *      a federation (federation spec §2).
 *   3. UPDATE tenants SET federation_id — point the new tenant at its
 *      federation. Steps 1–3 are ordered this way because tenants <->
 *      federations is a circular FK pair and D1 has no DEFERRED FK
 *      support, so each per-statement FK check must already be
 *      satisfiable.
 *   4. INSERT INTO users   — the bootstrap superadmin's user row,
 *      living in the new tenant (tenantId=new tenant id), carrying
 *      isSuperAdmin=true and isAdmin=true so the operator's first
 *      delegate has full admin in addition to superadmin.
 *   5. INSERT INTO audit_log — the `create_tenant` row carrying the
 *      slug, descriptive_standard, capability snapshot, and the
 *      bootstrap email in `details`. The federation and bootstrap-user
 *      writes are part of `create_tenant`'s scope, NOT separate audit
 *      rows.
 *
 * If any write fails (CHECK violation, FK violation, transient D1
 * error) the entire batch rolls back — atomic by D1's all-or-nothing
 * batch contract.
 *
 * ## Magic-link send is non-blocking
 *
 * After the batch commits, the action calls `generateMagicLink` to
 * email the bootstrap user. The send happens OUTSIDE the batch and is
 * wrapped in try/catch so a Resend outage does not roll back the DB
 * writes — the existing invites convention
 * (`app/lib/invites.server.ts`) is "Email failure is non-blocking",
 * and the same posture applies to tenant bootstrap. If the email
 * fails the operator still sees the redirect and the new tenant; the
 * operator can re-send the magic-link from `/login` on the new
 * tenant subdomain on the bootstrap user's behalf.
 *
 * ## Slug + email validation
 *
 * The Zod parse via `CreateTenantSchema` is the route boundary —
 * SlugSchema's regex + reserved-list refinement and the lower-cased
 * email transform run before any DB statement. Pre-flight
 * collision check on `tenants.slug` returns a structured field error
 * so the form re-renders with the locale's `tenant_new.errors.slug_taken`
 * message rather than 5xx-ing on a UNIQUE constraint failure.
 *
 * @version v0.6.0
 */

import { Form, redirect } from "react-router";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { useTranslation } from "react-i18next";
import { tenants, users, federations } from "../db/schema";
import { PLATFORM_TENANT_ID } from "../lib/tenant";
import { withAuditLog } from "../lib/audit.server";
import { CreateTenantSchema } from "../lib/operator-actions.server";
import { userContext } from "../context";
import { generateMagicLink } from "../lib/auth.server";
import type { Route } from "./+types/_operator.tenants.new";

export async function loader(_: Route.LoaderArgs) {
  // No DB read — the form is rendered statically. The middleware
  // attaches userContext + tenantContext for the audit row in the
  // action handler.
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = (context as any).cloudflare.env;
  const db = drizzle(env.DB);
  const user = context.get(userContext);

  const formData = await request.formData();
  const parsed = CreateTenantSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Pre-flight slug collision check. The DB-level UNIQUE index on
  // tenants.slug is the second layer; this branch returns a structured
  // field error so the form re-renders cleanly instead of 5xx-ing.
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.slug))
    .limit(1)
    .all();
  if (existing.length > 0) {
    return {
      fieldErrors: {
        slug: ["slug_taken"],
      },
    };
  }

  const newTenantId = crypto.randomUUID();
  const newUserId = crypto.randomUUID();
  // Every tenant belongs to a federation (federation spec §2). A newly
  // provisioned tenant is a federation of one, led by itself; the
  // federation is minted here and set on the tenant in the same batch.
  const newFederationId = crypto.randomUUID();
  const now = Date.now();

  // The single audit-bearing batch: tenant + user inserts + audit row.
  // All four statements (3 work + 1 audit) commit together or roll back
  // together — D1 batch atomicity.
  await withAuditLog(
    db,
    {
      action: "create_tenant",
      actorUserId: user.id,
      actorUserIdText: user.email,
      actorTenantId: PLATFORM_TENANT_ID,
      targetTenantId: newTenantId,
      targetObjectKind: "tenant",
      targetObjectId: newTenantId,
      details: {
        slug: parsed.data.slug,
        name: parsed.data.name,
        descriptive_standard: parsed.data.descriptiveStandard,
        capabilities: {
          crowdsourcing: parsed.data.crowdsourcingEnabled,
          vocabulary_hub: parsed.data.vocabularyHubEnabled,
          publish_pipeline: parsed.data.publishPipelineEnabled,
          multi_repository: parsed.data.multiRepositoryEnabled,
          authorities: parsed.data.authoritiesEnabled,
          imports: parsed.data.importsEnabled,
        },
        bootstrap_email: parsed.data.bootstrapEmail,
      },
      now,
    },
    async (txDb) => {
      // tenants <-> federations is a circular FK pair and D1 has no
      // DEFERRED FK support, so the batch is ordered to keep every
      // per-statement FK check satisfied: (1) insert the tenant with
      // federation_id NULL (the column is DB-nullable; NULL is exempt
      // from FK checks), (2) insert the federation-of-one whose
      // lead_tenant_id points at the now-existing tenant, (3) UPDATE the
      // tenant's federation_id to the now-existing federation. The
      // `null` cast is required because schema.ts declares federationId
      // `.notNull()` (an app-layer read guarantee); the DB column is
      // nullable by construction (see migration 0044).
      const insertTenant = txDb.insert(tenants).values({
        id: newTenantId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        kind: "tenant",
        descriptiveStandard: parsed.data.descriptiveStandard,
        status: "active",
        crowdsourcingEnabled: parsed.data.crowdsourcingEnabled,
        vocabularyHubEnabled: parsed.data.vocabularyHubEnabled,
        publishPipelineEnabled: parsed.data.publishPipelineEnabled,
        multiRepositoryEnabled: parsed.data.multiRepositoryEnabled,
        authoritiesEnabled: parsed.data.authoritiesEnabled,
        importsEnabled: parsed.data.importsEnabled,
        quotaStorageBytes: parsed.data.quotaStorageBytes,
        disabledAt: null,
        federationId: null as unknown as string,
        createdAt: now,
        updatedAt: now,
      });
      const insertFederation = txDb.insert(federations).values({
        id: newFederationId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        leadTenantId: newTenantId,
        status: "active",
        // Operator-set gate, default off — a fresh tenant starts as a
        // federation-of-one (federation spec §5).
        multiMemberEnabled: false,
        createdAt: now,
      });
      const setTenantFederation = txDb
        .update(tenants)
        .set({ federationId: newFederationId })
        .where(eq(tenants.id, newTenantId));
      const insertUser = txDb.insert(users).values({
        id: newUserId,
        tenantId: newTenantId,
        email: parsed.data.bootstrapEmail,
        name: null,
        isAdmin: true,
        isSuperAdmin: true,
        isCollabAdmin: false,
        isArchiveUser: false,
        isUserManager: false,
        isCataloguer: false,
        lastActiveAt: null,
        githubId: null,
        createdAt: now,
        updatedAt: now,
      });
      return {
        workStatements: [
          insertTenant,
          insertFederation,
          setTenantFederation,
          insertUser,
        ],
        result: { tenantId: newTenantId, slug: parsed.data.slug },
      };
    },
  );

  // Magic-link send — non-blocking by design (mirrors the existing
  // invites convention). The DB writes are already committed at this
  // point; an email failure surfaces as a console warning and the
  // operator can re-trigger the link from the bootstrap user's
  // /login page on the new tenant subdomain.
  //
  // The magic-link verification URL must point at the NEW tenant's
  // subdomain (so the bootstrap user lands on `<slug>.fisqua.org/`
  // after sign-in), not at the platform host. We construct the origin
  // explicitly from the request's hostname suffix.
  try {
    const requestUrl = new URL(request.url);
    // Replace the platform-host slug ("platform") with the new tenant's
    // slug. e.g. https://platform.fisqua.org → https://<slug>.fisqua.org.
    const newOrigin = `${requestUrl.protocol}//${parsed.data.slug}.${requestUrl.hostname.split(".").slice(1).join(".")}`;
    await generateMagicLink(
      db,
      parsed.data.bootstrapEmail,
      newOrigin,
      env.RESEND_API_KEY,
      env,
    );
  } catch (err) {
    // Non-blocking — the bootstrap email is a convenience for the
    // bootstrap user; the operator can recover by visiting the new
    // tenant's /login page and submitting the magic-link form as the
    // bootstrap user.
    console.warn(
      "[operator] create_tenant: magic-link send failed for bootstrap user",
      err,
    );
  }

  return redirect(`/operator/tenants/${parsed.data.slug}`);
}

interface ActionData {
  fieldErrors?: Record<string, string[] | undefined>;
}

export default function CreateTenantPage({
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("operator");
  const data = actionData as ActionData | undefined;
  const fieldErrors = data?.fieldErrors ?? {};

  // Custom error-message resolver: route-side errors are emitted as
  // locale keys (e.g. "slug_taken") so the rendered text is
  // language-aware. Zod's intrinsic messages are passed through.
  function fieldError(field: string): string | null {
    const errs = fieldErrors[field];
    if (!errs || errs.length === 0) return null;
    const first = errs[0];
    if (first === "slug_taken") return t("tenant_new.errors.slug_taken");
    if (first === "slug_reserved") return t("tenant_new.errors.slug_reserved");
    return first;
  }

  return (
    <section className="max-w-2xl">
      <h1 className="mb-6 font-display text-2xl font-semibold text-stone-900">
        {t("tenant_new.page_title")}
      </h1>
      <Form method="post" className="space-y-4">
        <div>
          <label
            htmlFor="slug"
            className="block font-sans text-sm font-medium text-indigo"
          >
            {t("tenant_new.fields.slug")}
          </label>
          <input
            id="slug"
            name="slug"
            type="text"
            required
            className="mt-1 block h-10 w-full rounded border border-stone-300 px-3 font-mono text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <p className="mt-1 font-sans text-xs text-stone-500">
            {t("tenant_new.fields.slug_help")}
          </p>
          {fieldError("slug") ? (
            <p className="mt-1 font-sans text-xs text-rust">
              {fieldError("slug")}
            </p>
          ) : null}
        </div>

        <div>
          <label
            htmlFor="name"
            className="block font-sans text-sm font-medium text-indigo"
          >
            {t("tenant_new.fields.name")}
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            className="mt-1 block h-10 w-full rounded border border-stone-300 px-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          {fieldError("name") ? (
            <p className="mt-1 font-sans text-xs text-rust">
              {fieldError("name")}
            </p>
          ) : null}
        </div>

        <fieldset>
          <legend className="block font-sans text-sm font-medium text-indigo">
            {t("tenant_new.fields.descriptive_standard")}
          </legend>
          <div className="mt-2 flex gap-4 font-sans text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="descriptiveStandard"
                value="isadg"
                defaultChecked
              />
              <span>ISAD(G)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="descriptiveStandard"
                value="dacs"
              />
              <span>DACS</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="descriptiveStandard"
                value="rad"
              />
              <span>RAD</span>
            </label>
          </div>
          {fieldError("descriptiveStandard") ? (
            <p className="mt-1 font-sans text-xs text-rust">
              {fieldError("descriptiveStandard")}
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="block font-sans text-sm font-medium text-indigo">
            {t("tenant_new.fields.capabilities_legend")}
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2 font-sans text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="crowdsourcingEnabled"
                value="true"
              />
              <span>{t("tenants_list.capabilities.crowdsourcing")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="vocabularyHubEnabled"
                value="true"
                defaultChecked
              />
              <span>{t("tenants_list.capabilities.vocabulary_hub")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="publishPipelineEnabled"
                value="true"
                defaultChecked
              />
              <span>{t("tenants_list.capabilities.publish_pipeline")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="multiRepositoryEnabled"
                value="true"
              />
              <span>{t("tenants_list.capabilities.multi_repository")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="authoritiesEnabled"
                value="true"
                defaultChecked
              />
              <span>{t("tenants_list.capabilities.authorities")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="importsEnabled"
                value="true"
              />
              <span>{t("tenants_list.capabilities.imports")}</span>
            </label>
          </div>
        </fieldset>

        <div>
          <label
            htmlFor="quotaStorageBytes"
            className="block font-sans text-sm font-medium text-indigo"
          >
            {t("tenant_new.fields.quota_storage_bytes")}
          </label>
          <input
            id="quotaStorageBytes"
            name="quotaStorageBytes"
            type="number"
            min="0"
            className="mt-1 block h-10 w-full rounded border border-stone-300 px-3 font-mono text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <p className="mt-1 font-sans text-xs text-stone-500">
            {t("tenant_new.fields.quota_storage_help")}
          </p>
        </div>

        <div>
          <label
            htmlFor="bootstrapEmail"
            className="block font-sans text-sm font-medium text-indigo"
          >
            {t("tenant_new.fields.bootstrap_email")}
          </label>
          <input
            id="bootstrapEmail"
            name="bootstrapEmail"
            type="email"
            required
            className="mt-1 block h-10 w-full rounded border border-stone-300 px-3 font-sans text-sm shadow-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <p className="mt-1 font-sans text-xs text-stone-500">
            {t("tenant_new.fields.bootstrap_email_help")}
          </p>
          {fieldError("bootstrapEmail") ? (
            <p className="mt-1 font-sans text-xs text-rust">
              {fieldError("bootstrapEmail")}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          className="rounded bg-verdigris px-4 py-2 font-sans text-sm font-medium text-white hover:bg-verdigris/90"
        >
          {t("tenant_new.submit")}
        </button>
      </Form>
    </section>
  );
}

// @version v0.6.0
