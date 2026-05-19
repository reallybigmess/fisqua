/**
 * Impersonation Banner
 *
 * This banner is the persistent notice that renders at the top of every
 * tenant subdomain page during an operator impersonation envelope. The
 * `_auth` layout conditionally renders this component based on the
 * `impersonating` field returned by its loader (read in turn from
 * `impersonationContext` via the auth middleware).
 *
 * ## Visual + interaction contract
 *
 *   - Sticky at top, above the existing header chrome. `z-50` lifts
 *     it above the staff sidebar's expand toggle.
 *   - Amber/rust palette — the staff app's accent for
 *     "danger-zone-adjacent" surfaces (see `_operator.tenants.$slug.tsx`
 *     soft-disable section). Visible on every page during the
 *     envelope.
 *   - CANNOT be dismissed. No close button; the only exit is the
 *     End-impersonation form.
 *   - Bilingual via the `operator` namespace's `banner.impersonating`
 *     and `banner.end_button` keys (Colombian Spanish, no voseo).
 *
 * ## Form mechanics
 *
 * Posts to `/end-impersonation` (the action route at
 * `app/routes/end-impersonation.tsx`). The action lives at the
 * top level of `routes.ts` so the POST does NOT pass through the
 * `_auth` middleware — the whole point is to clear the impersonating
 * envelope BEFORE any default-deny gate runs against it. The Form
 * uses an explicit `action` attribute (not bare) so React Router 7's
 * index-route disambiguator never enters the picture.
 *
 * @version v0.4.0
 */

import { Form } from "react-router";
import { useTranslation } from "react-i18next";

interface ImpersonationBannerProps {
  /** The role the operator is impersonating (one of the six role flag literals). */
  role: string;
  /** The tenant's display name (e.g. "Neogranadina"). */
  tenantName: string;
}

export function ImpersonationBanner({
  role,
  tenantName,
}: ImpersonationBannerProps) {
  const { t } = useTranslation("operator");
  return (
    <div
      role="status"
      className="sticky top-0 z-50 border-b border-rust/60 bg-rust/10 text-rust shadow-sm"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2">
        <span className="font-sans text-sm font-medium">
          {t("banner.impersonating", { role, tenant: tenantName })}
        </span>
        <Form method="post" action="/end-impersonation">
          <button
            type="submit"
            className="rounded bg-rust px-3 py-1 font-sans text-xs font-semibold text-white hover:bg-rust/90"
          >
            {t("banner.end_button")}
          </button>
        </Form>
      </div>
    </div>
  );
}

// @version v0.4.0
