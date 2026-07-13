/**
 * Places Admin — Split workbench (full-page)
 *
 * The full-viewport split surface for place authorities (spec §4,
 * handoff surface 2). Every splittable field is assigned Original /
 * Both / New; external identifiers (TGN, HGIS, WHG) are exactly-one-
 * side; coordinates are a deliberate choice rather than the old
 * verbatim copy (spec §2 defect); both halves get distinct names; and
 * linked descriptions are divided by rich context card, grouped by
 * description. The original is updated in place, a new record is
 * inserted, and the required reason lands in the ledger row's
 * `detail.reason`.
 *
 * @version v0.4.3
 */

import { useTranslation } from "react-i18next";
import { redirect, useActionData } from "react-router";
import { tenantContext, userContext } from "../context";
import { requireCapability } from "../lib/tenant";
import {
  SplitWorkbench,
  type SplitFieldRow,
} from "~/components/admin/split-workbench";
import type { Route } from "./+types/_auth.admin.places.$id.split";

type Choice = "original" | "both" | "new";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { places } = await import("~/db/schema");
  const { loadLinkedDescriptionCards } = await import(
    "~/lib/authority-linked-context.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");

  const db = drizzle(context.cloudflare.env.DB);
  const id = params.id;

  const place = await db
    .select()
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
    .get();
  if (!place) throw new Response("Not found", { status: 404 });

  const cards = await loadLinkedDescriptionCards(db, {
    recordType: "place",
    ownerId: id,
    displayName: place.displayName,
  });

  return { place, cards };
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const { requireAdmin } = await import("~/lib/permissions.server");
  const { drizzle } = await import("drizzle-orm/d1");
  const { and, eq } = await import("drizzle-orm");
  const { places, descriptionPlaces } = await import("~/db/schema");
  const { requireFederationSteward } = await import("~/lib/federation.server");
  const { generateUniqueCode } = await import("~/lib/codes.server");
  const { logAuthorityOperation } = await import(
    "~/lib/authority-operations.server"
  );

  const user = context.get(userContext);
  requireAdmin(user);
  const tenant = context.get(tenantContext);
  requireCapability(tenant, "authorities");
  const db = drizzle(context.cloudflare.env.DB);
  await requireFederationSteward(db, user, tenant);

  const id = params.id;
  const formData = await request.formData();

  const reason = (formData.get("reason") as string)?.trim() || "";
  if (!reason) return { ok: false as const, error: "reason" as const };

  const nameA = (formData.get("nameA") as string)?.trim() || "";
  const nameB = (formData.get("nameB") as string)?.trim() || "";
  if (!nameA || !nameB || nameA === nameB) {
    return { ok: false as const, error: "names" as const };
  }

  let choices: Record<string, Choice> = {};
  try {
    choices = JSON.parse((formData.get("choices") as string) || "{}");
  } catch {
    choices = {};
  }

  let linkIds: string[] = [];
  try {
    linkIds = JSON.parse((formData.get("linkIds") as string) || "[]");
  } catch {
    linkIds = [];
  }

  const source = await db
    .select()
    .from(places)
    .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id)))
    .get();
  if (!source) return { ok: false as const, error: "generic" as const };

  const formUpdatedAt = formData.get("_updatedAt") as string;
  const forceOverwrite = formData.get("_force") === "true";
  if (!forceOverwrite && formUpdatedAt && String(source.updatedAt) !== formUpdatedAt) {
    return { ok: false as const, error: "conflict" as const, modifiedAt: source.updatedAt };
  }

  let sourceVariants: string[] = [];
  try {
    sourceVariants = JSON.parse(source.nameVariants || "[]");
  } catch {
    sourceVariants = [];
  }

  // Full-assignment enforcement: rebuild the expected field-key set
  // server-side (the same enumerated assignable rows the loader
  // renders) and require every key to carry a valid choice. A missing
  // key rejects — an empty `choices` object must not silently null out
  // the surviving original's fields. External-ID rows are exactly-one-
  // side (spec §4): "both" is rejected for them.
  const threeStateKeys = [
    "coordinates",
    ...sourceVariants.map((_, i) => `variant:${i}`),
  ];
  const twoSidedKeys = ["tgnId", "hgisId", "whgId"];
  for (const key of threeStateKeys) {
    const c = choices[key];
    if (c !== "original" && c !== "both" && c !== "new") {
      return { ok: false as const, error: "unassigned" as const };
    }
  }
  for (const key of twoSidedKeys) {
    const c = choices[key];
    if (c === "both") {
      return { ok: false as const, error: "invalid_choice" as const };
    }
    if (c !== "original" && c !== "new") {
      return { ok: false as const, error: "unassigned" as const };
    }
  }

  const toNew = (key: string) => choices[key] === "new" || choices[key] === "both";
  const toOrig = (key: string) => choices[key] === "original" || choices[key] === "both";
  const origVariants: string[] = [];
  const newVariants: string[] = [];
  sourceVariants.forEach((v, i) => {
    const key = `variant:${i}`;
    if (toOrig(key)) origVariants.push(v);
    if (toNew(key)) newVariants.push(v);
  });

  // Each link must belong to the record BEING SPLIT — a crafted linkId
  // pointing at another record's junction row is skipped, never
  // repointed (the same ownership discipline as the merge action).
  // `inArray` on an empty list is a D1 error, so guard it. The ledger's
  // movedLinks counts only verified rows.
  let verifiedLinkIds: string[] = [];
  if (linkIds.length > 0) {
    const { inArray } = await import("drizzle-orm");
    const owned = await db
      .select({ id: descriptionPlaces.id })
      .from(descriptionPlaces)
      .where(
        and(
          inArray(descriptionPlaces.id, linkIds),
          eq(descriptionPlaces.placeId, id),
        ),
      )
      .all();
    verifiedLinkIds = owned.map((r) => r.id);
  }

  const newCode = await generateUniqueCode(db, "nl", places, places.placeCode);
  const newId = crypto.randomUUID();
  const timestamp = Date.now();

  await db.batch([
    db.insert(places).values({
      federationId: tenant.federationId,
      id: newId,
      placeCode: newCode,
      label: nameB,
      displayName: nameB,
      placeType: source.placeType,
      nameVariants: JSON.stringify(newVariants),
      parentId: source.parentId,
      latitude: toNew("coordinates") ? source.latitude : null,
      longitude: toNew("coordinates") ? source.longitude : null,
      coordinatePrecision: toNew("coordinates") ? source.coordinatePrecision : null,
      mergedInto: null,
      tgnId: choices.tgnId === "new" ? source.tgnId : null,
      hgisId: choices.hgisId === "new" ? source.hgisId : null,
      whgId: choices.whgId === "new" ? source.whgId : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    db
      .update(places)
      .set({
        label: nameA,
        displayName: nameA,
        nameVariants: JSON.stringify(origVariants),
        latitude: toOrig("coordinates") ? source.latitude : null,
        longitude: toOrig("coordinates") ? source.longitude : null,
        coordinatePrecision: toOrig("coordinates") ? source.coordinatePrecision : null,
        tgnId: choices.tgnId === "original" ? source.tgnId : null,
        hgisId: choices.hgisId === "original" ? source.hgisId : null,
        whgId: choices.whgId === "original" ? source.whgId : null,
        updatedAt: timestamp,
      })
      .where(and(eq(places.federationId, tenant.federationId), eq(places.id, id))),
    ...verifiedLinkIds.map((linkId) =>
      db
        .update(descriptionPlaces)
        .set({ placeId: newId })
        .where(
          and(
            eq(descriptionPlaces.id, linkId),
            eq(descriptionPlaces.placeId, id),
          ),
        ),
    ),
    logAuthorityOperation(db, {
      federationId: tenant.federationId,
      recordType: "place",
      operation: "split",
      sourceId: id,
      targetId: newId,
      userId: user.id,
      detail: { reason, choices, movedLinks: verifiedLinkIds.length, nameA, nameB },
    }),
  ] as any);

  return redirect(`/admin/places/${id}`);
}

export default function PlaceSplitWorkbench({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("authorities");
  const { t: tp } = useTranslation("places");
  const actionData = useActionData<typeof action>();
  const { place, cards } = loaderData;

  const coordValue =
    place.latitude != null && place.longitude != null
      ? `${place.latitude}, ${place.longitude}`
      : null;

  const fieldRows: SplitFieldRow[] = [
    { key: "coordinates", label: tp("field.latitude"), value: coordValue, mode: "three" },
    { key: "tgnId", label: tp("field.tgnId"), value: place.tgnId, mode: "twoSided" },
    { key: "hgisId", label: tp("field.hgisId"), value: place.hgisId, mode: "twoSided" },
    { key: "whgId", label: tp("field.whgId"), value: place.whgId, mode: "twoSided" },
  ];

  let variants: string[] = [];
  try {
    variants = JSON.parse(place.nameVariants || "[]");
  } catch {
    variants = [];
  }
  const nameVariantRows: SplitFieldRow[] = variants.map((v, i) => ({
    key: `variant:${i}`,
    label: `${tp("field.nameVariants")}: ${v}`,
    value: null,
    mode: "three",
  }));

  const conflictModifiedAt =
    actionData && "error" in actionData && actionData.error === "conflict"
      ? actionData.modifiedAt
      : null;

  return (
    <SplitWorkbench
      eyebrow={t("mergeEyebrowPlaces")}
      record={place.displayName}
      recordCode={place.placeCode ?? ""}
      cards={cards}
      showAsRecorded={false}
      roleLabel={(role) => tp(`role_${role}`, role)}
      placeRoleLabel={(role) => tp(`role_${role}`, role)}
      fieldRows={fieldRows}
      nameVariantRows={nameVariantRows}
      initialName={place.displayName}
      nameLabel={tp("field.displayName")}
      recordUpdatedAt={place.updatedAt}
      conflictModifiedAt={conflictModifiedAt}
      t={t}
    />
  );
}
