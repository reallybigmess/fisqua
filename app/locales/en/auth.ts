/**
 * English translations — auth namespace
 *
 * This locale namespace carries the English strings for the
 * unauthenticated sign-in surface — the email-magic-link form, the
 * "Continue with GitHub" OAuth button, the divider, and the error
 * messages routed through `/login`.
 *
 * Locked copy: the "Continue with GitHub" button
 * label still applies; only the link target changed (now points at the
 * apex `/auth/github?return_to=<slug>` rather than the tenant
 * `/auth/github`). The verbatim copy, divider, and error strings are
 * unchanged.
 *
 * @version v0.4.0
 */
export default {
  email_label: "Email address",
  login_button: "Send login link",
  success_message: "Check your email.",
  github_login_button: "Continue with GitHub",
  or_divider: "or",
  error: {
    expired_link: "This link has expired. Request a new one.",
    invalid_link: "This link is not valid. Request a new one.",
    invalid_email: "Enter a valid email address.",
    oauth_failed: "GitHub login failed. Please try again.",
    no_email: "No verified email found on your GitHub account.",
    no_account:
      "No account found for your GitHub email. Ask a project admin for an invite.",
  },
  placeholder: "you@example.com",
  page_title: "Log in | Fisqua",
  footer_note:
    "Log in with GitHub or your Neogranadina institutional email.",
  wrong_workspace: {
    page_title: "Wrong workspace | Fisqua",
    eyebrow: "Wrong workspace",
    title: "You're in the wrong place",
    body: "It looks like you signed in from the wrong subdomain. Your account belongs to a different workspace.",
    body_fallback: "It looks like you signed in from the wrong subdomain. Your account is on a different workspace.",
    cta: "Go to your {{name}} workspace",
    cta_fallback: "Sign in again",
    sign_out_link: "This isn't my account? Sign out",
  },
} as const;
