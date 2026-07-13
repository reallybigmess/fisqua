/**
 * Viewer Save Status
 *
 * This component is the inline pill that surfaces the save state of the
 * currently edited entry. Four visually distinct states drive the
 * cataloguer's mental model of "is my work landed":
 *
 *   - saved   → verdigris (the brand "you are safe" colour)
 *   - saving  → stone (neutral, "in flight")
 *   - unsaved → saffron (warning, "you have changes not yet flushed")
 *   - error   → madder (error, "the save attempt has failed")
 *
 * On `error`, the pill also surfaces a visible "Save failed — retry"
 * affordance. The `onRetry` callback is wired by the bounded-retry
 * helper inside `useAutosave`; the prop hook lives alongside the
 * four-state colour map.
 *
 * i18n-agnostic by design: callers pass the rendered label strings via
 * the `labels` prop. The two namespaces that consume this component
 * use different nested shapes (`description.editor.save_status_*` vs.
 * `viewer.save_status.*`), and resolving them inside the component
 * would force a namespace asymmetry awkward enough that the
 * labels-as-props contract was the cleaner choice. This also lets the
 * shared component be unit-tested without an i18next provider.
 *
 * The shared component consolidates the previously-inlined
 * `DescriptionSaveStatus` widget from the description editor route
 * into a single source of truth.
 *
 * Pure helpers (`statusColorClass`, `shouldShowRetryAffordance`) are
 * exported alongside the component so the four-distinct-classes
 * regression — the exact bug that B2 fixes — is unit-testable without
 * rendering React. See `tests/components/save-status.test.tsx`.
 *
 * @version v0.4.1
 */

export type SaveStatusValue = "saved" | "saving" | "unsaved" | "error";

/**
 * Map a save-status value to its Tailwind background-colour class.
 *
 * Uses a `switch` (not an object lookup) so TypeScript's exhaustiveness
 * checking catches any future `SaveStatusValue` member that's added to
 * the union without a corresponding arm here — the same flavour of
 * compile-time guard that the unit-test set-size assertion catches at
 * runtime.
 *
 * Tokens used: `bg-verdigris`, `bg-stone-400`, `bg-saffron`, `bg-madder`.
 * All four resolve in `app/app.css`'s `@theme` (verdigris, saffron,
 * madder) or via Tailwind v4's default palette (stone-400). No new
 * tokens are introduced for this hotfix.
 */
export function statusColorClass(status: SaveStatusValue): string {
  switch (status) {
    case "saved":
      return "bg-verdigris";
    case "saving":
      return "bg-stone-400";
    case "unsaved":
      return "bg-saffron";
    case "error":
      return "bg-madder";
  }
}

/**
 * Whether the SaveStatus pill should render the "Save failed — retry"
 * affordance for a given state. Only `error` surfaces it; the other
 * three states render the label-only pill.
 */
export function shouldShowRetryAffordance(status: SaveStatusValue): boolean {
  return status === "error";
}

type SaveStatusProps = {
  status: SaveStatusValue;
  /**
   * Caller-supplied translations for the four state labels. The
   * component is i18n-agnostic; each route resolves its own
   * namespace's nested shape (description: `t("editor.save_status_*")`;
   * viewer: ``t(`save_status.${status}`)``) and hands the resolved
   * strings down.
   */
  labels: Record<SaveStatusValue, string>;
  /**
   * Caller-supplied translation for the retry affordance label
   * (typically `save_failed_retry`). Required when `status` may take
   * the `error` value; optional otherwise.
   */
  retryLabel?: string;
  /**
   * Click handler for the retry affordance. Wired by the bounded-retry
   * helper once it settles to `error`. Optional so existing call sites
   * compile without behaviour changes.
   */
  onRetry?: () => void;
};

export function SaveStatus({
  status,
  labels,
  retryLabel,
  onRetry,
}: SaveStatusProps) {
  const color = statusColorClass(status);
  const label = labels[status];
  const showRetry = shouldShowRetryAffordance(status);

  return (
    <span className="flex items-center gap-1.5 text-xs text-stone-500">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      {label}
      {showRetry && retryLabel ? (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 font-sans text-xs font-medium text-madder underline underline-offset-2 hover:text-madder-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-madder"
        >
          {retryLabel}
        </button>
      ) : null}
    </span>
  );
}

