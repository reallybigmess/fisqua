/**
 * Tests — scrub-pattern coverage keystone
 *
 * This suite is the CI gate that prevents planning-label /
 * AI-tooling / developer-workspace path references from re-entering
 * the source tree. It loads every `.ts`, `.tsx`, `.css`, and `.sql`
 * source file under `app/`, `scripts/`, `drizzle/`, and `tests/`
 * via `import.meta.glob({ query: "?raw" })`, runs the canonical
 * scrub-pattern regex from `docs/guidelines/code-conventions.md`
 * against the content, and fails on any match outside the
 * known-good fixture allowlist.
 *
 * The pattern catches four classes of leak: planning labels
 * (`Phase NN`, `D-NN`, `RQ-N`, `Fase NN`, REQ-ID prefix codes —
 * `TENANT-NN`, `STD-NN`, `IMPORT-NN`, etc.), AI-tooling references
 * (`CLAUDE.md`, `.claude/`, `claude.com`, `anthropic`,
 * `co-authored-by`), developer-workspace path literals
 * (`.planning/`, `docs/fisqua/`, `../docs/`), and developer
 * home-directory absolute paths (`/Users/<user>/…`,
 * `/home/<user>/…`). The literal-path check is what surfaced the
 * runtime path leak in `scripts/reconcile-volume-status.ts` during
 * v0.4 release prep; the `docs/fisqua/` / `../docs/` arms were added
 * after two source comments citing a private `../docs/fisqua/...`
 * audit path reached the public repo in the v0.4.0 port; and the
 * home-directory arm was added after `scripts/backfill/backfill.ts`
 * shipped a hardcoded `/Users/…` default path to the public repo
 * through the v0.5.0 port.
 *
 * Case-sensitive on purpose: the REQ-ID prefix codes and planning
 * labels are uppercase by convention (`TENANT-01`, `Phase 33`),
 * and matching them case-insensitively would mis-flag ordinary
 * lowercase test-fixture data like `"tenant-1"` and
 * `"viaf-import-2026"`.
 *
 * Allowlist: the `referenceCode: "LOAD-001"` and `"PLOAD-001"`
 * fixture literals in `tests/admin/entities.test.ts` and
 * `tests/admin/places.test.ts` are intentional test data — they
 * match the `D-[0-9]{1,3}` substring (`D-001`) without being
 * planning labels. Any other allowlist entry needs a comment
 * explaining why the false-positive is intentional, and ideally
 * a referenced incident so the next maintainer understands.
 *
 * @version v0.6.0
 */

import { describe, it, expect } from "vitest";

// Case-sensitive regex. The convention is uppercase REQ-IDs and
// title-case "Phase NN" / "Plan NN"; ordinary lowercase strings
// that happen to contain "tenant-1" or "import-2026" are NOT
// planning labels and must not trip the gate.
const SCRUB_PATTERN =
  /Phase [0-9]+|Plan [0-9]+|RQ-[0-9]+|AI-SPEC|RESEARCH\.md|UI-SPEC|scratchpad|GSD|gsd-|TENANT-[0-9]+|STD-[0-9]+|IMPORT-[0-9]+|PARITY-[0-9]+|NORM-[0-9]+|SCHEMA-[0-9]+|CONTRACT-[0-9]+|VERIFY-[0-9]+|MODIFIED-[0-9]+|CUTOVER-[0-9]+|Fase [0-9]+|Claude Code|claude code|claude\.com|claude\.ai|Anthropic|anthropic|Co-Authored-By|co-authored-by|CLAUDE\.md|\.claude\/|\.planning\/|docs\/fisqua\/|\.\.\/docs\/|\/Users\/[A-Za-z0-9._-]+|\/home\/[a-z][A-Za-z0-9._-]+/g;

// Allowlisted false positives. Each entry MUST carry a comment
// explaining why the substring is intentional.
const FALSE_POSITIVE_SUBSTRINGS: ReadonlyArray<{
  match: string;
  reason: string;
}> = [
  {
    match: "LOAD-001",
    reason:
      "Test fixture reference code in tests/admin/entities.test.ts; matches D-[0-9]{1,3} via the D-001 substring but is not a planning label.",
  },
  {
    match: "PLOAD-001",
    reason:
      "Test fixture reference code in tests/admin/places.test.ts; same rationale as LOAD-001.",
  },
];

function lineContainsOnlyAllowlistedHits(line: string): boolean {
  // The line matched SCRUB_PATTERN. Strip any allowlisted substring
  // and re-test — if the remaining string no longer matches, the
  // line is a pure false positive.
  let stripped = line;
  for (const fp of FALSE_POSITIVE_SUBSTRINGS) {
    stripped = stripped.split(fp.match).join("");
  }
  SCRUB_PATTERN.lastIndex = 0;
  return !SCRUB_PATTERN.test(stripped);
}

// Vite's `import.meta.glob` resolves patterns relative to the
// importing file. The keystone sits at `tests/scrub-coverage.test.ts`,
// so `../app/**/...` reaches the source tree. The pattern mirrors
// the established style in `tests/standards/no-hardcoded-standards.test.ts`
// and `tests/db/cross-tenant-coverage.test.ts`.
const appTs = import.meta.glob("../app/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const appTsx = import.meta.glob("../app/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const appCss = import.meta.glob("../app/**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const scriptsTs = import.meta.glob("../scripts/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const drizzleSql = import.meta.glob("../drizzle/**/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const testsTs = import.meta.glob("../tests/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const testsTsx = import.meta.glob("../tests/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Merge and drop this file itself — the regex literal here would
// otherwise self-match. The exclusion is structural, not semantic.
const sources: Record<string, string> = {
  ...appTs,
  ...appTsx,
  ...appCss,
  ...scriptsTs,
  ...drizzleSql,
  ...testsTs,
  ...testsTsx,
};

const SELF_PATH_SUBSTRING = "scrub-coverage.test.ts";
for (const path of Object.keys(sources)) {
  if (path.includes(SELF_PATH_SUBSTRING)) {
    delete sources[path];
  }
}

describe("scrub-pattern coverage keystone", () => {
  it("loads a non-trivial number of source files", () => {
    // Defensive — catches the failure mode where the import.meta.glob
    // paths quietly resolve to nothing and the main scan trivially
    // passes. The dev tree has 600+ source files; if this assertion
    // breaks, the glob paths drifted and the gate is silently
    // ineffective.
    expect(Object.keys(sources).length).toBeGreaterThan(500);
  });

  it("source tree carries no planning-label, AI-tooling, or workspace-path references", () => {
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const [path, content] of Object.entries(sources)) {
      const lines = content.split("\n");
      lines.forEach((line, idx) => {
        SCRUB_PATTERN.lastIndex = 0;
        if (SCRUB_PATTERN.test(line)) {
          if (!lineContainsOnlyAllowlistedHits(line)) {
            violations.push({ file: path, line: idx + 1, text: line.trim() });
          }
        }
      });
    }

    if (violations.length > 0) {
      const message = violations
        .slice(0, 50)
        .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
        .join("\n");
      const tail =
        violations.length > 50
          ? `\n  ... and ${violations.length - 50} more`
          : "";
      throw new Error(
        `Scrub-pattern violations (${violations.length}):\n${message}${tail}\n\n` +
          "Either remove the planning-label / AI-tooling / workspace-path\n" +
          "reference, or — if the match is a genuine false positive — add\n" +
          "an entry to FALSE_POSITIVE_SUBSTRINGS in this file with a\n" +
          "comment explaining the rationale.",
      );
    }

    expect(violations).toHaveLength(0);
  });

  it("the canonical regex still rejects an obvious leak", () => {
    // Defensive smoke check: if a future refactor accidentally
    // neuters SCRUB_PATTERN (drops a critical character class, for
    // example), this assertion catches it before the main check
    // gives a false-clean.
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test("See .planning/debug/foo.md")).toBe(true);
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test("per CLAUDE.md")).toBe(true);
    SCRUB_PATTERN.lastIndex = 0;
    // Private workspace-doc path references must trip the gate (the
    // v0.4.0 leak: a source comment citing `../docs/fisqua/...`).
    expect(
      SCRUB_PATTERN.test("see ../docs/fisqua/releases/0.4/audit.md"),
    ).toBe(true);
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test("docs/fisqua/releases/0.4.0/notes.md")).toBe(true);
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test("Phase 33: read impersonation envelope")).toBe(
      true,
    );
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test("a perfectly clean source line")).toBe(false);
    SCRUB_PATTERN.lastIndex = 0;
    // Case-sensitive: lowercase fixture data must not trip.
    expect(SCRUB_PATTERN.test('const id = "viaf-import-2026";')).toBe(false);
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test('const t = "id-wrong-tenant-1";')).toBe(false);
    SCRUB_PATTERN.lastIndex = 0;
    // Developer home-directory absolute paths must trip the gate (the
    // v0.5.0 leak: backfill.ts shipped a `/Users/…` default path).
    expect(SCRUB_PATTERN.test('const p = "/Users/alice/code/foo";')).toBe(true);
    SCRUB_PATTERN.lastIndex = 0;
    expect(SCRUB_PATTERN.test('const p = "/home/runner/work/x";')).toBe(true);
  });
});
