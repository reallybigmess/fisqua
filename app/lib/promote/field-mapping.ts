/**
 * Promotion Field Mapping
 *
 * This module deals with the canonical list of fields promotion
 * copies from a crowdsourced volume entry into the long-lived
 * archival description. It is the single source of truth so the
 * promote action, the preview table, and the per-field validation
 * stay in lockstep.
 *
 * The explicit `tenantId` field on `PromotionInput` lets the action
 * plumb the request-boundary tenant from
 * `context.get(tenantContext).id` rather than relying on the older
 * single-tenant hard-code.
 *
 * The function also takes a `standard: Standard` parameter so callers
 * can validate the produced description against the active
 * descriptive standard via
 * `descriptionValidatorFor(standard, "item").safeParse(...)` BEFORE
 * persistence — every write boundary runs the per-standard validator.
 * The body is unchanged: every output column exists for every
 * standard via the union schema, so the same field map covers
 * ISAD(G), DACS, and RAD; the parameter exists to plumb the active
 * standard through to the validator at the caller boundary, not to
 * fork the field map itself. Without this, a fresh DACS or RAD tenant
 * with `crowdsourcing_enabled` would produce ISAD-shaped promoted
 * descriptions; with it, a DACS tenant promoting an item gets a
 * DACS-validated description.
 *
 * @version v0.4.0
 */
import type { PromotionInput, PromotionOutput } from "./types";
import { RESOURCE_TYPE_MAP } from "./types";
import type { Standard } from "../standards/types";

/**
 * Pure mapping function: transforms a crowdsourcing entry into a partial
 * description object and a manifest specification.
 *
 * Maps the 12 shared fields, renames descriptionNotes to notes,
 * forces descriptionLevel to "item", and translates Spanish resource
 * type enums to English.
 *
 * The `standard` parameter is plumbed through to the caller's
 * validator boundary; it does NOT alter the field map (the union
 * schema means every output column exists for every standard). See
 * file header for the rationale.
 *
 * No I/O — all database writes and manifest uploads happen in the caller.
 */
export function mapEntryToDescription(
  input: PromotionInput,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  standard: Standard,
): PromotionOutput {
  const {
    entry,
    assignedReferenceCode,
    repositoryId,
    parentDescriptionId,
    rootDescriptionId,
    parentDepth,
    parentPathCache,
    userId,
    tenantId,
  } = input;

  const mappedResourceType = entry.resourceType
    ? (RESOURCE_TYPE_MAP[entry.resourceType] ?? undefined)
    : undefined;

  const title = entry.title ?? "Untitled";

  return {
    description: {
      tenantId,
      repositoryId,
      parentId: parentDescriptionId,
      rootDescriptionId,
      position: 0, // computed by caller based on existing children
      depth: parentDepth + 1,
      childCount: 0,
      pathCache: parentPathCache
        ? `${parentPathCache} > ${title}`
        : title,
      descriptionLevel: "item", // always item
      resourceType: mappedResourceType as any,
      referenceCode: assignedReferenceCode,
      localIdentifier: assignedReferenceCode,
      title,
      translatedTitle: entry.translatedTitle ?? undefined,
      dateExpression: entry.dateExpression ?? undefined,
      dateStart: entry.dateStart ?? undefined,
      dateEnd: entry.dateEnd ?? undefined,
      extent: entry.extent ?? undefined,
      scopeContent: entry.scopeContent ?? undefined,
      language: entry.language ?? undefined,
      notes: entry.descriptionNotes ?? undefined, // renamed
      internalNotes: entry.internalNotes ?? undefined, // direct
      hasDigital: true,
      isPublished: false, // staff publishes later
      iiifManifestUrl: undefined, // set after manifest upload
      createdBy: userId,
      updatedBy: userId,
    },
    manifestSpec: {
      referenceCode: assignedReferenceCode,
      title,
      startPage: entry.startPage,
      startY: entry.startY,
      endPage: entry.endPage ?? null,
      endY: entry.endY ?? null,
    },
  };
}

/* @version v0.4.0 */
