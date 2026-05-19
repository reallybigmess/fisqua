/**
 * LandingHeader
 *
 * This component is the slim, normal-flow header for the apex marketing
 * landing. White background with a thin stone-200 bottom border so the
 * hero reads as a separate register. Brand mark + Spectral wordmark in
 * verdigris-deep on the left; segmented EN/ES toggle on the right.
 *
 * Anonymous surface: no tenant suffix on the wordmark, no logout,
 * no sidebar.
 *
 * @version v0.4.0
 */
import { useTranslation } from "react-i18next";
import { LanguageToggle } from "./language-toggle";
import { FisquaMark } from "./landing-mark";

export function LandingHeader({ lang }: { lang: "en" | "es" }) {
  const { t } = useTranslation("landing");
  return (
    <header className="flex items-center justify-between border-b border-stone-200 bg-white px-5 py-3 md:h-16 md:px-8 md:py-0">
      <div className="flex items-center gap-2.5">
        <FisquaMark size="28px" color="var(--verdigris-deep)" />
        <span
          className="font-display text-verdigris-deep"
          style={{
            fontSize: "22px",
            fontWeight: 600,
            letterSpacing: "-0.01em",
            lineHeight: 1,
          }}
        >
          {t("header.brand")}
        </span>
      </div>
      <LanguageToggle lang={lang} />
    </header>
  );
}

// @version v0.4.0
