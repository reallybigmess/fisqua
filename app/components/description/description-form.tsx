/**
 * Description Form (cataloguing / segmentation)
 *
 * This form is the per-entry cataloguing surface rendered inside the
 * segmentation viewer for tenants with `crowdsourcing_enabled`. Each
 * entry is one segmented documentary unit a cataloguer carved out of a
 * volume; this form lets the cataloguer fill in the basic descriptive
 * fields the crowdsourcing workflow captures (title, dates, extent, scope,
 * language, notes). The form is standard-aware:
 * `tenant.descriptiveStandard` flows from the route loader as the
 * `standard` prop, and required-field marks plus label resolution route
 * through `getStandardConfig(standard)` and `tStd(t, key, standard)`.
 *
 * Section IDs and field keys are the English column-name keys
 * (`identity`, `physical_description`, `content`, `conditions_access`,
 * `notes`, `entities_places`; field keys match column names on
 * `entries` — `title`, `translatedTitle`, `resourceType`, `extent`,
 * `scopeContent`, `language`, `descriptionNotes`, `internalNotes`).
 * The Spanish keys this file used through v0.3 (`identificacion`,
 * `titulo`, etc.) are gone; the locale and the entry route consumer
 * (`app/routes/_auth.description.$projectId.$entryId.tsx`) were
 * updated together.
 *
 * Domain note: the cataloguing form operates on `entries` (segmented
 * documentary units), NOT on `descriptions`. Most columns the
 * standard configs declare (`referenceCode`, `repositoryId`,
 * `creatorDisplay`, `accessConditions`, etc.) live on `descriptions`
 * and are populated post-promotion. The cataloguing form
 * intentionally renders a narrow crowdsourcing-friendly subset; it
 * does NOT iterate `config.sections` directly because doing so would
 * render mostly-empty admin-style sections (the entry shape can't
 * populate them). The form IS still config-aware: required-field
 * marks come from `config.requiredFieldsForLevel(level)`, and labels
 * resolve via `tStd` so per-standard label overrides apply.
 *
 * Namespace contract: the cataloguing namespace alias is `description`
 * (singular), not `descriptions_admin`.
 * `useTranslation("description")` is the call-site contract.
 *
 * Cataloguing form + impersonation: when an operator impersonates a
 * tenant via the login-as flow, the impersonated tenant's
 * `descriptive_standard` applies. `tenantContext` resolves to the
 * impersonated tenant; this form reads `descriptiveStandard` from the
 * loader transparently — impersonation requires no change here.
 *
 * Standard literals: NO `'isadg'` / `'dacs'` / `'rad'` literal appears
 * in this file (a grep test enforces this invariant). Resolution
 * flows through the typed `Standard` prop into `getStandardConfig`
 * and `tStd`.
 *
 * @version v0.4.2
 */

import { useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { DescriptionSection } from "./description-section";
import { getStandardConfig } from "../../lib/standards/registry";
import { tStd } from "../../lib/i18n/standard-aware";
import type {
  DescriptionLevel,
  Standard,
} from "../../lib/standards/types";
import type {
  DescriptionEntry,
  SectionCompletion,
} from "../../lib/description-types";

type DescriptionFormProps = {
  entry: DescriptionEntry;
  onFieldChange: (fieldName: string, value: string) => void;
  sectionCompletion: SectionCompletion;
  isReadOnly?: boolean;
  isPaused?: boolean;
  onSubmitForReview?: () => void;
  validationErrors?: Record<string, string>;
  /**
   * Active descriptive standard — sourced from
   * `tenant.descriptiveStandard` in the parent route loader. Drives
   * required-field marks (via `getStandardConfig`) and per-standard
   * label overrides (via `tStd`).
   */
  standard: Standard;
};

/**
 * Cataloguing-form section IDs (English column-name keys). These are
 * CATALOGUING-domain section IDs — they happen to overlap by name
 * with some admin section IDs (`identity`, `content`, `notes`) and
 * with some DACS section IDs (`physical_description`,
 * `conditions_access`) but they live in the `description` namespace
 * and are independent of the standard configs' section list.
 */
const SECTION_IDS = [
  "identity",
  "physical_description",
  "content",
  "notes",
  "entities_places",
] as const;

type SectionId = (typeof SECTION_IDS)[number];

function FieldLabel({
  label,
  optional,
  required,
}: {
  label: string;
  optional?: boolean;
  required?: boolean;
}) {
  return (
    <label className="mb-1 block font-sans text-sm font-medium text-indigo">
      {label}
      {required && <span className="ml-1 text-madder">*</span>}
      {optional && (
        <span className="ml-1.5 text-xs font-normal text-stone-400">
          Opcional
        </span>
      )}
    </label>
  );
}

function FieldError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p className="mt-1 font-sans text-xs text-indigo">{error}</p>
  );
}

export function DescriptionForm({
  entry,
  onFieldChange,
  sectionCompletion,
  isReadOnly = false,
  isPaused = false,
  onSubmitForReview,
  validationErrors = {},
  standard,
}: DescriptionFormProps) {
  const { t } = useTranslation("description");

  // Config-aware required-field marks. The cataloguing form's section
  // structure is hardcoded (domain difference from admin form — see
  // file header) but required marks per field route through the active
  // standard's config so a DACS or RAD tenant sees the correct
  // mandatoriness for the level the entry was assigned.
  const config = getStandardConfig(standard);
  const level = (entry.descriptionLevel ?? "item") as DescriptionLevel;
  const requiredCols = useMemo(
    () => new Set(config.requiredFieldsForLevel(level)),
    [config, level],
  );
  const isRequired = useCallback(
    (col: string) => requiredCols.has(col),
    [requiredCols],
  );

  // CR-04: validator-emitted errors arrive as stable i18n tokens
  // (`field_required`, etc.). Resolve to localised strings at the
  // component boundary so the leaf `<FieldError>` renders never
  // surface raw tokens in the user UI. Anything not a known token
  // is passed through (covers future Zod base-schema messages until
  // they migrate to the same convention).
  const resolvedErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [col, raw] of Object.entries(validationErrors)) {
      if (raw === "field_required") {
        out[col] = t("error_required");
      } else if (raw === "invalid_level") {
        out[col] = t("error_invalid_level");
      } else if (raw != null) {
        out[col] = raw;
      }
    }
    return out;
  }, [validationErrors, t]);

  const [expandedSections, setExpandedSections] = useState<Set<SectionId>>(
    () => new Set(["identity"]),
  );

  const toggleSection = useCallback((sectionId: SectionId) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  const handleChange = useCallback(
    (fieldName: string) =>
      (
        e: React.ChangeEvent<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >,
      ) => {
        if (!isReadOnly) {
          onFieldChange(fieldName, e.target.value);
        }
      },
    [onFieldChange, isReadOnly],
  );

  const inputClass =
    "w-full rounded border border-stone-200 bg-white px-3 py-2 font-serif text-base text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-100 disabled:cursor-not-allowed";

  const textareaClass =
    "w-full rounded border border-stone-200 bg-white px-3 py-2 font-sans text-15 leading-[1.6] text-stone-700 placeholder:text-stone-400 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-100 disabled:cursor-not-allowed";

  const selectClass =
    "w-full rounded border border-stone-200 bg-white px-3 py-2 font-sans text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo disabled:bg-stone-100 disabled:cursor-not-allowed";

  // Show submit button only when status is in_progress or sent_back
  const showSubmit =
    !isReadOnly &&
    (entry.descriptionStatus === "in_progress" ||
      entry.descriptionStatus === "sent_back");

  return (
    <div className="space-y-3">
      {/* Pause warning banner */}
      {isPaused && (
        <div className="rounded-lg border border-saffron bg-saffron-tint p-3 font-sans text-sm text-saffron-deep">
          {t("editor.descripcion_pausada")}
        </div>
      )}

      {/* 1. Identity */}
      <DescriptionSection
        title={tStd(t, "sections.identity", standard)}
        isExpanded={expandedSections.has("identity")}
        isComplete={sectionCompletion.identity}
        onToggle={() => toggleSection("identity")}
      >
        <div className="space-y-4" id="section-identity">
          {/* Title */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.title", standard)}
              required={isRequired("title")}
            />
            <input
              type="text"
              className={`${inputClass} font-serif font-semibold`}
              value={entry.title ?? ""}
              onChange={handleChange("title")}
              disabled={isReadOnly}
            />
            <FieldError error={resolvedErrors.title} />
          </div>

          {/* Translated title */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.translatedTitle", standard)}
              optional
            />
            <input
              type="text"
              className={inputClass}
              value={entry.translatedTitle ?? ""}
              onChange={handleChange("translatedTitle")}
              disabled={isReadOnly}
              placeholder={t("fields.translatedTitle_hint")}
            />
          </div>

          {/* Resource type */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.resourceType", standard)}
              required={isRequired("resourceType")}
            />
            <select
              className={selectClass}
              value={entry.resourceType ?? ""}
              onChange={handleChange("resourceType")}
              disabled={isReadOnly}
            >
              <option value="">--</option>
              <option value="texto">{t("resource_types.texto")}</option>
              <option value="imagen">{t("resource_types.imagen")}</option>
              <option value="cartografico">
                {t("resource_types.cartografico")}
              </option>
              <option value="mixto">{t("resource_types.mixto")}</option>
            </select>
            <FieldError error={resolvedErrors.resourceType} />
          </div>

          {/* Date */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.dateExpression", standard)}
              required={isRequired("dateExpression")}
            />
            <input
              type="text"
              className={inputClass}
              value={entry.dateExpression ?? ""}
              onChange={handleChange("dateExpression")}
              disabled={isReadOnly}
              placeholder={t("fields.dateExpression_placeholder")}
            />
            <FieldError error={resolvedErrors.dateExpression} />
          </div>

          {/* Date start / end */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel
                label={tStd(t, "fields.dateStart", standard)}
                optional
              />
              <input
                type="date"
                className={inputClass}
                value={entry.dateStart ?? ""}
                onChange={handleChange("dateStart")}
                disabled={isReadOnly}
              />
            </div>
            <div>
              <FieldLabel
                label={tStd(t, "fields.dateEnd", standard)}
                optional
              />
              <input
                type="date"
                className={inputClass}
                value={entry.dateEnd ?? ""}
                onChange={handleChange("dateEnd")}
                disabled={isReadOnly}
              />
            </div>
          </div>
        </div>
      </DescriptionSection>

      {/* 2. Physical description */}
      <DescriptionSection
        title={tStd(t, "sections.physical_description", standard)}
        isExpanded={expandedSections.has("physical_description")}
        isComplete={sectionCompletion.physical_description}
        onToggle={() => toggleSection("physical_description")}
      >
        <div className="space-y-4" id="section-physical_description">
          <div>
            <FieldLabel
              label={tStd(t, "fields.extent", standard)}
              required={isRequired("extent")}
            />
            <input
              type="text"
              className={inputClass}
              value={entry.extent ?? ""}
              onChange={handleChange("extent")}
              disabled={isReadOnly}
              placeholder={t("fields.extent_placeholder")}
            />
            <FieldError error={resolvedErrors.extent} />
          </div>
        </div>
      </DescriptionSection>

      {/* 3. Content */}
      <DescriptionSection
        title={tStd(t, "sections.content", standard)}
        isExpanded={expandedSections.has("content")}
        isComplete={sectionCompletion.content}
        onToggle={() => toggleSection("content")}
      >
        <div className="space-y-4" id="section-content">
          {/* Scope and content */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.scopeContent", standard)}
              required={isRequired("scopeContent")}
            />
            <textarea
              className={`${textareaClass} min-h-[100px]`}
              value={entry.scopeContent ?? ""}
              onChange={handleChange("scopeContent")}
              disabled={isReadOnly}
            />
            <FieldError error={resolvedErrors.scopeContent} />
          </div>

          {/* Language */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.language", standard)}
              required={isRequired("language")}
            />
            <input
              type="text"
              className={inputClass}
              value={entry.language ?? ""}
              onChange={handleChange("language")}
              disabled={isReadOnly}
              placeholder={t("fields.language_placeholder")}
            />
            <FieldError error={resolvedErrors.language} />
          </div>

          {/* Original reference (entries-table extension; not on standard
              config — kept as cataloguing-side hint via the existing
              `(entry as any).originalReference` access pattern). */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.originalReference", standard)}
              optional
            />
            <textarea
              className={`${textareaClass} min-h-[60px]`}
              value={(entry as { originalReference?: string }).originalReference ?? ""}
              onChange={handleChange("originalReference")}
              disabled={isReadOnly}
            />
          </div>
        </div>
      </DescriptionSection>

      {/* 4. Notes */}
      <DescriptionSection
        title={tStd(t, "sections.notes", standard)}
        isExpanded={expandedSections.has("notes")}
        isComplete={sectionCompletion.notes}
        onToggle={() => toggleSection("notes")}
      >
        <div className="space-y-4" id="section-notes">
          {/* General notes (entries.description_notes) */}
          <div>
            <FieldLabel label={tStd(t, "fields.notes", standard)} optional />
            <textarea
              className={`${textareaClass} min-h-[80px]`}
              value={entry.descriptionNotes ?? ""}
              onChange={handleChange("descriptionNotes")}
              disabled={isReadOnly}
            />
          </div>

          {/* Archivist notes */}
          <div>
            <FieldLabel
              label={tStd(t, "fields.internalNotes", standard)}
              optional
            />
            <textarea
              className={`${textareaClass} min-h-[80px]`}
              value={entry.internalNotes ?? ""}
              onChange={handleChange("internalNotes")}
              disabled={isReadOnly}
            />
          </div>
        </div>
      </DescriptionSection>

      {/* 5. Entities and places (locked) */}
      <DescriptionSection
        title={tStd(t, "sections.entities_places", standard)}
        isExpanded={false}
        isComplete={false}
        isDisabled
        onToggle={() => {}}
      >
        <p className="font-sans text-sm text-stone-500">
          {t("locked.entities_places")}
        </p>
      </DescriptionSection>

      {/* Submit for review button */}
      {showSubmit && (
        <div className="border-t border-stone-200 pt-4">
          <button
            type="button"
            onClick={onSubmitForReview}
            className="h-11 w-full rounded-md bg-indigo font-sans text-15 font-semibold text-parchment hover:bg-indigo-deep active:bg-indigo-deep"
          >
            {t("actions.enviar_para_revision")}
          </button>
        </div>
      )}
    </div>
  );
}

/* @version v0.4.2 */
