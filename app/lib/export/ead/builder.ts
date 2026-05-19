/**
 * EAD3 XML Builder
 *
 * This builder deals with pure-function emission of EAD3 v1.1.1
 * finding-aid XML for one fonds. The active per-standard profile
 * (ISAD(G), DACS, or RAD) is selected by the caller from
 * `tenant.descriptiveStandard` via `getEadProfile()` from
 * `./profiles/registry`. The profile decides which optional
 * `<archdesc>` children appear and where biographical /
 * administrative history sits; the builder owns the universal element
 * ordering EAD3's RNG enforces.
 *
 * Template literals plus the shared `escapeXml`/`el` helpers from
 * `app/lib/export/xml/escape.ts` keep the Worker bundle small — same
 * pattern as `app/lib/export/mets-builder.ts`. T-37-02 mitigation
 * (XML injection through interpolated description content) is
 * structural: every interpolated value flows through `escapeXml`,
 * including legacyId provider/value pairs at every `<unitid type="...">`
 * call site.
 *
 * `<unitid>` emission scheme: one primary `<unitid>` from
 * `referenceCode` with no `@type` attribute, plus one secondary
 * `<unitid type="<provider>">` per `legacyIds` entry. This
 * round-trips legacy provenance JSON through EAD3 without inventing
 * non-canonical EAD elements; downstream aggregators see the primary
 * identifier and ignore the typed legacy IDs unless they
 * specifically harvest them.
 *
 * `<archdesc>` element ordering (universal, RNG-enforced):
 * did → bioghist → scopecontent → arrangement → accessrestrict →
 * userestrict → prefercite → acqinfo → phystech → relatedmaterial →
 * notestmt → dsc. Profiles toggle inclusion only, never order.
 *
 * Pure function: no D1, no R2, no fetch. The pipeline wires the data
 * fetch + R2 PUT around this; the builder takes already-fetched
 * fonds rows + repository map + profile + createDate as input and
 * returns the document as a string.
 *
 * @version v0.4.0
 */

import { escapeXml, el, sanitiseRefForKey } from "../xml/escape";
import type { EadInput, EadProfile, EadRepository } from "../types";

// ---------------------------------------------------------------------------
// Namespaces (EAD3 v1.1.1 — Society of American Archivists, Library of Congress)
// ---------------------------------------------------------------------------
const NS_EAD = "http://ead3.archivists.org/schema/";
const NS_XLINK = "http://www.w3.org/1999/xlink";

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

// Two-letter / three-letter language code → human-readable label, mirrors the
// shape used in `mets-builder.ts`. The EAD3 schema's `langcode`
// pattern accepts any well-formed ISO code; the label is purely the
// human-readable form interpolated as element text.
const LANGUAGE_MAP: Record<string, string> = {
  spa: "Español",
  eng: "English",
  fra: "Français",
  por: "Português",
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Emit one EAD3 finding-aid document for one fonds.
 *
 * @param fondsRows All published descriptions for one fonds (one fonds-level
 *                  row + zero or more descendants — series/file/item/etc.).
 *                  The pipeline caller is responsible for the D1 query that
 *                  returns this slice; the order doesn't matter for
 *                  correctness because the builder filters the fonds row
 *                  out and emits all others as `<c>` blocks.
 * @param repos     Repository lookup keyed by `repositoryId`. The fonds
 *                  row's repository drives the single `<repository>`
 *                  element under `<did>`.
 * @param profile   Per-standard profile selected via `getEadProfile()`
 *                  from `tenant.descriptiveStandard`.
 * @param createDate ISO-8601 timestamp recorded inside `<control>` →
 *                  `<maintenancehistory>` → `<eventdatetime>`. Format
 *                  matches what the publish pipeline already passes to
 *                  `buildMetsXml` (METS_HDR `CREATEDATE`).
 *
 * @returns EAD3 v1.1.1 document as a UTF-8 string. Empty string when
 *          `fondsRows` is empty (matches the publish pipeline's
 *          "no rows → no file" semantics for already-empty fonds slices).
 *
 * @throws  When `fondsRows` is non-empty but no row has
 *          `descriptionLevel === "fonds"` — that's a caller-side
 *          contract violation (the per-fonds slice must include the
 *          fonds row itself) and is preferable to silently emitting a
 *          finding aid with no top-of-hierarchy element.
 */
export function buildEad3(
  fondsRows: ReadonlyArray<EadInput>,
  repos: ReadonlyMap<string, EadRepository>,
  profile: EadProfile,
  createDate: string,
): string {
  if (fondsRows.length === 0) return "";

  const fonds = fondsRows.find((r) => r.descriptionLevel === "fonds");
  if (!fonds) {
    throw new Error("buildEad3: no fonds-level row in input");
  }

  const repo = repos.get(fonds.repositoryId);

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<ead xmlns="${NS_EAD}" xmlns:xlink="${NS_XLINK}" audience="external">\n`;

  // -- <control> (EAD3 replaces EAD2002's <eadheader>) -----------------------
  xml += `  <control>\n`;
  xml += `    <recordid>${escapeXml(sanitiseRefForKey(fonds.referenceCode))}</recordid>\n`;
  xml += `    <filedesc>\n`;
  xml += `      <titlestmt>\n`;
  xml += `        <titleproper>${escapeXml(fonds.title)}</titleproper>\n`;
  xml += `      </titlestmt>\n`;
  xml += `    </filedesc>\n`;
  xml += `    <maintenancestatus value="derived"/>\n`;
  xml += `    <maintenanceagency>\n`;
  xml += `      <agencyname>${escapeXml(repo?.name ?? "Fisqua")}</agencyname>\n`;
  xml += `    </maintenanceagency>\n`;
  xml += `    <maintenancehistory>\n`;
  xml += `      <maintenanceevent>\n`;
  xml += `        <eventtype value="created"/>\n`;
  xml += `        <eventdatetime>${escapeXml(createDate)}</eventdatetime>\n`;
  xml += `        <agenttype value="machine"/>\n`;
  xml += `        <agent>Fisqua publish pipeline</agent>\n`;
  xml += `      </maintenanceevent>\n`;
  xml += `    </maintenancehistory>\n`;
  xml += `  </control>\n`;

  // -- <archdesc> ------------------------------------------------------------
  xml += `  <archdesc level="${escapeXml(fonds.descriptionLevel)}">\n`;
  xml += renderDid(fonds, repo, "    ");

  // Optional <archdesc> children — EAD3 universal element order. Profiles
  // toggle inclusion only; ordering is fixed.

  // 1. <bioghist> (DACS / RAD context placement; ISAD(G) routes to <notestmt>
  //    later in the order — see step 11).
  if (profile.bioghistPlacement === "context" && fonds.adminBiogHistory) {
    xml += `    <bioghist>\n`;
    xml += `      <p>${escapeXml(fonds.adminBiogHistory)}</p>\n`;
    xml += `    </bioghist>\n`;
  }

  // 2. <scopecontent>
  if (fonds.scopeContent) {
    xml += `    <scopecontent>\n`;
    xml += `      <p>${escapeXml(fonds.scopeContent)}</p>\n`;
    xml += `    </scopecontent>\n`;
  }

  // 3. <arrangement> — gated by profile.includeSystemOfArrangement so the
  //    DACS profile (which uses the standard `arrangement` column elsewhere)
  //    doesn't double-emit. RAD turns this on; ISAD(G) and DACS leave it off.
  if (profile.includeSystemOfArrangement && fonds.systemOfArrangement) {
    xml += `    <arrangement>\n`;
    xml += `      <p>${escapeXml(fonds.systemOfArrangement)}</p>\n`;
    xml += `    </arrangement>\n`;
  }

  // 4. <accessrestrict>
  if (fonds.accessConditions) {
    xml += `    <accessrestrict>\n`;
    xml += `      <p>${escapeXml(fonds.accessConditions)}</p>\n`;
    xml += `    </accessrestrict>\n`;
  }

  // 5. <prefercite> — DACS § 7.1.5; ISAD(G) leaves this off.
  if (profile.includePreferredCitation && fonds.preferredCitation) {
    xml += `    <prefercite>\n`;
    xml += `      <p>${escapeXml(fonds.preferredCitation)}</p>\n`;
    xml += `    </prefercite>\n`;
  }

  // 6. <acqinfo> — ISAD(G) 3.2.4, DACS § 5, RAD §1.7.
  if (profile.includeAcquisitionInfo && fonds.acquisitionInfo) {
    xml += `    <acqinfo>\n`;
    xml += `      <p>${escapeXml(fonds.acquisitionInfo)}</p>\n`;
    xml += `    </acqinfo>\n`;
  }

  // 7. <phystech>
  if (fonds.physicalCharacteristics) {
    xml += `    <phystech>\n`;
    xml += `      <p>${escapeXml(fonds.physicalCharacteristics)}</p>\n`;
    xml += `    </phystech>\n`;
  }

  // 8. <notestmt> — ISAD(G) 3.4.1 places admin/biog under "Notes". The
  //    profile gates this branch so DACS and RAD (which use context
  //    placement) don't double-emit through the <bioghist> branch above.
  if (profile.bioghistPlacement === "notes" && fonds.adminBiogHistory) {
    xml += `    <notestmt>\n`;
    xml += `      <note>\n`;
    xml += `        <p>${escapeXml(fonds.adminBiogHistory)}</p>\n`;
    xml += `      </note>\n`;
    xml += `    </notestmt>\n`;
  }

  // 9. <dsc> — descendants (series/file/item/etc.) as <c> blocks.
  const descendants = fondsRows.filter((r) => r.descriptionLevel !== "fonds");
  if (descendants.length > 0) {
    xml += `    <dsc>\n`;
    for (const row of descendants) {
      xml += renderC(row, repo);
    }
    xml += `    </dsc>\n`;
  }

  xml += `  </archdesc>\n`;
  xml += `</ead>\n`;
  return xml;
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Emit `<did>` for one description row at any level (fonds or descendant).
 * `indent` is the leading whitespace before the opening `<did>` tag — fonds
 * sits at 4 spaces (under `<archdesc>`), `<c>` descendants nest deeper.
 */
function renderDid(
  row: EadInput,
  repo: EadRepository | undefined,
  indent: string,
): string {
  const inner = indent + "  ";
  let did = `${indent}<did>\n`;

  // Primary <unitid> from referenceCode (no @localtype); one secondary
  // <unitid localtype="<provider>"> per legacyId. Both flow through
  // escapeXml to mitigate T-37-02 at the provider/value attribute
  // boundary. EAD3 uses `localtype` (not EAD2002's `type`) — the RNG
  // grammar (`a.localtype` define at ead3.rng:3328) explicitly enforces
  // this. RNG validation rejects EAD2002's bare `type` here.
  did += `${inner}<unitid>${escapeXml(sanitiseRefForKey(row.referenceCode))}</unitid>\n`;
  if (row.legacyIds) {
    for (const legacy of row.legacyIds) {
      did += `${inner}<unitid localtype="${escapeXml(legacy.provider)}">${escapeXml(String(legacy.id))}</unitid>\n`;
    }
  }

  did += `${inner}<unittitle>${escapeXml(row.title)}</unittitle>\n`;

  // Null-safety: omit <unitdate> entirely when dateExpression is null.
  // An empty <unitdate></unitdate> would fail RNG validation (the
  // schema requires content).
  if (row.dateExpression) {
    did += `${inner}<unitdate>${escapeXml(row.dateExpression)}</unitdate>\n`;
  }

  if (row.creatorDisplay) {
    // EAD3 <name> requires one or more <part> children — bare text is
    // rejected by the RNG (line 1762: `<oneOrMore><ref name="e.part"/>`).
    // Wrap the creator string in a single `<part>` to satisfy the
    // grammar.
    did += `${inner}<origination><name><part>${escapeXml(row.creatorDisplay)}</part></name></origination>\n`;
  }

  if (repo) {
    // EAD3 <corpname> requires one or more <part> children for the same
    // reason as <name> above (RNG line 1663).
    did += `${inner}<repository><corpname><part>${escapeXml(repo.name)}</part></corpname></repository>\n`;
  }

  if (row.extent) {
    // EAD3 dropped EAD2002's `<extent>` element; extent is now emitted
    // either as mixed-content text inside `<physdesc>` or via the more
    // structured `<physdescstructured>` (with `<quantity>` + `<unittype>`).
    // We emit free-text inside `<physdesc>` because the source column is
    // free-text Spanish ("50 cajas") with no clean quantity/unit split.
    // The wrapping `<extent>` was removed after RNG validation
    // surfaced "Did not expect element extent there".
    did += `${inner}<physdesc>${escapeXml(row.extent)}</physdesc>\n`;
  }

  if (row.language) {
    const langName = LANGUAGE_MAP[row.language] ?? row.language;
    did += `${inner}<langmaterial><language langcode="${escapeXml(row.language)}">${escapeXml(langName)}</language></langmaterial>\n`;
  }

  did += `${indent}</did>\n`;
  return did;
}

/**
 * Emit one `<c>` block for a descendant row. The plan's fixture has
 * fonds → series → file → item (3 levels deep below fonds); we render
 * them as a flat sequence of sibling `<c>` blocks at one level of
 * `<dsc>` nesting, with the row's own `descriptionLevel` driving the
 * `level=` attribute. EAD3 RNG accepts both flat and nested `<c>`
 * structures; flat keeps the builder simple and matches what
 * downstream aggregators (ArchivesGrid, DPLA) expect from per-fonds
 * finding aids without an explicit hierarchical reconstruction step.
 *
 * (Documented in 37-03-SUMMARY.md "Structural decisions" section.)
 */
function renderC(row: EadInput, repo: EadRepository | undefined): string {
  let c = `      <c level="${escapeXml(row.descriptionLevel)}">\n`;
  c += renderDid(row, repo, "        ");
  if (row.scopeContent) {
    c += `        <scopecontent>\n`;
    c += `          <p>${escapeXml(row.scopeContent)}</p>\n`;
    c += `        </scopecontent>\n`;
  }
  c += `      </c>\n`;
  return c;
}

// el is imported for symmetry with mets-builder.ts; not currently used
// at the top level because every <archdesc> child needs <p>-wrapped
// content rather than bare element text. Kept on the import line so a
// future refactor that introduces bare-text emission has the helper in
// hand without re-import churn.
void el;

/* @version v0.4.0 */
