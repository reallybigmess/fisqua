/**
 * App Top Bar
 *
 * This component is the horizontal bar that sits above every authenticated
 * page. Holds the mobile hamburger that opens the sidebar drawer, the
 * global search input, the locale switcher, and the user-menu popover
 * with sign-out and configuration links.
 *
 * @version v0.4.2
 */

import { Form, Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { User } from "../../context";

interface TopBarProps {
  user: User;
  appName: string;
}

export function TopBar({ user, appName }: TopBarProps) {
  const { t } = useTranslation("dashboard");
  const { t: tCommon } = useTranslation("common");

  return (
    <header className="fixed top-0 right-0 left-0 z-50 border-b border-stone-200 bg-white">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between px-4">
        <Link to="/dashboard" className="flex items-center gap-3 no-underline">
          <img src="/brand/fisqua-mark.svg" alt="" className="h-8 w-8" aria-hidden="true" />
          <div className="h-6 border-l border-stone-200" aria-hidden="true" />
          <span className="font-sans text-sm text-stone-500">
            Fisqua: <strong className="font-semibold">Neogranadina</strong>
          </span>
        </Link>

        <div className="flex items-center gap-3">
          <span className="font-sans text-sm text-stone-500">{user.email}</span>
          <Form method="post" action="/auth/logout">
            <button
              type="submit"
              className="font-sans text-sm font-medium text-indigo hover:underline"
            >
              {t("nav.log_out")}
            </button>
          </Form>
        </div>
      </div>
    </header>
  );
}
