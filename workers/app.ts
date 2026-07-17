/**
 * Worker Entry Point
 *
 * This is the first piece of code that runs when a request hits the Fisqua
 * app on Cloudflare's edge. Every request — page load, API call, form
 * submission — enters here and gets forwarded to React Router, which then
 * routes it to the right loader, action, or server module.
 *
 * The handler does two jobs. First, it wraps the Cloudflare request context
 * (the `env` bindings declared in `wrangler.jsonc` and the runtime
 * `ExecutionContext`) into React Router's typed `RouterContextProvider` so
 * loaders and actions can read `context.get(cloudflareContext).env.DB` to
 * reach D1, or `.MANIFESTS_BUCKET` to reach R2. Second, it re-exports the
 * `PublishExportWorkflow` class so Cloudflare's Workflows runtime can find
 * and instantiate it when a publish job is kicked off from the admin UI.
 *
 * The `virtual:react-router/server-build` import is a build-time virtual
 * module produced by the React Router Vite plugin — it contains the compiled
 * server build for the app and is resolved during the bundle step, not at
 * runtime.
 *
 * @version v0.6.0
 */

import { createRequestHandler, RouterContextProvider } from "react-router";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
  interface RouterContextProvider {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

// Re-export the workflow classes so the wrangler `workflows` bindings
// (PUBLISH_EXPORT / IMPORT_COMMIT) can resolve them by class_name.
export { PublishExportWorkflow } from "../app/workflows/publish-export";
export { ImportCommitWorkflow } from "../app/workflows/import-commit";
export { ImportRevertWorkflow } from "../app/workflows/import-revert";

export default {
  async fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    (context as any).cloudflare = { env, ctx };
    return requestHandler(request, context);
  },
} satisfies ExportedHandler<Env>;
