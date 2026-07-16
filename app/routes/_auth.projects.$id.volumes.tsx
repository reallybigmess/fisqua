/**
 * Project Volumes Page
 *
 * This page is the leads-only volume management surface for one
 * project. It lists every volume the project holds — each one
 * rendered as a `VolumeCard` with its status,
 * assignments, and open-QC-flag count denormalised at read time so the
 * page can render in a single round-trip. Leads can add new volumes
 * from a IIIF manifest URL here; per-volume deep management lives on
 * the `$volumeId/manage` page.
 *
 * @version v0.4.2
 */

import { useState } from "react";
import { Form, useActionData } from "react-router";
import { useTranslation, Trans } from "react-i18next";
import { userContext } from "../context";
import { VolumeCard } from "../components/volumes/volume-card";
import type { Route } from "./+types/_auth.projects.$id.volumes";

type AddResult = {
  url: string;
  success: boolean;
  error?: string;
  volumeName?: string;
  pageCount?: number;
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProjectVolumes } = await import("../lib/volumes.server");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Only leads (and admins) can access volume management
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const volumes = await getProjectVolumes(db, params.id);
  return { volumes, projectId: params.id };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { requireProjectRole } = await import("../lib/permissions.server");
  const { getProjectVolumes, createVolume, deleteVolume } = await import("../lib/volumes.server");
  const { validateManifestUrl, parseManifest } = await import("../lib/iiif.server");
  const { getInstance } = await import("~/middleware/i18next");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);
  const i18n = getInstance(context);

  // Only leads (and admins) can mutate volumes
  await requireProjectRole(db, user.id, params.id, ["lead"], user.isAdmin);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "add-volumes": {
      const rawUrls = (formData.get("manifestUrls") as string) || "";
      const urls = rawUrls
        .split("\n")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      if (urls.length === 0) {
        return { _action: "add-volumes" as const, results: [] as AddResult[], error: i18n.t("project:error.at_least_one_url") };
      }

      const results: AddResult[] = [];

      for (const url of urls) {
        // Validate URL format and host
        const validation = validateManifestUrl(url, env);
        if (!validation.valid) {
          results.push({ url, success: false, error: validation.error });
          continue;
        }

        // Parse manifest
        try {
          const manifest = await parseManifest(url);
          await createVolume(db, params.id, manifest);
          results.push({
            url,
            success: true,
            volumeName: manifest.name,
            pageCount: manifest.pageCount,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : i18n.t("project:error.process_manifest_failed");
          results.push({ url, success: false, error: message });
        }
      }

      return { _action: "add-volumes" as const, results };
    }

    case "delete-volume": {
      const volumeId = formData.get("volumeId") as string;
      if (!volumeId) {
        return { _action: "delete-volume" as const, error: i18n.t("project:error.volume_id_required") };
      }

      try {
        await deleteVolume(db, volumeId);
        return { _action: "delete-volume" as const, deleted: true };
      } catch (err) {
        if (err instanceof Response) {
          const text = await err.text();
          return { _action: "delete-volume" as const, error: text };
        }
        return { _action: "delete-volume" as const, error: i18n.t("project:error.delete_failed") };
      }
    }

    default:
      return { error: i18n.t("project:error.unknown_action") };
  }
}

export default function ProjectVolumes({ loaderData }: Route.ComponentProps) {
  const { volumes, projectId } = loaderData;
  const actionData = useActionData<typeof action>();
  const [showAddForm, setShowAddForm] = useState(false);
  const { t } = useTranslation(["project", "common"]);

  const addResults =
    actionData && "_action" in actionData && actionData._action === "add-volumes" && "results" in actionData
      ? (actionData.results as AddResult[])
      : null;

  const addError =
    actionData && "_action" in actionData && actionData._action === "add-volumes" && "error" in actionData
      ? (actionData.error as string)
      : null;

  const deleteError =
    actionData && "_action" in actionData && actionData._action === "delete-volume" && "error" in actionData
      ? (actionData.error as string)
      : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-2xl font-semibold text-stone-700">{t("project:heading.volumes")}</h2>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
        >
          {showAddForm ? t("common:button.cancel") : t("project:volumes.add_volumes")}
        </button>
      </div>

      {/* Delete error */}
      {deleteError && (
        <p className="mt-3 text-sm text-madder-deep">{deleteError}</p>
      )}

      {/* Add form panel */}
      {showAddForm && (
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
          <Form method="post">
            <input type="hidden" name="_action" value="add-volumes" />
            <label
              htmlFor="manifestUrls"
              className="block font-sans text-sm font-medium text-indigo"
            >
              {t("project:volumes.manifest_urls")}
            </label>
            <textarea
              id="manifestUrls"
              name="manifestUrls"
              rows={4}
              placeholder={t("project:volumes.manifest_placeholder")}
              className="mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
            {addError && (
              <p className="mt-2 font-sans text-sm text-madder-deep">{addError}</p>
            )}
            <button
              type="submit"
              className="mt-3 rounded-md bg-indigo px-4 py-2 font-sans text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("project:volumes.add_volumes")}
            </button>
          </Form>

          {/* Results */}
          {addResults && addResults.length > 0 && (
            <div className="mt-4 space-y-2">
              <h3 className="text-sm font-medium text-stone-700">{t("project:heading.results")}</h3>
              {addResults.map((result, i) => (
                <div
                  key={i}
                  className={`rounded-md px-3 py-2 text-sm ${
                    result.success
                      ? "bg-verdigris-tint text-verdigris-deep"
                      : "bg-madder-tint text-madder-deep"
                  }`}
                >
                  {result.success ? (
                    <Trans
                      i18nKey="project:volumes.added"
                      values={{ name: result.volumeName, count: result.pageCount }}
                      components={{ strong: <strong /> }}
                    />
                  ) : (
                    <span>
                      <span className="break-all font-mono text-xs">
                        {result.url}
                      </span>
                      {" -- "}
                      {result.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Volume grid */}
      {volumes.length === 0 ? (
        <div className="mt-6 rounded-lg border border-stone-200 bg-stone-50 p-8 text-center">
          <p className="font-sans text-sm text-stone-400">
            {t("project:empty.no_volumes_add")}
          </p>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {volumes.map((volume) => (
            // `openQcFlagCount` is carried inside `volume` (from getProjectVolumes)
            // and surfaces as a red "N open flags" badge on the card when non-zero.
            <VolumeCard key={volume.id} volume={volume} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
}

