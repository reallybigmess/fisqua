/**
 * LanguageToggle
 *
 * This component is the server-rendered EN / ES anchor pair driving the
 * per-request language override via `?lang=en` / `?lang=es`. The active
 * locale carries `aria-current="true"` and an indigo fill; the inactive
 * locale stays transparent on white. No client-side state, no cookie, no
 * persistence.
 *
 * Visually a segmented control (bordered box, tight padding,
 * Bricolage 12px uppercase). Anchors carry the work so the toggle
 * still functions when JavaScript is disabled.
 *
 * The middleware that consumes the query param is
 * `app/middleware/i18next.ts` (it sets `searchParamKey: "lang"`
 * so this anchor pair functions as locked).
 *
 * @version v0.4.0
 */
import { useTranslation } from "react-i18next";

const baseAnchor =
  "inline-flex items-center justify-center rounded-sm px-2.5 py-[5px] no-underline transition-colors duration-100";

const activeAnchor = "bg-indigo text-white font-semibold";
const inactiveAnchor = "bg-transparent text-stone-500 hover:text-indigo font-medium";

export function LanguageToggle({ lang }: { lang: "en" | "es" }) {
  const { t } = useTranslation("landing");
  return (
    <nav
      aria-label={t("header.lang_toggle_label")}
      className="inline-flex rounded-md border border-stone-200 bg-white p-[2px]"
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "12px",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      <a
        href="/?lang=en"
        aria-current={lang === "en" ? "true" : undefined}
        className={`${baseAnchor} ${lang === "en" ? activeAnchor : inactiveAnchor}`}
      >
        {t("header.lang_en")}
      </a>
      <a
        href="/?lang=es"
        aria-current={lang === "es" ? "true" : undefined}
        className={`${baseAnchor} ${lang === "es" ? activeAnchor : inactiveAnchor}`}
      >
        {t("header.lang_es")}
      </a>
    </nav>
  );
}

// @version v0.4.0
