/**
 * LandingFooter
 *
 * This component is the slim footer at the foot of the marketing landing.
 * White surface with a stone-200 top border. The version+licence line sits
 * on the left ("Fisqua v0.4 · Open source" / "Código abierto") and the two
 * outward links sit on the right: the AMPL project page (About) and the
 * source repository (Source code). No partner logos, no contact link, no
 * documentation link — locked by `32-LANDING-COPY.md` §1.5.
 *
 * The version eyebrow is a hand-bumped string in the landing locale
 * files. When the milestone version moves, update both `footer.version`
 * and `hero.eyebrow` (EN + ES) at the same time.
 *
 * The About URL (`https://ampl.clair.ucsb.edu/project/fisqua`) follows
 * the AMPL Jekyll permalink convention. If the AMPL page hasn't
 * deployed yet or uses a different slug, flag the mismatch to a
 * maintainer before publishing rather than letting a 404 ship.
 *
 * @version v0.4.0
 */
import { useTranslation } from "react-i18next";

const linkClass =
  "text-stone-600 no-underline hover:text-indigo hover:underline underline-offset-[3px] transition-colors duration-100";

const linkStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: "13px",
} as const;

export function LandingFooter() {
  const { t } = useTranslation("landing");
  return (
    <footer className="border-t border-stone-200 bg-white">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-5 py-5 md:px-16 md:py-7">
        <div
          className="text-stone-500"
          style={{ fontFamily: "var(--font-sans)", fontSize: "12px" }}
        >
          {t("footer.version")} · {t("footer.license")}
        </div>
        <nav className="flex items-center gap-6">
          <a
            href="https://ampl.clair.ucsb.edu/project/fisqua"
            className={linkClass}
            style={linkStyle}
          >
            {t("footer.about")}
          </a>
          <a
            href="https://github.com/UCSB-AMPLab/fisqua"
            className={linkClass}
            style={linkStyle}
          >
            {t("footer.source")}
          </a>
        </nav>
      </div>
    </footer>
  );
}

// @version v0.4.0
