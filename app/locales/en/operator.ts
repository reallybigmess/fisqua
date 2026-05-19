/**
 * English translations — operator namespace
 *
 * This locale namespace carries the English strings for the operator
 * surface: top-bar nav, tenants list table,
 * tenant create form, tenant detail page, the impersonation banner
 * that renders on tenant subdomains during a login-as session, and a
 * small set of generic operator errors. The symmetry test
 * (`tests/i18n-coverage.test.ts`) runs equally over the parallel
 * ES file.
 *
 * @version v0.4.0
 */
export default {
  brand: "Fisqua Operator",
  nav: {
    tenants: "Tenants",
    logout: "Log out",
    end_impersonation: "End impersonation",
  },
  tenants_list: {
    page_title: "Tenants",
    new_tenant_button: "New tenant",
    columns: {
      slug: "Slug",
      name: "Name",
      kind: "Kind",
      descriptive_standard: "Standard",
      capabilities: "Capabilities",
      disabled: "Disabled",
      actions: "Actions",
    },
    badges: {
      platform: "[platform]",
      disabled: "Disabled",
    },
    capabilities: {
      crowdsourcing: "Crowdsourcing",
      vocabulary_hub: "Vocabulary hub",
      publish_pipeline: "Publish pipeline",
      multi_repository: "Multi-repository",
    },
    view_link: "View",
    empty_state: "No tenants yet.",
  },
  // Tenant create + detail strings.
  tenant_new: {
    page_title: "Create tenant",
    fields: {
      slug: "Slug",
      slug_help:
        "Lowercase letters, digits, hyphens. Reserved: platform, www, api, admin, app.",
      name: "Display name",
      descriptive_standard: "Descriptive standard",
      capabilities_legend: "Capabilities",
      quota_storage_bytes: "Storage quota (bytes)",
      quota_storage_help: "Optional. Leave blank for unbounded.",
      bootstrap_email: "First superadmin email",
      bootstrap_email_help:
        "We will send this person a magic link to sign in.",
    },
    submit: "Create tenant and invite superadmin",
    errors: {
      slug_taken: "This slug is already taken.",
      slug_reserved: "This slug is reserved.",
      slug_invalid:
        "Invalid slug. Use lowercase letters, digits, and hyphens.",
      bootstrap_email_invalid: "Enter a valid email address.",
    },
  },
  tenant_detail: {
    page_title: "Tenant: {{name}}",
    sections: {
      overview: "Overview",
      capabilities: "Capabilities",
      impersonate: "Log in as",
      danger_zone: "Danger zone",
    },
    overview: {
      slug: "Slug",
      kind: "Kind",
      descriptive_standard: "Descriptive standard",
      created_at: "Created",
      disabled_at: "Disabled at",
    },
    capabilities_form: {
      submit: "Save capabilities",
      success: "Capabilities saved.",
    },
    impersonate_form: {
      role_legend: "Sign in as which role on this tenant?",
      reason_label: "Reason (optional)",
      reason_help: "Recorded in the audit log.",
      submit: "Log in as {{role}}",
    },
    soft_disable: {
      title: "Soft-disable this tenant",
      help:
        "The tenant subdomain returns 404. Operator routes can still see it. Re-enable by clearing the disabled flag.",
      submit: "Soft-disable",
      reenable: "Re-enable",
      confirm_disable:
        "Confirm: soft-disable {{slug}}? Type the slug to confirm.",
    },
  },
  banner: {
    impersonating: "Impersonating {{role}} on {{tenant}}",
    end_button: "End impersonation",
  },
  errors: {
    not_operator: "You are not an instance operator.",
    no_session: "Sign in to continue.",
  },
} as const;

// @version v0.4.0
