/**
 * Vitest Configuration — Workers Pool
 *
 * This is the default vitest config for tests that run inside Cloudflare's
 * Workers runtime via `@cloudflare/vitest-pool-workers`. Using the Workers
 * pool means component, route, and server-module tests execute in an
 * environment that mirrors production — D1 bindings, R2 bindings, the
 * `request` object, and the runtime `fetch` all behave as they do on the
 * edge.
 *
 * Two test suites are deliberately excluded and run under separate configs:
 * schema migration tests live in `vitest.node.config.ts` because they spin
 * up an in-memory SQLite database the Workers pool can't host, and the
 * bulk-import test suite lives in `vitest.import.config.ts` because it
 * exercises the Node-side CLI entry points rather than Worker code.
 *
 * Test-only secrets are injected via miniflare bindings so route handlers
 * that check `env.SESSION_SECRET` or GitHub OAuth credentials can execute
 * without leaking real production values.
 *
 * The `exclude` list spreads vitest's `configDefaults.exclude` first so the
 * built-in `**\/node_modules/**` exclusion stays in place — without that
 * spread, our explicit list silently replaces the defaults and vitest
 * descends into dependency packages that ship their own `*.test.ts` files
 * (notably `svix`, which dangles workerd isolates trying to resolve a
 * missing `mockttp` import).
 *
 * @version v0.6.0
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineWorkersConfig({
  // Mirrors the `~/*` -> `./app/*` mapping in tsconfig.cloudflare.json.
  // The app build resolves it via vite-tsconfig-paths in vite.config.ts,
  // but this config never loads that plugin, so route modules that use
  // `~/` imports are untestable without this alias.
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tests/schema/migrations.test.ts",
      "tests/import/**",
      // EAD3, DACS, and DC schema-validation tests use `xmllint-wasm`
      // (which calls `node:fs` for its WASM blob) and read vendored
      // RNG fixtures from disk — neither works under the Workers pool
      // sandbox. They run under `vitest.node.config.ts`.
      "tests/export/ead/schema-*.test.ts",
      "tests/export/ead/dacs-*.test.ts",
      "tests/export/dc/**/*.test.ts",
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: {
          configPath: "./wrangler.jsonc",
        },
        miniflare: {
          bindings: {
            SESSION_SECRET: "test-session-secret",
            GITHUB_CLIENT_ID: "test-github-id",
            GITHUB_CLIENT_SECRET: "test-github-secret",
            // Injected so the places-map loader tests never depend on a
            // real key being present in wrangler.jsonc vars.
            MAPTILER_KEY: "test-maptiler-key",
          },
          d1Databases: {
            DB: "my-app-db",
          },
        },
      },
    },
  },
});
