# Fisqua

**Fisqua** is an open-source cataloguing platform for archives — describing materials, managing authority records and controlled vocabularies, and assembling the hierarchies that hold a collection together. It runs on Cloudflare Workers with D1 and R2, and is designed to scale from community-led initiatives to major libraries.

Fisqua is one of four open-source primitives developed by [AMPL](https://ampl.clair.ucsb.edu) with its partners, alongside the [Digitization Toolkit](https://github.com/UCSB-AMPLab/digitization-toolkit-software) (which captures), [Zasqua](https://zasqua.org) (which publishes), and [Telar](https://telar.org) (which tells). The four are designed to work together as a full pipeline, but each can be used independently.

## What it does

Fisqua is built on the standards the international archival community has settled on. Descriptions are written against **ISAD(G)**, **DACS**, or **RAD** — each archive picks its standard, and forms, labels, and validation follow. Authority records follow **ISAAR(CPF)**; images are served as **IIIF**; preservation metadata travels as **METS**; and the publish pipeline exports **EAD** and **Dublin Core**. Working in the shared standards means a collection catalogued in Fisqua is portable from day one — the catalogue outlives whatever software holds it.

**Hosting and support.** Fisqua is developed as hosted infrastructure for AMPL's partner archives. We publish the source under the AGPL as a matter of scholarly and political commitment: the platform's code, like the data it manages, should be open to inspection and reuse. Self-hosting is possible, but we do not have the capacity to support it — issues and pull requests from self-hosting deployments may go unanswered. Archives interested in a hosted workspace should get in touch with the lab.

### Collaborative cataloguing

One feature at the heart of Fisqua distinguishes it from most archive-management platforms: it is designed to open description work to volunteers, students, and community members under professional archival review. A convenor assigns items; contributors describe them against the catalogue's controlled fields and vocabularies; the convenor reviews and approves entries before they enter the catalogue. Three things come out of this at once: archival description produced at a scale few institutions can resource on their own; hands-on training in the core skills of historical archival work — palaeography, description, and authority work — that are otherwise hard to come by outside professional programmes; and a practice of archiving that stays open to the communities and publics whose materials are being described.

## Key features

- Virtualised continuous-scroll IIIF viewer with OpenSeadragon tiles and zoom
- Page and within-page boundary placement with click-to-place, drag-to-move, and autosave
- Outline panel with tree structure, ISAD(G) metadata editing, QC flags, and region-anchored comments
- Assignment workflow with three roles (Lead, Reviewer, Cataloguer) and status progression
- Federations: partner institutions share entities, places, and controlled vocabularies across a common authority space, with steward-gated curation
- Authorities workspace: merge and split workbenches with linked-description context cards, duplicates worklists, and an append-only operations ledger with per-record history
- Places map explorer with coordinate editing, geocoding search, and a controlled coordinate-precision vocabulary
- Entity, place, and repository administration with filterable worklists, linked-description context cards, and OCR-snippet evidence
- Vocabularies hub with draft / review / approve flow for controlled terms
- Publish pipeline that exports fonds-level JSON, METS, and manifests to R2 through a durable Cloudflare Workflow
- Role-dependent dashboards with progress tracking
- Bilingual interface (English / Spanish)

## Running Fisqua

AMPL operates a hosted, multi-tenant Fisqua at **[fisqua.org](https://fisqua.org)** that partners use without maintaining servers of their own. It currently supports cataloguing across five partner repositories in Colombia and Peru — ranging from community-held collections to the Peruvian National Library — comprising over 106,000 archival descriptions. Further partner deployments are planned through UCSB's [Robinson Archives Initiative](https://www.library.ucsb.edu/news/ucsb-receives-robinson-archive).

The code in this repository is the complete platform — schema, server, UI, and the tooling that turns catalogued data into an exportable archive. It is published so that the infrastructure our partners depend on can be inspected, audited, and, if it ever came to it, rebuilt. A partner that begins on the hosted Fisqua can leave with everything they have put in.

## Requirements

- Node.js 18+
- npm
- A [Resend](https://resend.com) API key (for magic-link authentication emails)
- A [MapTiler](https://maptiler.com) API key (for the places maps; the free plan is sufficient)

## Setup

```bash
npm install
```

Create a `.dev.vars` file for local secrets:

```
RESEND_API_KEY=re_your_key_here
```

Set your app identity in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "APP_NAME": "Fisqua",
  "SENDER_EMAIL": "noreply@example.com",
  "MAPTILER_KEY": "your_maptiler_key"
}
```

Initialise the local database and start the dev server:

```bash
npx wrangler d1 migrations apply DB --local
npm run dev
```

## Deployment

```bash
npm run deploy
```

Set secrets for production:

```bash
npx wrangler secret put RESEND_API_KEY
```

Apply migrations to production D1:

```bash
npx wrangler d1 migrations apply DB --remote
```

## Architecture

Built on Cloudflare Workers with D1 (SQLite) for data, R2 for blob storage, Drizzle ORM for typed queries, React Router v7 for SSR, MapLibre GL for the places maps, and Vite for the build. Styling is Tailwind; validation is Zod; testing is Vitest. The publish pipeline runs as a Cloudflare Workflow so each step gets a fresh runtime budget.

The viewer renders IIIF Image API tiles from existing Zasqua volumes on R2 — no image processing or storage is needed inside Fisqua. Only visible pages plus a two-page buffer are rendered at any time, enabling smooth scrolling through volumes of 500+ pages.

## Name

**Fisqua** is a verb from the [Muisca language](https://es.wikipedia.org/wiki/Muysccubun) of Suba, roughly _"to gather scattered things"_ — related to forms for searching, gathering, and traversing. It names both the work the tool enables and the historical processes the resulting catalogues help document. The name pairs with Zasqua, _"to settle"_ or _"to remain in a given place"_.

## License

Fisqua is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Anyone may use, modify, and self-host Fisqua under AGPL terms. If you run a modified version of Fisqua as a network service for others, you must publish your modifications under the same license — this protects the upstream commons that AMPL, Neogranadina, and partner archives depend on.

The license governs the software. Catalogued data — the descriptions, authority records, and vocabularies you create using Fisqua — belongs to you and your institution.

## Trademarks

"Fisqua", "Zasqua", "AMPL", and the associated logos are not covered by the AGPL-3.0 license. Forks may use the code freely under AGPL terms but should not present themselves as official Fisqua, Zasqua, or AMPL releases.

## Credits

Fisqua is developed by Juan Cobo Betancourt at the [Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu) (AMPL) of the University of California, Santa Barbara, and [Neogranadina](https://neogranadina.org).

## Acknowledgements

Thank you to [Jairo Melo Flórez](https://jairomelo.com), whose Django-based prosopographical work at Neogranadina and AMPL — developed for the UC MRPI Routes of Enslavement in the Americas project and now powering [Trayectorias Afro](https://trayectoriasafro.org) and the [Sondondo Parish Records Project](https://ampl.clair.ucsb.edu/sondondo) — first bore the name "[Fisqua](https://zenodo.org/records/16332384)" within Neogranadina.
