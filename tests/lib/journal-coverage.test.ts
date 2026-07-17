/**
 * Tests - journal coverage (the stewardship keystone meta-grep)
 *
 * This suite is the structural backstop for the stewardship record
 * (spec §6): every INSERT / UPDATE / DELETE on a JOURNALED table or its
 * junctions must EITHER compose a journal entry (call
 * `composeJournalEntry`) in the same handler, OR appear on an explicit,
 * commented allowlist. A new mutation site that does neither fails CI
 * here, before review. The point is not that every site journals TODAY
 * (stewardship stage 1 only wires the import write path; the hand-edit
 * surfaces close in stage 2) - it is that a NEW un-journaled site cannot
 * appear SILENTLY.
 *
 * Precedent: `tests/db/cross-tenant-coverage.test.ts` and
 * `tests/operator/audit-coverage.test.ts` are the two keystones this
 * mirrors - same `import.meta.glob({ query: '?raw' })` raw-string read
 * (the workers-pool sandbox blocks `node:fs`), same enclosing-scope
 * capture, same empty-array failure-message convention, same
 * scanner-as-pure-function shape so the scanner is unit-testable
 * without the live glob.
 *
 * ## Journaled tables
 *
 * The stewardship journal (spec §3) records field-level effects on the
 * record tables the `changelog` covers today and link-level effects on
 * the description junctions:
 *
 *   - descriptions, entities, places, repositories (record-level:
 *     create / update / delete)
 *   - description_entities, description_places (junctions: link / unlink)
 *
 * Deliberately OUT of scope: `vocabulary_terms` and `entity_functions`
 * (structural authority events are the `authority_operations` ledger's
 * remit, spec §1) and every non-journaled table. If a future schema
 * change brings another table under the journal, extend JOURNALED_TABLES
 * in lockstep with the migration.
 *
 * ## What counts as "journaled" - per-scope COUNT pairing
 *
 * Mutation sites are grouped by their enclosing handler scope, and a
 * scope is compliant only if its `composeJournalEntry(` occurrence
 * count is >= its mutation-statement count against journaled tables.
 * This is SOURCE-LEVEL PAIRING, not data-flow matching: the scanner
 * cannot prove a given journal call describes a given mutation, only
 * that the scope pairs one composer occurrence per mutation occurrence.
 * A loop containing one mutation + one journal call passes (correctly -
 * both repeat together); a handler with one journal call and two
 * mutation statements FAILS, because the second statement has no paired
 * composition and the count deficit is exactly the silent-site shape
 * this keystone polices. Under-paired scopes enter the tally like fully
 * unjournaled ones, with the scope's counts in the failure message.
 *
 * The legacy `createChangelogEntry(` (the non-atomic separate-insert
 * pattern) is INTENTIONALLY NOT a marker: the sites that call it are on
 * the allowlist precisely because stage 2 converts them to atomic
 * composition (spec §3). Treating the old pattern as coverage would
 * freeze the migration it is meant to drive.
 *
 * ## Known evasion shapes OUT OF SCOPE (do not mistake the guarantee)
 *
 * The scanner is a reviewer aid over source text, not a sandbox. It
 * does NOT catch:
 *
 *   - aliased table objects (`const t = descriptions; db.update(t)`)
 *   - dynamic member access (`db[verb](tables[name])`)
 *   - lowercase or multi-line raw SQL (`sql\`update\n  descriptions\``
 *     splits the verb from the table across lines)
 *   - helper indirection (a helper that performs the mutation while the
 *     journal call sits in a different function's scope - each scope is
 *     scored independently, so the helper's scope fails, but a helper
 *     OUTSIDE the globbed surface would be invisible)
 *
 * None of these shapes exist in the codebase today; introducing one to
 * dodge the keystone is a review-time offence, not a scanner bug.
 *
 * ## Allowlist - seeded with every currently-un-journaled site
 *
 * Keyed by `file|verb|table`, each entry carries the COUNT of exempt
 * occurrences and a justification. Count-based (not line-based) so it is
 * robust to line drift while still catching a NEW occurrence: adding a
 * second `update(descriptions)` to an already-allowlisted file bumps the
 * actual count past the allowed count and fails. When stage 2 converts a
 * hand-edit site to `composeJournalEntry`, drop its count here (the
 * stale-entry assertion enforces the tightening).
 *
 * Every current site is un-journaled: stewardship stage 1 (this module)
 * wires ONLY the import write path, which lands in a later phase with
 * its own journal composition. The hand-edit surfaces below close in
 * stage 2. Reviewers: adding to this list is a deliberate decision -
 * each entry must justify why the site does not (yet) journal.
 *
 * @version v0.6.0
 */
import { describe, it, expect } from "vitest";

// The mutation surface: every route + lib source file. Junctions and
// record tables are mutated across the admin routes and a couple of lib
// subsystems (promote, export); globbing both namespaces catches them
// all. Test files are filtered out in the scanner.
const routeFiles = import.meta.glob(
  "../../app/routes/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const libFiles = import.meta.glob(
  "../../app/lib/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/**
 * The journaled tables, in both the Drizzle camelCase identifier form
 * (`update(descriptions)`) and the raw-SQL snake_case form
 * (`UPDATE descriptions`). MUST stay in lockstep with the schema and
 * with the journal's record-type coverage (spec §3).
 */
const JOURNALED_TABLES: ReadonlyArray<{ drizzle: string; raw: string }> = [
  { drizzle: "descriptions", raw: "descriptions" },
  { drizzle: "entities", raw: "entities" },
  { drizzle: "places", raw: "places" },
  { drizzle: "repositories", raw: "repositories" },
  { drizzle: "descriptionEntities", raw: "description_entities" },
  { drizzle: "descriptionPlaces", raw: "description_places" },
];

const DRIZZLE_TO_TABLE = new Map(
  JOURNALED_TABLES.map((t) => [t.drizzle, t.drizzle]),
);
const RAW_TO_TABLE = new Map(
  JOURNALED_TABLES.map((t) => [t.raw, t.drizzle]),
);

/** The journal-composition marker (see the header - the OLD pattern does not count). */
const JOURNAL_MARKER = "composeJournalEntry(";

interface AllowlistEntry {
  /** `file|verb|table` key. */
  key: string;
  /** Number of exempt un-journaled occurrences currently at this key. */
  count: number;
  /** Why this site does not (yet) compose a journal entry. */
  reason: string;
}

// Path prefix every glob key shares; entries below omit it for brevity.
const P = "../../app/";

/**
 * Seeded 2026-07-12 from the live mutation surface. Every entry is a
 * hand-edit or pipeline site that predates the stewardship journal;
 * all close in stage 2 (spec §5) unless marked structural. Counts were
 * generated by enumerating `(insert|update|delete)(<table>)` and the one
 * raw-SQL `UPDATE descriptions` across app/routes + app/lib.
 */
const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  // --- Description editor: single-record CRUD + its junction editors.
  //     Hand edits today call the legacy createChangelogEntry for field
  //     updates; link/unlink + delete are traceless. All close in stage 2.
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|update|descriptions`, count: 3, reason: "Description hand-edit save + republish/unpublish toggles; legacy createChangelogEntry, non-atomic. Stage 2." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|delete|descriptions`, count: 1, reason: "Description hard delete; traceless today (survey §5). Stage 2 writes a delete pre-image row." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|insert|descriptionEntities`, count: 1, reason: "Manual entity link; recorded nowhere today (survey §8). Stage 2 writes a link row." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|update|descriptionEntities`, count: 3, reason: "Manual entity-link edits (role/sequence); un-journaled today. Stage 2." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|delete|descriptionEntities`, count: 1, reason: "Manual entity unlink; recorded nowhere today. Stage 2 writes an unlink row." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|insert|descriptionPlaces`, count: 1, reason: "Manual place link; recorded nowhere today. Stage 2 writes a link row." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|update|descriptionPlaces`, count: 1, reason: "Manual place-link edit; un-journaled today. Stage 2." },
  { key: `${P}routes/_auth.admin.descriptions.$id.tsx|delete|descriptionPlaces`, count: 1, reason: "Manual place unlink; recorded nowhere today. Stage 2 writes an unlink row." },

  // --- Description list/tree bulk operations (move, reorder, bulk
  //     publish, bulk delete). Hierarchy + status mutations; structural
  //     cache recompute is derived, not journaled content.
  { key: `${P}routes/_auth.admin.descriptions.tsx|update|descriptions`, count: 6, reason: "Tree move/reorder/bulk-publish field + position updates. Stage 2 (bulk edits become runs, spec §5 stage 4)." },
  { key: `${P}routes/_auth.admin.descriptions.tsx|delete|descriptions`, count: 1, reason: "Bulk/tree delete; traceless today. Stage 2." },
  { key: `${P}routes/_auth.admin.descriptions.tsx|updateRaw|descriptions`, count: 1, reason: "Raw recursive-CTE UPDATE of root_description_id/depth on move - structural cache, deterministically derived, NOT journaled content (spec §3 updated_at/cache discipline)." },

  // --- New-description create path.
  { key: `${P}routes/_auth.admin.descriptions.new.tsx|insert|descriptions`, count: 1, reason: "Description create; no create row today. Stage 2 writes a create snapshot + created_by." },
  { key: `${P}routes/_auth.admin.descriptions.new.tsx|update|descriptions`, count: 1, reason: "Post-insert structural fixup (parent childCount/path) on create. Stage 2." },

  // --- Entity authority editor + create/merge/split. Merge/split
  //     already write the authority_operations ledger (structural); the
  //     field/link effects are the journal's stage-2 remit.
  { key: `${P}routes/_auth.admin.entities.$id.tsx|update|entities`, count: 1, reason: "Entity hand-edit save; legacy createChangelogEntry, non-atomic. Stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.tsx|delete|entities`, count: 1, reason: "Entity delete; authority_operations ledger records the structural event, journal delete row is stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.tsx|insert|descriptionEntities`, count: 1, reason: "Link a description to this entity; un-journaled today. Stage 2 link row." },
  { key: `${P}routes/_auth.admin.entities.$id.tsx|update|descriptionEntities`, count: 1, reason: "Edit an entity link; un-journaled today. Stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.tsx|delete|descriptionEntities`, count: 1, reason: "Unlink a description from this entity; un-journaled today. Stage 2 unlink row." },
  { key: `${P}routes/_auth.admin.entities.new.tsx|insert|entities`, count: 1, reason: "Entity create; no create row today (no created_by columns, survey §2). Stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.merge.tsx|update|entities`, count: 2, reason: "Merge: winner update + loser tombstone. authority_operations ledger records it; junction moves are stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.merge.tsx|update|descriptionEntities`, count: 1, reason: "Merge relinks junctions to the winner; captured in the ledger's movedLinks detail, not the journal. Stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.merge.tsx|delete|descriptionEntities`, count: 1, reason: "Merge drops conflicting junctions; captured in the ledger's droppedLinks detail. Stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.split.tsx|insert|entities`, count: 1, reason: "Split mints a new entity; authority_operations ledger records it. Stage 2 create row." },
  { key: `${P}routes/_auth.admin.entities.$id.split.tsx|update|entities`, count: 1, reason: "Split updates the parent entity; ledger-recorded. Stage 2." },
  { key: `${P}routes/_auth.admin.entities.$id.split.tsx|update|descriptionEntities`, count: 1, reason: "Split moves junctions to the new entity; ledger movedLinks. Stage 2." },

  // --- Place authority editor + create/merge/split (mirror of entities).
  { key: `${P}routes/_auth.admin.places.$id.tsx|update|places`, count: 1, reason: "Place hand-edit save; legacy createChangelogEntry, non-atomic. Stage 2." },
  { key: `${P}routes/_auth.admin.places.$id.tsx|delete|places`, count: 1, reason: "Place delete; authority_operations ledger records the structural event. Stage 2 delete row." },
  { key: `${P}routes/_auth.admin.places.$id.tsx|insert|descriptionPlaces`, count: 1, reason: "Link a description to this place; un-journaled today. Stage 2 link row." },
  { key: `${P}routes/_auth.admin.places.$id.tsx|update|descriptionPlaces`, count: 1, reason: "Edit a place link; un-journaled today. Stage 2." },
  { key: `${P}routes/_auth.admin.places.$id.tsx|delete|descriptionPlaces`, count: 1, reason: "Unlink a description from this place; un-journaled today. Stage 2 unlink row." },
  { key: `${P}routes/_auth.admin.places.new.tsx|insert|places`, count: 1, reason: "Place create; no create row today. Stage 2." },
  { key: `${P}routes/_auth.admin.places.$id.merge.tsx|update|places`, count: 2, reason: "Merge: winner update + loser tombstone; ledger-recorded. Stage 2 junction rows." },
  { key: `${P}routes/_auth.admin.places.$id.merge.tsx|update|descriptionPlaces`, count: 1, reason: "Merge relinks junctions to the winner; ledger movedLinks. Stage 2." },
  { key: `${P}routes/_auth.admin.places.$id.merge.tsx|delete|descriptionPlaces`, count: 1, reason: "Merge drops conflicting junctions; ledger droppedLinks. Stage 2." },
  { key: `${P}routes/_auth.admin.places.$id.split.tsx|insert|places`, count: 1, reason: "Split mints a new place; ledger-recorded. Stage 2 create row." },
  { key: `${P}routes/_auth.admin.places.$id.split.tsx|update|places`, count: 1, reason: "Split updates the parent place; ledger-recorded. Stage 2." },
  { key: `${P}routes/_auth.admin.places.$id.split.tsx|update|descriptionPlaces`, count: 1, reason: "Split moves junctions to the new place; ledger movedLinks. Stage 2." },

  // --- Repository editor + create.
  { key: `${P}routes/_auth.admin.repositories.$id.tsx|update|repositories`, count: 1, reason: "Repository hand-edit save; legacy createChangelogEntry, non-atomic. Stage 2." },
  { key: `${P}routes/_auth.admin.repositories.$id.tsx|delete|repositories`, count: 1, reason: "Repository delete; traceless today. Stage 2 delete row." },
  { key: `${P}routes/_auth.admin.repositories.new.tsx|insert|repositories`, count: 1, reason: "Repository create; no create row today. Stage 2." },

  // --- Vocabulary review re-links entities to a merged term; the entity
  //     row's function fields change as a side effect.
  { key: `${P}routes/_auth.admin.vocabularies.review.tsx|update|entities`, count: 1, reason: "Vocab review remaps entity primary_function on term merge; ledger-adjacent. Stage 2." },
  { key: `${P}routes/_auth.admin.vocabularies.functions.$id.tsx|update|entities`, count: 2, reason: "Function-vocabulary rename cascades to entity function fields; legacy createChangelogEntry. Stage 2." },

  // --- Promote pipeline: crowdsourced entry -> published description.
  //     A bulk write path that predates the journal; folds into the
  //     import/run model in stage 4 (spec §5).
  { key: `${P}lib/promote/promote.server.ts|insert|descriptions`, count: 1, reason: "Promote creates a published description from a crowdsourced entry; no create row today. Stage 4 (becomes a run)." },
  { key: `${P}lib/promote/promote.server.ts|update|descriptions`, count: 1, reason: "Promote back-links the source entry / structural fixup; un-journaled today. Stage 4." },

  // --- Export: METS emission stamps last_exported_at. Housekeeping
  //     write, not editorial content - not journaled by design.
  { key: `${P}lib/export/mets-export.server.ts|update|descriptions`, count: 1, reason: "Stamps last_exported_at after a successful export; housekeeping metadata, not editorial content - not journaled by design." },
];

interface Violation {
  file: string;
  line: number;
  verb: string;
  table: string;
  problem: "unjournaled-not-allowlisted" | "count-increased";
  snippet: string;
}

const FUNC_START =
  /^\s*(export\s+)?(async\s+)?function\s+|^\s*export\s+(async\s+)?function\s+|^\s*export\s+const\s+\w+\s*=\s*(async\s*)?\(/;

/**
 * Resolve the enclosing-scope START line for a mutation site: walk
 * backward (bounded) to the nearest function boundary. Sites sharing a
 * start line share a scope - that grouping is what the per-scope count
 * comparison scores. The journal composer for an atomic write lives in
 * the SAME db.batch as the mutation, i.e. the same handler, so the
 * scope is the pairing unit. Bounds mirror the cross-tenant keystone.
 */
function scopeStartFor(lines: string[], siteIdx: number): number {
  const maxBackward = 400;
  const backStart = Math.max(0, siteIdx - maxBackward);
  for (let i = siteIdx - 1; i >= backStart; i--) {
    if (FUNC_START.test(lines[i])) return i;
  }
  return backStart;
}

/**
 * Count `composeJournalEntry(` occurrences in the scope beginning at
 * `scopeStart` (through the next function boundary or a bounded
 * window). Comment-stripped, so a commented-out composer call cannot
 * satisfy the pairing.
 */
function countJournalCallsInScope(lines: string[], scopeStart: number): number {
  const maxForward = 600;
  const hardEnd = Math.min(lines.length, scopeStart + maxForward);
  let count = 0;
  for (let i = scopeStart; i < hardEnd; i++) {
    if (i > scopeStart && FUNC_START.test(lines[i])) break;
    const visible = stripComment(lines[i]);
    if (!visible) continue;
    let idx = visible.indexOf(JOURNAL_MARKER);
    while (idx !== -1) {
      count++;
      idx = visible.indexOf(JOURNAL_MARKER, idx + JOURNAL_MARKER.length);
    }
  }
  return count;
}

/**
 * Strip a `//` line comment or a `*` / `/*` block-comment continuation
 * so an example in a comment does not register as a mutation site.
 */
function stripComment(line: string): string {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return line;
}

/**
 * Scan a `{ file: rawContent }` map for un-journaled mutation sites,
 * tallying occurrences per `file|verb|table` key and comparing against
 * the allowlist. Pure function - unit tests feed synthetic fixtures.
 *
 * Detects two forms per line:
 *   - Drizzle:  `insert|update|delete(<camelTable>)`
 *   - raw SQL:  `INSERT INTO|UPDATE|DELETE FROM <snake_table>` (verb
 *               `updateRaw`/`insertRaw`/`deleteRaw` so a raw structural
 *               write is allowlistable independently of Drizzle writes
 *               to the same table in the same file).
 *
 * Sites are grouped by enclosing scope and scored by the per-scope
 * count comparison (module header): a scope whose journal-call count
 * is >= its mutation-site count is compliant and none of its sites are
 * tallied. A scope that fails the comparison contributes ALL its sites
 * to the tally - one journal call must not mask sibling un-journaled
 * mutations - and each such site's snippet carries the scope's counts.
 * Everything tallied must be covered by an allowlist entry with a
 * matching-or-greater count.
 */
export function scanForJournalCoverage(
  files: Record<string, string>,
  allowlist: ReadonlyArray<AllowlistEntry>,
): { violations: Violation[]; tally: Map<string, number> } {
  const drizzleVerbs = "(insert|update|delete)";
  const drizzleTables = `(${[...DRIZZLE_TO_TABLE.keys()].join("|")})`;
  const drizzleRegex = new RegExp(
    `\\b${drizzleVerbs}\\(\\s*${drizzleTables}\\s*\\)`,
  );
  const rawTables = `(${[...RAW_TO_TABLE.keys()].join("|")})`;
  const rawRegex = new RegExp(
    `\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${rawTables}\\b`,
  );

  const tally = new Map<string, number>();
  const siteLines: Array<{
    file: string;
    line: number;
    verb: string;
    table: string;
    snippet: string;
  }> = [];

  for (const [file, content] of Object.entries(files)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;

    const lines = content.split("\n");

    // Pass 1: find every mutation site and its enclosing scope start.
    const fileSites: Array<{
      line: number; // 0-based
      verb: string;
      table: string;
      scopeStart: number;
      snippet: string;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      const visible = stripComment(lines[i]);
      if (!visible) continue;

      let verb: string | null = null;
      let table: string | null = null;

      const d = drizzleRegex.exec(visible);
      if (d) {
        verb = d[1];
        table = DRIZZLE_TO_TABLE.get(d[2])!;
      } else {
        const r = rawRegex.exec(visible);
        if (r) {
          const rawVerb = r[1].startsWith("INSERT")
            ? "insertRaw"
            : r[1].startsWith("DELETE")
              ? "deleteRaw"
              : "updateRaw";
          verb = rawVerb;
          table = RAW_TO_TABLE.get(r[2])!;
        }
      }

      if (!verb || !table) continue;

      fileSites.push({
        line: i,
        verb,
        table,
        scopeStart: scopeStartFor(lines, i),
        snippet: visible.trim().slice(0, 160),
      });
    }

    // Pass 2: group sites by scope and apply the count comparison. A
    // compliant scope (journalCalls >= mutationCount) drops all its
    // sites; a failing scope tallies all of them, annotated with the
    // counts when the scope journals SOME writes (the masking shape).
    const scopeGroups = new Map<number, typeof fileSites>();
    for (const site of fileSites) {
      const group = scopeGroups.get(site.scopeStart) ?? [];
      group.push(site);
      scopeGroups.set(site.scopeStart, group);
    }

    for (const [scopeStart, group] of scopeGroups) {
      const journalCalls = countJournalCallsInScope(lines, scopeStart);
      if (journalCalls >= group.length) continue;

      const countsNote =
        journalCalls > 0
          ? `[scope pairs ${journalCalls} journal call(s) against ${group.length} mutation site(s)] `
          : "";
      for (const site of group) {
        const key = `${file}|${site.verb}|${site.table}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
        siteLines.push({
          file,
          line: site.line + 1,
          verb: site.verb,
          table: site.table,
          snippet: `${countsNote}${site.snippet}`,
        });
      }
    }
  }

  // Compare the tally against the allowlist.
  const allowMap = new Map(allowlist.map((e) => [e.key, e.count]));
  const violations: Violation[] = [];

  // Group site lines by key so a count overrun reports the surplus sites.
  const sitesByKey = new Map<string, typeof siteLines>();
  for (const s of siteLines) {
    const key = `${s.file}|${s.verb}|${s.table}`;
    const arr = sitesByKey.get(key) ?? [];
    arr.push(s);
    sitesByKey.set(key, arr);
  }

  for (const [key, actual] of tally) {
    const allowed = allowMap.get(key) ?? 0;
    if (actual > allowed) {
      // Report the surplus occurrences (the ones beyond the allowed count).
      const sites = sitesByKey.get(key) ?? [];
      for (const s of sites.slice(allowed)) {
        violations.push({
          file: s.file,
          line: s.line,
          verb: s.verb,
          table: s.table,
          problem: allowed === 0 ? "unjournaled-not-allowlisted" : "count-increased",
          snippet: s.snippet,
        });
      }
    }
  }

  return { violations, tally };
}

describe("journal coverage on mutations of journaled tables", () => {
  const allFiles = { ...routeFiles, ...libFiles } as Record<string, string>;

  it("every un-journaled mutation site is on the allowlist (no new silent sites)", () => {
    const { violations } = scanForJournalCoverage(allFiles, ALLOWLIST);
    const formatted = violations
      .map(
        (v) =>
          `  ${v.file}:${v.line}: [${v.problem}] ${v.verb}(${v.table})  ${v.snippet}`,
      )
      .join("\n");
    expect(
      violations,
      `Un-journaled mutation sites on journaled tables that are not covered by the allowlist:\n${formatted}\n\n` +
        `Either compose a journal entry (call composeJournalEntry in the same db.batch as the mutation - ` +
        `see app/lib/stewardship.server.ts), or add a \`file|verb|table\` entry to ALLOWLIST in this test ` +
        `with a one-line justification. A count-increased problem means an already-allowlisted key gained an ` +
        `occurrence - bump its count only if the new site is legitimately un-journaled.`,
    ).toEqual([]);
  });

  it("no stale allowlist entries (allowed count exceeds actual - tighten)", () => {
    const { tally } = scanForJournalCoverage(allFiles, ALLOWLIST);
    const stale = ALLOWLIST.filter((e) => (tally.get(e.key) ?? 0) < e.count).map(
      (e) => `${e.key} (allowed ${e.count}, actual ${tally.get(e.key) ?? 0})`,
    );
    expect(
      stale,
      `Stale ALLOWLIST entries - the site was journaled or removed, so lower or drop the count:\n${stale.join("\n")}`,
    ).toEqual([]);
  });
});

describe("scanner unit tests (synthetic fixtures)", () => {
  it("un-journaled mutation with no allowlist entry surfaces as a violation", () => {
    const fixture: Record<string, string> = {
      "synthetic/edit.tsx": [
        "export async function action() {",
        "  await db.update(descriptions).set({ title }).where(eq(descriptions.id, id));",
        "  return null;",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("unjournaled-not-allowlisted");
    expect(violations[0].verb).toBe("update");
    expect(violations[0].table).toBe("descriptions");
  });

  it("a site that composes a journal entry in-scope is not a violation", () => {
    const fixture: Record<string, string> = {
      "synthetic/journaled.tsx": [
        "export async function action() {",
        "  await db.batch([",
        "    db.update(descriptions).set({ title }).where(eq(descriptions.id, id)),",
        "    composeJournalEntry(db, { recordId: id, kind: 'update', diff }),",
        "  ]);",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toEqual([]);
  });

  it("one journal call does NOT mask a sibling mutation - under-paired scope fails with counts", () => {
    // The masking shape the adversarial review confirmed: a handler
    // journaling ONE write while performing TWO. Both sites must
    // surface, each annotated with the scope's pairing counts.
    const fixture: Record<string, string> = {
      "synthetic/masked.tsx": [
        "export async function action() {",
        "  await db.batch([",
        "    db.update(descriptions).set({ title }).where(eq(descriptions.id, a)),",
        "    composeJournalEntry(db, { recordId: a, kind: 'update', diff }),",
        "  ]);",
        "  await db.delete(descriptionEntities).where(eq(descriptionEntities.id, b));",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toHaveLength(2);
    for (const v of violations) {
      expect(v.problem).toBe("unjournaled-not-allowlisted");
      expect(v.snippet).toContain(
        "[scope pairs 1 journal call(s) against 2 mutation site(s)]",
      );
    }
    expect(violations.map((v) => `${v.verb}|${v.table}`).sort()).toEqual([
      "delete|descriptionEntities",
      "update|descriptions",
    ]);
  });

  it("a loop with one mutation + one journal call passes (source-level pairing)", () => {
    const fixture: Record<string, string> = {
      "synthetic/loop.tsx": [
        "export async function commitBatch(rows) {",
        "  for (const row of rows) {",
        "    statements.push(db.update(descriptions).set(row).where(eq(descriptions.id, row.id)));",
        "    statements.push(composeJournalEntry(db, { recordId: row.id, kind: 'update', diff: row.diff }));",
        "  }",
        "  await db.batch(statements);",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toEqual([]);
  });

  it("an allowlisted site at its exact count passes", () => {
    const fixture: Record<string, string> = {
      "synthetic/legacy.tsx": [
        "export async function action() {",
        "  await db.delete(descriptions).where(eq(descriptions.id, id));",
        "}",
      ].join("\n"),
    };
    const allow: AllowlistEntry[] = [
      { key: "synthetic/legacy.tsx|delete|descriptions", count: 1, reason: "test" },
    ];
    const { violations } = scanForJournalCoverage(fixture, allow);
    expect(violations).toEqual([]);
  });

  it("a second occurrence beyond the allowed count surfaces as count-increased", () => {
    const fixture: Record<string, string> = {
      "synthetic/legacy.tsx": [
        "export async function action() {",
        "  await db.delete(descriptions).where(eq(descriptions.id, a));",
        "  await db.delete(descriptions).where(eq(descriptions.id, b));",
        "}",
      ].join("\n"),
    };
    const allow: AllowlistEntry[] = [
      { key: "synthetic/legacy.tsx|delete|descriptions", count: 1, reason: "test" },
    ];
    const { violations } = scanForJournalCoverage(fixture, allow);
    expect(violations).toHaveLength(1);
    expect(violations[0].problem).toBe("count-increased");
  });

  it("raw-SQL mutation is detected with a *Raw verb and snake_case table", () => {
    const fixture: Record<string, string> = {
      "synthetic/raw.tsx": [
        "export async function action() {",
        "  await db.run(sql`UPDATE descriptions SET depth = depth + 1 WHERE id = ${id}`);",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toHaveLength(1);
    expect(violations[0].verb).toBe("updateRaw");
    expect(violations[0].table).toBe("descriptions");
  });

  it("a comment example does not register as a mutation site", () => {
    const fixture: Record<string, string> = {
      "synthetic/comment.tsx": [
        "export async function action() {",
        "  // await db.delete(descriptions).where(eq(descriptions.id, id));",
        "  return null;",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toEqual([]);
  });

  it("non-journaled tables are ignored", () => {
    const fixture: Record<string, string> = {
      "synthetic/other.tsx": [
        "export async function action() {",
        "  await db.insert(vocabularyTerms).values({ canonical });",
        "  await db.update(users).set({ name }).where(eq(users.id, id));",
        "}",
      ].join("\n"),
    };
    const { violations } = scanForJournalCoverage(fixture, []);
    expect(violations).toEqual([]);
  });
});
