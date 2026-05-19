/**
 * Vitest Configuration — Node Pool for Tests Incompatible with the Workers Pool
 *
 * Some tests can't run under the Workers pool because they depend on
 * Node-only APIs that the miniflare sandbox doesn't expose. This config
 * routes those tests to the standard Node pool. Two suites currently
 * live here:
 *
 *   - `tests/schema/migrations.test.ts` — replays every migration file
 *     against an in-memory `better-sqlite3` database. The Workers pool
 *     only exposes D1 through its own binding, which doesn't accept
 *     raw SQLite files.
 *
 *   - `tests/export/ead/schema-*.test.ts`, `tests/export/ead/dacs-*.test.ts`,
 *     and `tests/export/dc/**` — exercise `xmllint-wasm` for RelaxNG
 *     validation of emitted EAD3 and Dublin Core documents. `xmllint-wasm`
 *     calls `node:fs` to load its own WASM blob, and the test fixtures
 *     themselves (`tests/fixtures/ead3/ead3.rng`) are read via
 *     `fs/promises` — neither of those work inside the Workers pool sandbox.
 *
 * Tests not matching these globs belong with the main `vitest.config.ts`
 * (Workers pool). The corresponding entries in `vitest.config.ts`'s
 * `exclude` list keep the Workers pool from also picking these up.
 *
 * @version v0.4.0
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/schema/migrations.test.ts",
      "tests/export/ead/schema-*.test.ts",
      "tests/export/ead/dacs-*.test.ts",
      "tests/export/dc/**/*.test.ts",
    ],
  },
});
