/**
 * Account Configuration Page
 *
 * This page is the personal account preferences surface for the
 * signed-in user: display name, locale, and notification toggles.
 * Scoped to the caller — no
 * administrative surfaces live here. Reachable from the sidebar
 * footer and the top-bar user menu.
 *
 * @version v0.3.0
 */

import { useState } from "react";
import { Form, useActionData } from "react-router";
import { useTranslation } from "react-i18next";
import { Github } from "lucide-react";
import { userContext } from "../context";
import type { Route } from "./+types/_auth.configuracion";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  return { user };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { eq } = await import("drizzle-orm");
  const { users } = await import("~/db/schema");

  const user = context.get(userContext);
  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();
  const intent = formData.get("_action") as string;

  switch (intent) {
    case "updateProfile": {
      const name = (formData.get("name") as string || "").trim();

      await db
        .update(users)
        .set({
          name: name || null,
          updatedAt: Date.now(),
        })
        .where(eq(users.id, user.id));

      return { ok: true, intent: "updateProfile" };
    }

    default:
      return { ok: false, error: "Unknown action" };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConfiguracionPage({
  loaderData,
}: Route.ComponentProps) {
  const { user } = loaderData;
  const actionData = useActionData<typeof action>();
  const { t, i18n } = useTranslation("settings");
  const [activeLang, setActiveLang] = useState(i18n.language?.startsWith("es") ? "es" : "en");

  function handleLanguageChange(lang: string) {
    i18n.changeLanguage(lang);
    setActiveLang(lang);
    try {
      localStorage.setItem("i18nextLng", lang);
    } catch {
      // localStorage may not be available
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      <h1 className="font-display text-4xl font-semibold text-stone-700">
        {t("title")}
      </h1>

      {/* Success feedback */}
      {actionData?.ok && actionData?.intent === "updateProfile" && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-verdigris bg-verdigris-tint px-4 py-3 font-sans text-sm text-stone-700">
          {t("saved")}
        </div>
      )}

      {/* Profile section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("profile")}
        </h2>
        <Form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="_action" value="updateProfile" />
          <div>
            <label
              htmlFor="settings-name"
              className="block font-sans text-xs font-medium text-indigo"
            >
              {t("name")}
            </label>
            <input
              type="text"
              id="settings-name"
              name="name"
              defaultValue={user.name || ""}
              className="mt-1 block w-full max-w-sm rounded-lg border border-stone-200 px-3 py-2 font-sans text-sm shadow-sm focus:border-indigo focus:ring-1 focus:ring-indigo focus:outline-none"
            />
          </div>
          <div>
            <span className="block font-sans text-xs font-medium text-stone-500">
              {t("email")}
            </span>
            <p className="mt-1 font-sans text-sm text-stone-500">
              {user.email}
            </p>
          </div>
          <button
            type="submit"
            className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
          >
            {t("save")}
          </button>
        </Form>
      </div>

      {/* Language section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("language")}
        </h2>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => handleLanguageChange("es")}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              activeLang === "es"
                ? "bg-indigo text-parchment"
                : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {t("language_es")}
          </button>
          <button
            type="button"
            onClick={() => handleLanguageChange("en")}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              activeLang === "en"
                ? "bg-indigo text-parchment"
                : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
            }`}
          >
            {t("language_en")}
          </button>
        </div>
      </div>

      {/* Connected accounts section */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("connected_accounts")}
        </h2>
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Github className="h-5 w-5 text-stone-700" />
            <span className="font-sans text-sm text-stone-700">GitHub</span>
          </div>
          {user.githubId ? (
            <span className="font-sans text-sm font-medium text-verdigris">
              {t("github_connected")}
            </span>
          ) : (
            <a
              href="/auth/github"
              className="font-sans text-sm font-medium text-indigo hover:underline"
            >
              {t("github_connect")}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
