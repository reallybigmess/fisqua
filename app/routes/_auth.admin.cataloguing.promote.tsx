/**
 * Crowdsourcing Promotion Page
 *
 * This page is the superadmin workflow for promoting reviewed crowdsourcing
 * volume entries into long-lived archival descriptions. The loader
 * fetches every volume that has at least one promotable entry and,
 * when a volume is selected, its promotable-entries list and the
 * IIIF manifest URL for the placeholder viewer panel. The page itself
 * walks the operator through selecting a volume, reviewing each
 * candidate entry, defining the reference-code pattern, and
 * committing the batch; the server action writes the new descriptions
 * and records the audit trail.
 *
 * Tenant attribution comes from request context, populated by
 * `authMiddleware`. The action plumbs `tenant.id` into
 * `promoteEntries` so promoted descriptions are attributed to the
 * calling tenant rather than a single-tenant hard-code in
 * `mapEntryToDescription`.
 *
 * @version v0.4.0
 */

import { useState, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { tenantContext, userContext } from "../context";
import { VolumeSelector } from "../components/promote/volume-selector";
import { PromotionTable } from "../components/promote/promotion-table";
import { RefCodePattern } from "../components/promote/ref-code-pattern";
import { PromotionSummary } from "../components/promote/promotion-summary";
import type { Route } from "./+types/_auth.admin.cataloguing.promote";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ context, request }: Route.LoaderArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const {
    getVolumesWithPromotableEntries,
    getPromotableEntries,
  } = await import("../lib/promote/promote.server");

  const user = context.get(userContext);

  if (!user.isSuperAdmin) {
    return {
      authorized: false as const,
      volumes: [],
      selectedVolumeId: null,
      promotableEntries: [],
      alreadyPromoted: [],
      volumeManifestUrl: null,
    };
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const volumes = await getVolumesWithPromotableEntries(db);

  const url = new URL(request.url);
  const selectedVolumeId = url.searchParams.get("volumeId");

  let promotableEntries: any[] = [];
  let alreadyPromoted: any[] = [];
  let volumeManifestUrl: string | null = null;

  if (selectedVolumeId) {
    const result = await getPromotableEntries(db, selectedVolumeId);
    promotableEntries = result.promotable;
    alreadyPromoted = result.alreadyPromoted;

    // Load volume manifest URL for IIIF viewer
    const { volumes: volumesTable } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const volume = await db
      .select({ manifestUrl: volumesTable.manifestUrl })
      .from(volumesTable)
      .where(eq(volumesTable.id, selectedVolumeId))
      .get();
    volumeManifestUrl = volume?.manifestUrl ?? null;
  }

  return {
    authorized: true as const,
    volumes,
    selectedVolumeId,
    promotableEntries,
    alreadyPromoted,
    volumeManifestUrl,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ context, request }: Route.ActionArgs) {
  const { drizzle } = await import("drizzle-orm/d1");
  const { promoteEntries } = await import("../lib/promote/promote.server");

  const user = context.get(userContext);
  if (!user.isSuperAdmin) {
    return { error: "Unauthorized" };
  }
  const tenant = context.get(tenantContext);

  // Drizzle infers `tenant.descriptiveStandard` as nullable because
  // the column is NOT NULL only when `kind = 'tenant'`. The schema
  // CHECK in drizzle/0034_tenants_table.sql means a
  // `kind = 'tenant'` row CANNOT have a null standard; if we ever
  // hit this branch the tenant row is malformed (CHECK was
  // bypassed) — surface as a 500 rather than silently default to
  // ISAD-shaped output for what should be a DACS or RAD tenant.
  if (tenant.descriptiveStandard == null) {
    throw new Error(
      "Schema invariant violation: tenant.descriptiveStandard is null on a tenant route",
    );
  }

  const env = context.cloudflare.env;
  const db = drizzle(env.DB);

  const formData = await request.formData();

  let entryIds: string[];
  let referenceCodes: Record<string, string>;
  try {
    entryIds = JSON.parse(formData.get("entryIds") as string ?? "[]");
    referenceCodes = JSON.parse(formData.get("referenceCodes") as string ?? "{}");
  } catch {
    return { error: "Invalid request data" };
  }

  const entrySchema = z.object({
    entryIds: z.array(z.string().min(1)),
    referenceCodes: z.record(z.string(), z.string()),
  });
  const validated = entrySchema.safeParse({ entryIds, referenceCodes });
  if (!validated.success) {
    return { error: "Invalid input" };
  }

  const volumeId = formData.get("volumeId") as string;

  const entries = entryIds.map((id) => ({
    entryId: id,
    referenceCode: referenceCodes[id] || "",
  }));

  const manifestBaseUrl =
    (env as any).MANIFEST_BASE_URL || "https://manifests.zasqua.org";

  try {
    const result = await promoteEntries({
      db,
      manifestsBucket: env.MANIFESTS_BUCKET,
      entries,
      volumeId,
      userId: user.id,
      tenantId: tenant.id,
      // Plumb the active descriptive standard so the per-entry
      // mapping pass validates against the right schema before
      // persistence.
      standard: tenant.descriptiveStandard,
      manifestBaseUrl,
    });

    return { success: true, result };
  } catch (err: any) {
    return { error: err.message || "Promotion failed" };
  }
}

// ---------------------------------------------------------------------------
// Helper: count non-null mapped fields on an entry
// ---------------------------------------------------------------------------

const MAPPED_FIELDS = [
  "title",
  "translatedTitle",
  "resourceType",
  "dateExpression",
  "dateStart",
  "dateEnd",
  "extent",
  "scopeContent",
  "language",
  "descriptionNotes",
  "internalNotes",
  "descriptionLevel",
] as const;

function countMappedFields(entry: Record<string, any>): number {
  return MAPPED_FIELDS.filter(
    (f) => entry[f] != null && entry[f] !== ""
  ).length;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Step = "select-volume" | "select-entries" | "review";

export default function PromotePage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("promote");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const {
    authorized,
    volumes,
    selectedVolumeId,
    promotableEntries,
    alreadyPromoted,
    volumeManifestUrl,
  } = loaderData;

  // Determine initial step based on loader data
  const initialStep: Step = selectedVolumeId
    ? "select-entries"
    : "select-volume";
  const [step, setStep] = useState<Step>(initialStep);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [referenceCodes, setReferenceCodes] = useState<
    Record<string, string>
  >({});
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Not authorized guard
  if (!authorized) {
    return (
      <div className="rounded-lg border border-saffron bg-saffron-tint px-4 py-3">
        <p className="font-sans text-sm text-saffron-deep">
          Only superadmins can access this page.
        </p>
      </div>
    );
  }

  // --- Handlers ---

  function handleVolumeSelect(volumeId: string) {
    setSearchParams({ volumeId });
  }

  function handleToggle(entryId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }

  function handleToggleAll() {
    if (
      promotableEntries.length > 0 &&
      promotableEntries.every((e: any) => selectedIds.has(e.id))
    ) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(
        new Set(promotableEntries.map((e: any) => e.id))
      );
    }
  }

  function handleRefCodeChange(entryId: string, code: string) {
    setReferenceCodes((prev) => ({ ...prev, [entryId]: code }));
  }

  function handleApplyPattern(prefix: string, startNumber: number) {
    const selected = promotableEntries.filter((e: any) =>
      selectedIds.has(e.id)
    );
    const updated: Record<string, string> = { ...referenceCodes };
    selected.forEach((entry: any, i: number) => {
      const num = (startNumber + i).toString().padStart(3, "0");
      updated[entry.id] = `${prefix}${num}`;
    });
    setReferenceCodes(updated);
  }

  function handleEntryClick(entry: any) {
    setActiveEntryId(entry.id);
  }

  function handleReview() {
    if (selectedIds.size === 0) {
      setToastMessage(t("error.noSelection"));
      setTimeout(() => setToastMessage(null), 3000);
      return;
    }
    setStep("review");
  }

  async function handleConfirm() {
    setIsSubmitting(true);
    try {
      const form = new FormData();
      form.set("entryIds", JSON.stringify(Array.from(selectedIds)));
      form.set("referenceCodes", JSON.stringify(referenceCodes));
      form.set("volumeId", selectedVolumeId!);

      const response = await fetch("/admin/cataloguing/promote", {
        method: "POST",
        body: form,
      });

      const data = (await response.json()) as {
        error?: string;
        result?: { promoted?: unknown[] };
      };

      if (data.error) {
        setToastMessage(data.error);
        setTimeout(() => setToastMessage(null), 5000);
      } else if (data.result) {
        const count = data.result.promoted?.length ?? 0;
        setToastMessage(t("toast.success", { count }));
        setTimeout(() => {
          setToastMessage(null);
          // Reload to refresh data
          navigate(`/admin/cataloguing/promote?volumeId=${selectedVolumeId}`, {
            replace: true,
          });
        }, 2000);
      }
    } catch {
      setToastMessage(t("error.generic"));
      setTimeout(() => setToastMessage(null), 5000);
    } finally {
      setIsSubmitting(false);
    }
  }

  // --- Build summary entries ---

  const summaryEntries = useMemo(() => {
    return promotableEntries
      .filter((e: any) => selectedIds.has(e.id))
      .map((e: any) => ({
        entryId: e.id,
        title: e.title || "Untitled",
        referenceCode: referenceCodes[e.id] || "",
        parentReferenceCode:
          volumes.find((v) => v.id === selectedVolumeId)
            ?.referenceCode || "",
        fieldCount: countMappedFields(e),
      }));
  }, [
    promotableEntries,
    selectedIds,
    referenceCodes,
    volumes,
    selectedVolumeId,
  ]);

  // --- Build table entries with child counts ---

  const tableEntries = useMemo(() => {
    const parentIds = new Set(
      promotableEntries
        .filter((e: any) => e.parentId)
        .map((e: any) => e.parentId)
    );

    return promotableEntries.map((e: any) => ({
      id: e.id,
      title: e.title,
      startPage: e.startPage,
      endPage: e.endPage,
      parentId: e.parentId,
      promotedDescriptionId: e.promotedDescriptionId,
      childCount: promotableEntries.filter(
        (c: any) => c.parentId === e.id
      ).length,
    }));
  }, [promotableEntries]);

  const tableAlreadyPromoted = useMemo(() => {
    return alreadyPromoted.map((e: any) => ({
      id: e.id,
      title: e.title,
      startPage: e.startPage,
      endPage: e.endPage,
      parentId: e.parentId,
      promotedDescriptionId: e.promotedDescriptionId,
      childCount: 0,
    }));
  }, [alreadyPromoted]);

  return (
    <div className="space-y-6">
      {/* Page title */}
      <h1 className="font-display text-4xl font-semibold text-stone-700">
        {t("heading.title")}
      </h1>

      {/* Toast */}
      {toastMessage && (
        <div className="rounded-lg border border-stone-300 bg-white px-4 py-3 shadow-sm">
          <p className="font-sans text-sm text-stone-700">{toastMessage}</p>
        </div>
      )}

      {/* Step 1: Volume selection */}
      {step === "select-volume" && (
        <VolumeSelector
          volumes={volumes}
          onSelect={handleVolumeSelect}
        />
      )}

      {/* Step 2: Entry selection with viewer */}
      {step === "select-entries" && selectedVolumeId && (
        <div>
          <RefCodePattern onApply={handleApplyPattern} />

          <div className="flex flex-col gap-6 lg:flex-row">
            {/* Left panel: entry table (60%) */}
            <div className="w-full lg:w-3/5">
              <PromotionTable
                entries={tableEntries}
                alreadyPromoted={tableAlreadyPromoted}
                selectedIds={selectedIds}
                referenceCodes={referenceCodes}
                onToggle={handleToggle}
                onToggleAll={handleToggleAll}
                onRefCodeChange={handleRefCodeChange}
                onEntryClick={handleEntryClick}
                activeEntryId={activeEntryId}
              />

              <div className="mt-4">
                <button
                  type="button"
                  onClick={handleReview}
                  disabled={selectedIds.size === 0}
                  className="rounded bg-indigo px-6 py-2.5 font-semibold text-parchment hover:bg-indigo-deep disabled:opacity-50"
                >
                  {t("action.review")}
                </button>
              </div>
            </div>

            {/* Right panel: IIIF viewer placeholder (40%) */}
            <div className="hidden w-full border-l border-stone-300 pl-6 lg:block lg:w-2/5">
              {volumeManifestUrl ? (
                <div className="flex h-[600px] items-center justify-center rounded-lg bg-stone-100 text-sm text-stone-500">
                  <p>
                    IIIF Viewer — {volumeManifestUrl}
                  </p>
                </div>
              ) : (
                <div className="flex h-[600px] items-center justify-center rounded-lg bg-stone-100 text-sm text-stone-400">
                  <p>{t("viewer.noManifest")}</p>
                </div>
              )}
            </div>
          </div>

          {/* Back to volume selection */}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => {
                setSearchParams({});
                setStep("select-volume");
                setSelectedIds(new Set());
                setReferenceCodes({});
              }}
              className="text-sm text-stone-500 hover:text-stone-700"
            >
              {t("action.back")}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Summary preview */}
      {step === "review" && (
        <PromotionSummary
          entries={summaryEntries}
          onConfirm={handleConfirm}
          onBack={() => setStep("select-entries")}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}
