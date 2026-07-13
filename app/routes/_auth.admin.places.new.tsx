/**
 * Places Admin — Create
 *
 * This page is the create form for a new place authority record. It captures the
 * essential identity fields -- label, display name, place type,
 * country -- plus optional coordinates and a parent-place pointer for
 * hierarchical places (town within province within gobernación). The
 * server action mints an `nl-xxxxxx` place code and inserts the row.
 * Historical administrative divisions and external authority links
 * are editable on the edit page.
 *
 * Authority scope is the federation (migrations 0045-0048): the new place row
 * is attributed to the session tenant's federation (`tenant.federationId`).
 *
 * @version v0.4.2
 */

import { useState } from "react";
import { Form, useActionData, redirect, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { NameVariantInput } from "~/components/forms/name-variant-input";
import { LodLinkField } from "~/components/forms/lod-link-field";
import { CoordinateInput } from "~/components/forms/coordinate-input";
import { PLACE_TYPES } from "~/lib/validation/enums";
import type { Route } from "./+types/_auth.admin.places.new";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  return {};
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { places } = await import("~/db/schema");
  const { createPlaceSchema } = await import("~/lib/validation/place");
  const { generateUniqueCode } = await import("~/lib/codes.server");

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  // Authority mutation gate (ruled 2026-07-08): creating a place is a
  // canonical authority mutation subject to federation steward review.
  // Member-tenant admins keep READ access to shared places elsewhere but
  // are denied here. Behaviour-neutral today (lead admin = steward).
  const { requireFederationSteward } = await import("~/lib/federation.server");
  await requireFederationSteward(db, user, tenant);

  const formData = await request.formData();

  // Parse form values
  const label = (formData.get("label") as string)?.trim() || undefined;
  const displayName =
    (formData.get("displayName") as string)?.trim() || undefined;
  const placeType =
    (formData.get("placeType") as string)?.trim() || undefined;
  const nameVariantsRaw = formData.get("nameVariants") as string;
  const parentId =
    (formData.get("parentId") as string)?.trim() || undefined;
  // historical_gobernacion, historical_partido, historical_region,
  // country_code, admin_level_1, admin_level_2, wikidata_id all dropped
  // on places in 0036 (0% populated in production audit).
  const coordinatePrecision =
    (formData.get("coordinatePrecision") as string)?.trim() || undefined;

  // Parse coordinates
  const latStr = (formData.get("latitude") as string)?.trim();
  const lngStr = (formData.get("longitude") as string)?.trim();
  const latitude = latStr ? parseFloat(latStr) : null;
  const longitude = lngStr ? parseFloat(lngStr) : null;

  // LOD identifiers
  const tgnId =
    (formData.get("tgnId") as string)?.trim() || undefined;
  const hgisId =
    (formData.get("hgisId") as string)?.trim() || undefined;
  const whgId =
    (formData.get("whgId") as string)?.trim() || undefined;
  // wikidataId dropped on places in 0036.

  // Auto-generate place code
  const placeCode = await generateUniqueCode(
    db,
    "nl",
    places,
    places.placeCode
  );

  const parsed = createPlaceSchema.safeParse({
    placeCode,
    label,
    displayName,
    placeType: placeType || null,
    nameVariants: nameVariantsRaw || "[]",
    parentId: parentId || null,
    latitude: latitude != null && !isNaN(latitude) ? latitude : null,
    longitude: longitude != null && !isNaN(longitude) ? longitude : null,
    coordinatePrecision,
    tgnId: tgnId || null,
    hgisId: hgisId || null,
    whgId: whgId || null,
  });

  if (!parsed.success) {
    return {
      ok: false as const,
      errors: parsed.error.flatten().fieldErrors,
    };
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    await db.insert(places).values({
      federationId: tenant.federationId,
      id,
      ...parsed.data,
      nameVariants: parsed.data.nameVariants ?? "[]",
      parentId: parsed.data.parentId ?? null,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
      tgnId: parsed.data.tgnId ?? null,
      hgisId: parsed.data.hgisId ?? null,
      whgId: parsed.data.whgId ?? null,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed")) {
      return { ok: false as const, error: "duplicate_code" };
    }
    return { ok: false as const, error: "generic" };
  }

  return redirect(`/admin/places/${id}`);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function NewPlacePage() {
  const actionData = useActionData<typeof action>();
  const { t } = useTranslation("places");

  const errors =
    actionData && "errors" in actionData ? actionData.errors : undefined;
  const globalError =
    actionData && "error" in actionData ? actionData.error : undefined;

  // Controlled state for complex fields
  const [nameVariants, setNameVariants] = useState<string[]>([]);
  const [latitude, setLatitude] = useState<number | null>(null);
  const [longitude, setLongitude] = useState<number | null>(null);
  const [precision, setPrecision] = useState("approximate");
  const [tgnId, setTgnId] = useState("");
  const [hgisId, setHgisId] = useState("");
  const [whgId, setWhgId] = useState("");
  // wikidataId dropped on places in 0036.

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex items-center gap-1">
          <li>
            <Link
              to="/admin/places"
              className="text-stone-500 hover:text-stone-700"
            >
              {t("title")}
            </Link>
          </li>
          <li>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </li>
          <li className="text-stone-700">{t("breadcrumbNew")}</li>
        </ol>
      </nav>

      {/* Title */}
      <h1 className="font-serif text-2xl font-semibold text-stone-700">
        {t("createTitle")}
      </h1>

      {/* Error banner */}
      {globalError && (
        <div className="mt-4 rounded-md border border-indigo bg-indigo-tint px-4 py-3 text-sm text-stone-700">
          {globalError === "duplicate_code"
            ? t("errorDuplicateCode")
            : t("errorGeneric")}
        </div>
      )}

      {/* Form card */}
      <div className="mt-6 rounded-lg border border-stone-200 bg-white p-6">
        <Form method="post">
          {/* Hidden fields for complex inputs */}
          <input
            type="hidden"
            name="nameVariants"
            value={JSON.stringify(nameVariants)}
          />
          <input
            type="hidden"
            name="latitude"
            value={latitude != null ? String(latitude) : ""}
          />
          <input
            type="hidden"
            name="longitude"
            value={longitude != null ? String(longitude) : ""}
          />
          <input
            type="hidden"
            name="coordinatePrecision"
            value={precision}
          />
          <input type="hidden" name="tgnId" value={tgnId} />
          <input type="hidden" name="hgisId" value={hgisId} />
          <input type="hidden" name="whgId" value={whgId} />

          {/* Identity */}
          <CollapsibleSection title={t("sectionIdentity")}>
            <div className="space-y-4">
              <FieldInput
                name="label"
                label={t("field.label")}
                required
                error={errors?.label?.[0]}
              />
              <FieldInput
                name="displayName"
                label={t("field.displayName")}
                required
                error={errors?.displayName?.[0]}
              />
              <div>
                <label className="mb-1 block text-xs font-medium text-indigo">
                  {t("field.placeCode")}
                </label>
                <input
                  type="text"
                  disabled
                  placeholder={t("autoGenerated")}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-400 disabled:cursor-not-allowed disabled:bg-stone-50"
                />
                <p className="mt-1 text-xs text-stone-500">
                  {t("autoGenerated")}
                </p>
              </div>
              <div>
                <label
                  htmlFor="placeType"
                  className="mb-1 block text-xs font-medium text-indigo"
                >
                  {t("field.placeType")}
                  <span className="text-madder"> *</span>
                </label>
                <select
                  id="placeType"
                  name="placeType"
                  aria-required="true"
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
                >
                  <option value="">--</option>
                  {PLACE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(type)}
                    </option>
                  ))}
                </select>
                {errors?.placeType?.[0] && (
                  <p className="mt-1 text-xs text-madder">
                    {errors.placeType[0]}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-indigo">
                  {t("field.nameVariants")}
                </label>
                <NameVariantInput
                  value={nameVariants}
                  onChange={setNameVariants}
                  addLabel={t("addVariant")}
                />
              </div>
              <FieldInput
                name="parentId"
                label={t("field.parentId")}
                error={errors?.parentId?.[0]}
              />
            </div>
          </CollapsibleSection>

          {/* Historical Context section removed alongside the column
              drops in drizzle/0036_union_schema.sql —
              historicalGobernacion, historicalPartido,
              historicalRegion all dropped (0% populated). */}

          {/* Modern Geography & LOD */}
          <CollapsibleSection title={t("sectionGeography")}>
            <div className="space-y-4">
              {/* countryCode, adminLevel1, adminLevel2 dropped on
                  places in 0036 (0% populated). */}
              <CoordinateInput
                latitude={latitude}
                longitude={longitude}
                precision={precision}
                onLatChange={setLatitude}
                onLngChange={setLongitude}
                onPrecisionChange={setPrecision}
              />
              <LodLinkField
                label={t("field.tgnId")}
                value={tgnId}
                onChange={setTgnId}
                service="tgn"
              />
              <LodLinkField
                label={t("field.hgisId")}
                value={hgisId}
                onChange={setHgisId}
                service="hgis"
              />
              <LodLinkField
                label={t("field.whgId")}
                value={whgId}
                onChange={setWhgId}
                service="whg"
              />
              {/* wikidataId dropped on places in 0036 (0% populated). */}
            </div>
          </CollapsibleSection>

          {/* Actions */}
          <div className="mt-6 flex gap-3">
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("createSubmit")}
            </button>
            <Link
              to="/admin/places"
              className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("backButton")}
            </Link>
          </div>
        </Form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form field components
// ---------------------------------------------------------------------------

function FieldInput({
  name,
  label,
  required,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  required?: boolean;
  defaultValue?: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
        {required && <span className="text-madder"> *</span>}
      </label>
      <input
        type="text"
        id={name}
        name={name}
        defaultValue={defaultValue}
        aria-required={required ? "true" : undefined}
        aria-describedby={errorId}
        className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
      />
      {error && (
        <p id={errorId} className="mt-1 text-xs text-madder">
          {error}
        </p>
      )}
    </div>
  );
}
