/**
 * English translations — landing namespace
 *
 * This locale namespace carries the strings powering the apex
 * marketing landing + workspace picker (`app/routes/_index.tsx`). Every value is locked verbatim by
 * `32-LANDING-COPY.md` and the 2026-05-02 design pass; do not
 * paraphrase, retranslate, or shorten without re-opening that
 * document. The version eyebrow `hero.eyebrow` reads "FISQUA · v0.4"
 * — bump it by hand at the milestone boundary along with the
 * `footer.version` string.
 *
 * The `context.paragraph` value is consumed via `<Trans>` so the
 * embedded `<em>` markup in the ES counterpart renders as italic
 * around the word *serverless*, and the `<strong>` tags around the
 * standards (ISAD(G), DACS, RAD) and the institutional names
 * (AMPL, Neogranadina) render as semibold.
 *
 * @version v0.4.0
 */
export default {
  header: {
    brand: "Fisqua",
    lang_toggle_label: "Switch language",
    lang_en: "EN",
    lang_es: "ES",
  },
  hero: {
    eyebrow: "FISQUA · v0.4",
    tagline:
      "An open-source, collaborative archival cataloguing and records management platform.",
  },
  picker: {
    label: "Workspace",
    placeholder: "your-workspace",
    suffix: ".fisqua.org",
    submit: "Continue",
    submitting: "Opening workspace…",
    helper: "Type your workspace name.",
    error: {
      empty: "Enter your workspace name.",
      shape:
        "Workspace names use lowercase letters, numbers, and hyphens, and start with a letter.",
      notFound:
        'We don\'t have a workspace called "{{slug}}". Check the spelling and try again.',
    },
  },
  context: {
    eyebrow: "About Fisqua",
    paragraph:
      'Fisqua, from the Muisca verb "to gather scattered things", is an open-source platform for archival cataloguing and records management. It is built to run on lightweight serverless infrastructure and designed to support community-based collaborative description. It supports <strong>ISAD(G)</strong>, <strong>DACS</strong>, and <strong>RAD</strong>, and exports all data in open formats. It is developed at the <strong>Archives, Memory, and Preservation Lab (AMPL)</strong> at UC Santa Barbara and <strong>Neogranadina</strong>.',
  },
  footer: {
    version: "Fisqua v0.4",
    license: "Open source",
    about: "About",
    source: "Source code",
  },
  meta: {
    title: "Fisqua",
    description:
      "An open-source platform for archival cataloguing and records management, developed at AMPL (UC Santa Barbara) and Neogranadina.",
  },
} as const;

// @version v0.4.0
