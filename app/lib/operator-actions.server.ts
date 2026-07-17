/**
 * Operator-Action Validators + Capability-Diff Helper
 *
 * This module deals with the shared Zod schemas and the pure
 * capability-diff helper that `app/routes/_operator.tenants.new.tsx`
 * and `app/routes/_operator.tenants.$slug.tsx` use to parse form
 * payloads and compute audit-detail changes. Splitting the validation
 * surface out of the route files keeps the action handlers narrow and
 * testable — the schemas land here once, the route imports them.
 *
 * ## Form-field set
 *
 * `CreateTenantSchema` mirrors the `/operator/tenants/new` form fields
 * one-to-one (slug, name, descriptive_standard, six capability flags,
 * optional quota, bootstrap-superadmin email). The schema applies
 * `SlugSchema` for the slug field — the existing GLOB regex +
 * reserved-list refinement flows through unchanged.
 *
 * `SetCapabilitySchema`, `SoftDisableSchema`, and `ReEnableSchema`
 * carry the discriminator literals the multi-intent action handler in
 * `_operator.tenants.$slug.tsx` switches over.
 *
 * ## Reserved-slug list
 *
 * `SlugSchema` already encodes the five reserved slugs (`platform`,
 * `www`, `api`, `admin`, `app`) via `.refine`. We do NOT duplicate the
 * list here; reusing the helper means a future change to the reserved
 * set lands in one place. The DB-level GLOB CHECK on `tenants.slug`
 * is the second layer.
 *
 * ## Capability defaults
 *
 * The capability boolean fields default to the locked matrix:
 *
 *   - `crowdsourcing`        → off  (institutions opt in)
 *   - `vocabulary_hub`       → on   (every tenant gets the controlled
 *                                    vocabulary surface by default)
 *   - `publish_pipeline`     → on   (every tenant gets export by default)
 *   - `multi_repository`     → off  (single-repo is the v0.4 default)
 *   - `authorities`          → on   (authority cataloguing is the norm;
 *                                    strings-only tenants opt out)
 *   - `imports`              → off  (bulk import is opt-in)
 *
 * `SetCapabilitySchema` defaults each flag to FALSE — the form's
 * capability checkboxes mean "send a value only if checked"; an
 * absent field is the unchecked / off state. The diff helper compares
 * against the current row, so submitting an unchecked checkbox
 * legitimately means "turn this capability off".
 *
 * ## diffCapabilities
 *
 * Pure function. Compares the five boolean columns from the current
 * tenant row against the submitted values and returns an array of
 * `{ capability, from, to }` entries — one per changed flag. Empty
 * array means no-op (the action handler then skips the `withAuditLog`
 * call to avoid logging a no-op write). The capability label uses the
 * `Capability` string literals (`crowdsourcing`, `vocabulary_hub`,
 * `publish_pipeline`, `multi_repository`, `authorities`, `imports`) so
 * the audit details JSON is reviewable as-shipped.
 *
 * @version v0.6.0
 */

import { z } from "zod";
import { SlugSchema } from "./tenant";
import { DESCRIPTIVE_STANDARDS } from "./validation/enums";

/**
 * Boolean coercion for HTML form inputs. A checkbox sends its `value`
 * attribute (we use `"true"`) only when checked; an unchecked checkbox
 * is absent from the form data entirely. Tests, however, may send
 * `"false"` explicitly; treat the literal strings `"false"`, `""`,
 * `"0"`, `"off"`, and `undefined` as falsy and everything else
 * (including `"true"`, `"1"`, `"on"`) as truthy.
 *
 * Distinct from Zod's `z.coerce.boolean()` which coerces any non-empty
 * string to `true` — that would treat `"false"` as truthy, which is
 * the opposite of the intent.
 */
const checkboxSchema = z
  .preprocess(
    (v) => {
      if (v === undefined || v === null) return false;
      if (typeof v === "boolean") return v;
      if (typeof v === "string") {
        const lower = v.toLowerCase();
        if (lower === "" || lower === "false" || lower === "0" || lower === "off") {
          return false;
        }
        return true;
      }
      return Boolean(v);
    },
    z.boolean(),
  );

/**
 * Zod schema for the create-tenant form. Mirrors the locked field
 * set. `slug` rides on the existing `SlugSchema` (regex + reserved-list
 * refinement). `bootstrapEmail` is `.toLowerCase()`d so casing variation
 * in the form doesn't produce duplicate user rows on subsequent imports.
 *
 * `quotaStorageBytes` is optional and nullable — the form's number
 * input may be empty (treated as `null` after `z.coerce.number()`'s
 * empty-string branch and `.nullable()`). `crowdsourcingEnabled`,
 * `vocabularyHubEnabled`, etc. are coerced from form-field strings
 * (`"on"` / `"off"` / `"true"` / `"false"`) to booleans; a missing
 * field falls back to the C-07 default.
 */
export const CreateTenantSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1, { message: "Name is required" }).max(120),
  descriptiveStandard: z.enum(DESCRIPTIVE_STANDARDS),
  crowdsourcingEnabled: checkboxSchema.default(false),
  vocabularyHubEnabled: checkboxSchema.default(true),
  publishPipelineEnabled: checkboxSchema.default(true),
  multiRepositoryEnabled: checkboxSchema.default(false),
  authoritiesEnabled: checkboxSchema.default(true),
  importsEnabled: checkboxSchema.default(false),
  // Empty string from a blank form field becomes `null`; otherwise a
  // non-negative integer. Storing `null` matches the schema's nullable
  // `quota_storage_bytes` column.
  quotaStorageBytes: z
    .preprocess(
      (v) => (v === "" || v === undefined || v === null ? null : v),
      z.coerce.number().int().nonnegative().nullable(),
    )
    .default(null),
  bootstrapEmail: z
    .string()
    .email({ message: "Invalid email" })
    .transform((s) => s.toLowerCase()),
});

export type CreateTenantPayload = z.infer<typeof CreateTenantSchema>;

/**
 * Zod schema for the capabilities-edit form on the tenant detail page.
 * Each flag defaults to FALSE because an unchecked checkbox sends no
 * field; the diff helper then compares against the current row and
 * computes the actual changes. The `intent` discriminator pins this
 * branch of the multi-intent action handler.
 */
export const SetCapabilitySchema = z.object({
  intent: z.literal("set_capability"),
  crowdsourcingEnabled: checkboxSchema.default(false),
  vocabularyHubEnabled: checkboxSchema.default(false),
  publishPipelineEnabled: checkboxSchema.default(false),
  multiRepositoryEnabled: checkboxSchema.default(false),
  authoritiesEnabled: checkboxSchema.default(false),
  importsEnabled: checkboxSchema.default(false),
});

/**
 * Zod schema for the soft-disable form. The `confirmSlug` field is the
 * operator typing the slug into a confirmation input — the action
 * handler asserts it equals the URL-bound slug before writing
 * `disabled_at`. Pure mechanical guard against accidental misclicks; a
 * determined operator can soft-disable any tenant they have a session
 * for, which is the intended capability of the role.
 */
export const SoftDisableSchema = z.object({
  intent: z.literal("soft_disable"),
  confirmSlug: z.string(),
});

/**
 * Zod schema for the re-enable form. No payload beyond the
 * discriminator — re-enable is a single state-flag flip and the slug
 * comes from the URL.
 */
export const ReEnableSchema = z.object({
  intent: z.literal("re_enable"),
});

/**
 * The capability flag identifiers used in audit details payloads.
 * Mirrors `Capability` from `app/lib/tenant.ts`; kept inline here so
 * the diff helper does not have to import the type.
 */
export type CapabilityName =
  | "crowdsourcing"
  | "vocabulary_hub"
  | "publish_pipeline"
  | "multi_repository"
  | "authorities"
  | "imports";

interface CapabilityRow {
  crowdsourcingEnabled: boolean;
  vocabularyHubEnabled: boolean;
  publishPipelineEnabled: boolean;
  multiRepositoryEnabled: boolean;
  authoritiesEnabled: boolean;
  importsEnabled: boolean;
}

interface CapabilityDiffEntry {
  capability: CapabilityName;
  from: boolean;
  to: boolean;
}

/**
 * Pure function. Diffs the submitted capability flags against the
 * current tenant row and returns the list of changes. Empty array
 * means no-op — the action handler skips the audit-log write to avoid
 * logging an idempotent submission.
 *
 * Ordering: the entries follow the C-07 capability matrix order
 * (crowdsourcing → vocabulary_hub → publish_pipeline → multi_repository
 * → authorities → imports) so audit-UI rendering is stable across
 * renders.
 */
export function diffCapabilities(
  current: CapabilityRow,
  submitted: CapabilityRow,
): CapabilityDiffEntry[] {
  const changes: CapabilityDiffEntry[] = [];
  if (current.crowdsourcingEnabled !== submitted.crowdsourcingEnabled) {
    changes.push({
      capability: "crowdsourcing",
      from: current.crowdsourcingEnabled,
      to: submitted.crowdsourcingEnabled,
    });
  }
  if (current.vocabularyHubEnabled !== submitted.vocabularyHubEnabled) {
    changes.push({
      capability: "vocabulary_hub",
      from: current.vocabularyHubEnabled,
      to: submitted.vocabularyHubEnabled,
    });
  }
  if (current.publishPipelineEnabled !== submitted.publishPipelineEnabled) {
    changes.push({
      capability: "publish_pipeline",
      from: current.publishPipelineEnabled,
      to: submitted.publishPipelineEnabled,
    });
  }
  if (current.multiRepositoryEnabled !== submitted.multiRepositoryEnabled) {
    changes.push({
      capability: "multi_repository",
      from: current.multiRepositoryEnabled,
      to: submitted.multiRepositoryEnabled,
    });
  }
  if (current.authoritiesEnabled !== submitted.authoritiesEnabled) {
    changes.push({
      capability: "authorities",
      from: current.authoritiesEnabled,
      to: submitted.authoritiesEnabled,
    });
  }
  if (current.importsEnabled !== submitted.importsEnabled) {
    changes.push({
      capability: "imports",
      from: current.importsEnabled,
      to: submitted.importsEnabled,
    });
  }
  return changes;
}

// @version v0.6.0
