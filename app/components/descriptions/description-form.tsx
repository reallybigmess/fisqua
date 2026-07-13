/**
 * Description Form (admin)
 *
 * This form is the config-driven admin renderer for archival descriptions.
 * One renderer; sections + fields come from the active standard's config.
 * The parent route loader hands `standard` (typed `Standard`) down
 * via prop; this component reads `getStandardConfig(standard).sections`
 * and renders each section's fields by switching on `field.primitive`.
 * There is no `if (standard === 'isadg')` branching — the contract
 * is "the config drives everything that varies across standards"; the
 * literal triple `'isadg' / 'dacs' / 'rad'` does NOT appear in this
 * file (a grep test enforces this invariant).
 *
 * Namespace contract: the alias is `descriptions_admin` (see
 * `app/locales/en.ts:24`), NOT `descriptions`.
 * `useTranslation("descriptions_admin")` is the call-site contract
 * that `tStd` rides on top of.
 *
 * Field labels resolve via `tStd(t, "fields.<col>", standard)`;
 * section titles via `tStd(t, "sections.<id>", standard)`. Per-
 * standard label divergences (e.g. RAD's "Title proper", DACS's
 * "Biographical/Historical Note") live as sibling literal-key
 * overrides in the locale files (`app/locales/{en,es}/descriptions.ts`)
 * and are picked up automatically.
 *
 * @version v0.4.0
 */

import { useTranslation } from "react-i18next";
import { CollapsibleSection } from "~/components/admin/collapsible-section";
import { RESOURCE_TYPES } from "~/lib/validation/enums";
import { getStandardConfig } from "~/lib/standards/registry";
import { tStd } from "~/lib/i18n/standard-aware";
import type {
  DescriptionLevel,
  FieldConfig,
  Standard,
} from "~/lib/standards/types";
import { EntityLinker } from "./entity-linker";
import { PlaceLinker } from "./place-linker";
import type { DescriptionEntityLink } from "./entity-linker";
import type { DescriptionPlaceLink } from "./place-linker";

/**
 * The form is config-driven, so it tolerates any column name from any
 * standard config. We type the surface as a `Record<string, unknown>`
 * keyed by column name, plus the structural fields the helper logic
 * relies on (`id`, `descriptionLevel`, `repositoryId`, `childCount`).
 * Every column referenced by `app/lib/standards/{isadg,dacs,rad}.ts`
 * MUST exist on `descriptions` in `app/db/schema.ts` (FieldConfig
 * contract); the loader returns a row from that table directly.
 */
type DescriptionData = {
  id: string;
  descriptionLevel: string;
  repositoryId: string;
  childCount: number;
  // index signature lets the renderer dereference any column the
  // active standard's config names without per-column typing here.
  [column: string]: unknown;
};

interface Repository {
  id: string;
  name: string;
}

interface DescriptionFormProps {
  description: DescriptionData;
  isEditing: boolean;
  repositories: Repository[];
  allowedLevels: string[];
  errors?: Record<string, string[]>;
  entityLinks?: DescriptionEntityLink[];
  placeLinks?: DescriptionPlaceLink[];
  /**
   * Active descriptive standard, sourced from
   * `tenant.descriptiveStandard` in the parent route loader. Drives
   * which `StandardConfig` the renderer iterates.
   */
  standard: Standard;
  /**
   * Whether the tenant has the authorities capability. When off, the
   * Entity/Place linker fields are omitted and cataloguers use the
   * plain-text creator/place display fields instead.
   */
  authoritiesEnabled?: boolean;
}

export function DescriptionForm({
  description,
  isEditing,
  repositories,
  allowedLevels,
  errors,
  entityLinks = [],
  placeLinks = [],
  standard,
  authoritiesEnabled = true,
}: DescriptionFormProps) {
  const { t } = useTranslation("descriptions_admin");
  const config = getStandardConfig(standard);
  const level = description.descriptionLevel as DescriptionLevel;
  const requiredCols = config.requiredFieldsForLevel(level);

  return (
    <div className="rounded-lg border border-stone-200 bg-white p-6">
      {config.sections.map((section) => (
        <CollapsibleSection
          key={section.id}
          title={tStd(t, `sections.${section.id}`, standard)}
        >
          <div className="space-y-4">
            {section.fields.map((field) => {
              // Off-state authority pickers: when the tenant lacks the
              // authorities capability, the Entity/Place linker fields
              // are omitted (the plain-text display fields remain).
              if (
                !authoritiesEnabled &&
                (field.primitive === "entity-linker" ||
                  field.primitive === "place-linker")
              ) {
                return null;
              }
              // CR-04: validator-emitted errors arrive as stable
              // i18n tokens (`field_required`, `invalid_level`).
              // Resolve to localised strings here so leaf renderers
              // never display raw tokens to the user. Anything that
              // is not a known token is passed through (covers
              // future Zod base-schema messages until they migrate
              // to the same convention).
              const rawError = errors?.[field.column]?.[0];
              let resolvedError: string | undefined = rawError;
              if (rawError === "field_required") {
                resolvedError = t("error_required");
              } else if (rawError === "invalid_level") {
                resolvedError = t("error_invalid_level");
              }
              return (
                <FieldRenderer
                  key={field.column}
                  field={field}
                  description={description}
                  label={tStd(t, `fields.${field.column}`, standard)}
                  isEditing={isEditing}
                  required={requiredCols.includes(field.column)}
                  error={resolvedError}
                  allowedLevels={allowedLevels}
                  repositories={repositories}
                  entityLinks={entityLinks}
                  placeLinks={placeLinks}
                  t={t}
                />
              );
            })}
          </div>
        </CollapsibleSection>
      ))}

      {/* Save actions (edit mode only) */}
      {isEditing && (
        <div className="mt-6 space-y-3 border-t border-stone-200 pt-4">
          <input
            type="text"
            name="commitNote"
            placeholder={t("commit_note_placeholder")}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          />
          <div className="flex gap-3">
            <button
              type="submit"
              name="_action"
              value="update"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("save_changes")}
            </button>
            <button
              type="button"
              className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              data-action="discard"
            >
              {t("discard_changes")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FieldRenderer — switch on field.primitive
// ---------------------------------------------------------------------------

type TFn = ReturnType<typeof useTranslation>["t"];

interface FieldRendererProps {
  field: FieldConfig;
  description: DescriptionData;
  label: string;
  isEditing: boolean;
  required: boolean;
  error?: string;
  allowedLevels: string[];
  repositories: Repository[];
  entityLinks: DescriptionEntityLink[];
  placeLinks: DescriptionPlaceLink[];
  t: TFn;
}

function FieldRenderer({
  field,
  description,
  label,
  isEditing,
  required,
  error,
  allowedLevels,
  repositories,
  entityLinks,
  placeLinks,
  t,
}: FieldRendererProps) {
  const value = description[field.column];

  switch (field.primitive) {
    case "text":
    case "date": {
      // referenceCode is system-managed: read-only even when isEditing.
      const isReferenceCode = field.column === "referenceCode";
      return (
        <ReadOnlyOrInput
          name={field.column}
          label={label}
          value={typeof value === "string" ? value : null}
          isEditing={isEditing && !isReferenceCode}
          required={required}
          error={error}
        />
      );
    }

    case "textarea": {
      return (
        <ReadOnlyOrTextarea
          name={field.column}
          label={label}
          value={typeof value === "string" ? value : null}
          isEditing={isEditing}
          rows={field.hints?.rows ?? 3}
          className={field.column === "ocrText" ? "font-mono" : ""}
        />
      );
    }

    case "date-range": {
      // Render dateExpression as a single-line input plus a 2-col grid
      // for dateStart / dateEnd is handled by the standalone date
      // primitives that follow it in the config.
      return (
        <ReadOnlyOrInput
          name={field.column}
          label={label}
          value={typeof value === "string" ? value : null}
          isEditing={isEditing}
          required={required}
          error={error}
        />
      );
    }

    case "level-select": {
      if (!isEditing) {
        return (
          <ReadOnlyField
            label={label}
            value={
              typeof value === "string" ? t(`level_${value}`) : null
            }
          />
        );
      }
      const errorId = error ? `${field.column}-error` : undefined;
      return (
        <div>
          <label
            htmlFor={field.column}
            className="mb-1 block text-xs font-medium text-indigo"
          >
            {label}
            {required && <span className="text-madder"> *</span>}
          </label>
          <select
            id={field.column}
            name={field.column}
            defaultValue={typeof value === "string" ? value : ""}
            aria-required={required ? "true" : undefined}
            aria-describedby={errorId}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            {allowedLevels.map((lvl) => (
              <option key={lvl} value={lvl}>
                {t(`level_${lvl}`)}
              </option>
            ))}
          </select>
          {error && (
            <p id={errorId} className="mt-1 text-xs text-madder">
              {error}
            </p>
          )}
        </div>
      );
    }

    case "resource-type-select": {
      if (!isEditing) {
        return (
          <ReadOnlyField
            label={label}
            value={typeof value === "string" ? value : null}
          />
        );
      }
      return (
        <div>
          <label
            htmlFor={field.column}
            className="mb-1 block text-xs font-medium text-indigo"
          >
            {label}
            {required && <span className="text-madder"> *</span>}
          </label>
          <select
            id={field.column}
            name={field.column}
            defaultValue={typeof value === "string" ? value : ""}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            <option value="">{""}</option>
            {RESOURCE_TYPES.map((rt) => (
              <option key={rt} value={rt}>
                {rt}
              </option>
            ))}
          </select>
        </div>
      );
    }

    case "repository-select": {
      const repoValue = typeof value === "string" ? value : "";
      if (!isEditing) {
        return (
          <ReadOnlyField
            label={label}
            value={
              repositories.find((r) => r.id === repoValue)?.name ?? repoValue
            }
          />
        );
      }
      return (
        <div>
          <label
            htmlFor={field.column}
            className="mb-1 block text-xs font-medium text-indigo"
          >
            {label}
            {required && <span className="text-madder"> *</span>}
          </label>
          <select
            id={field.column}
            name={field.column}
            defaultValue={repoValue}
            aria-required={required ? "true" : undefined}
            className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
          >
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </div>
      );
    }

    case "checkbox": {
      const checked = Boolean(value);
      if (!isEditing) {
        return <ReadOnlyField label={label} value={checked ? "Yes" : "No"} />;
      }
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={field.column}
            name={field.column}
            defaultChecked={checked}
            className="h-4 w-4 rounded border-stone-200 text-indigo focus:ring-indigo"
          />
          <label
            htmlFor={field.column}
            className="text-sm font-medium text-indigo"
          >
            {label}
          </label>
        </div>
      );
    }

    case "iiif-url": {
      return (
        <ReadOnlyOrInput
          name={field.column}
          label={label}
          value={typeof value === "string" ? value : null}
          isEditing={isEditing}
          required={required}
          error={error}
        />
      );
    }

    case "entity-linker": {
      return (
        <EntityLinker
          descriptionId={description.id}
          links={entityLinks}
          isEditing={isEditing}
        />
      );
    }

    case "place-linker": {
      return (
        <PlaceLinker
          descriptionId={description.id}
          links={placeLinks}
          isEditing={isEditing}
        />
      );
    }

    default: {
      // Exhaustive check: TypeScript surfaces a missing primitive
      // case at compile time. The `Primitive` union is the closed set;
      // new primitives land here in lockstep.
      const _exhaustive: never = field.primitive;
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helper components
// ---------------------------------------------------------------------------

function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs text-stone-500">{label}</span>
      <p className="text-sm text-stone-700">{value || "—"}</p>
    </div>
  );
}

function ReadOnlyOrInput({
  name,
  label,
  value,
  isEditing,
  required,
  error,
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  isEditing: boolean;
  required?: boolean;
  error?: string;
}) {
  if (!isEditing) {
    return <ReadOnlyField label={label} value={value} />;
  }

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
        defaultValue={value ?? ""}
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

function ReadOnlyOrTextarea({
  name,
  label,
  value,
  isEditing,
  rows = 3,
  className = "",
}: {
  name: string;
  label: string;
  value: string | null | undefined;
  isEditing: boolean;
  rows?: number;
  className?: string;
}) {
  if (!isEditing) {
    return <ReadOnlyField label={label} value={value} />;
  }

  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        defaultValue={value ?? ""}
        className={`w-full rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-700 focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo ${className}`}
      />
    </div>
  );
}

/* @version v0.4.0 */
