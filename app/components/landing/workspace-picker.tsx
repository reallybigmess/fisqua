/**
 * WorkspacePicker
 *
 * This form is the landing hero, sized as the page's primary action — a
 * tall (56px) shell containing a single text input and the static
 * `.fisqua.org` mono suffix on the right, plus a sibling madder submit
 * button with an arrow glyph. A helper line below the shell carries
 * either the plain "Type your workspace name." prompt or the empty-input
 * error string in madder-deep with a small circle-bang glyph.
 *
 * Three error states, all surfaced inline below the shell with the
 * madder error glyph + madder-deep text:
 *   - `empty`     — input was whitespace-only.
 *   - `shape`     — failed `SlugSchema` (charset / length / reserved).
 *   - `notFound`  — shape OK but no tenant row matches; the slug is
 *                   echoed back via i18next `{{slug}}` interpolation
 *                   so the user sees what they typed and can fix it.
 *
 * The action in `_index.tsx` is the sole validator. The C-03
 * "no D1 lookup" invariant was retired 2026-05-02 (see action's
 * docstring for the threat-model reframe).
 *
 * Note on `action="/?index"`: React Router disambiguates submissions
 * to an index route from its parent layout via a naked `?index`
 * query parameter. POSTs to bare `/` resolve to the root layout
 * (which has no `action` export) and 405. The query string is
 * stripped from the URL before the action runs, so the action's
 * URL parsing is unaffected.
 *
 * @version v0.4.0
 */
import { useTranslation } from "react-i18next";

function ArrowGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ErrorGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7 4v3.5M7 9.5v0.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type PickerError =
  | { code: "empty" }
  | { code: "shape" }
  | { code: "notFound"; slug: string };

function errorMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  error: PickerError,
): string {
  switch (error.code) {
    case "empty":
      return t("picker.error.empty");
    case "shape":
      return t("picker.error.shape");
    case "notFound":
      // i18next escapes interpolated values by default, and the slug
      // has already been `.trim().toLowerCase()`'d and shape-validated
      // (lowercase ASCII alphanumeric + hyphen, 1–63 chars), so echoing
      // it here is XSS-safe.
      return t("picker.error.notFound", { slug: error.slug });
  }
}

export function WorkspacePicker({ error }: { error?: PickerError }) {
  const { t } = useTranslation("landing");
  const isError = error !== undefined;

  const shellClass = isError
    ? "border-madder shadow-[0_0_0_3px_rgba(181,83,61,0.15)]"
    : "border-stone-200 focus-within:border-indigo focus-within:shadow-[0_0_0_3px_rgba(31,46,77,0.12)]";

  return (
    <form
      method="post"
      action="/?index"
      noValidate
      className="flex w-full flex-col gap-2"
    >
      <label
        htmlFor="workspace-slug"
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "13px",
          fontWeight: 600,
          color: "var(--fg-1)",
          letterSpacing: "0.01em",
        }}
      >
        {t("picker.label")}
      </label>

      <div className="flex items-stretch gap-3">
        <div
          className={`flex h-14 flex-1 items-center overflow-hidden rounded-md border bg-white transition-[border-color,box-shadow] duration-100 ${shellClass}`}
        >
          <input
            id="workspace-slug"
            name="slug"
            type="text"
            required
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="workspace-suffix workspace-error"
            aria-invalid={isError ? "true" : "false"}
            autoFocus={isError || undefined}
            placeholder={t("picker.placeholder")}
            className="h-full min-w-0 flex-1 border-0 bg-transparent pl-[18px] pr-1 text-indigo placeholder:text-stone-400 focus:outline-none"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "17px",
              fontWeight: 500,
              letterSpacing: "-0.005em",
            }}
          />
          <span
            id="workspace-suffix"
            aria-hidden="false"
            className="select-none whitespace-nowrap pr-[18px]"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "15px",
              color: "var(--fg-3)",
            }}
          >
            {t("picker.suffix")}
          </span>
        </div>

        <button
          type="submit"
          className="inline-flex h-14 items-center justify-center gap-2.5 whitespace-nowrap rounded-md bg-madder px-6 text-white transition-colors duration-100 hover:bg-madder-deep focus:outline-none focus-visible:ring-2 focus-visible:ring-madder focus-visible:ring-offset-2"
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            fontSize: "15px",
            letterSpacing: "0.005em",
          }}
        >
          <span>{t("picker.submit")}</span>
          <ArrowGlyph />
        </button>
      </div>

      <div className="flex min-h-[20px] items-start">
        {error ? (
          <p
            id="workspace-error"
            role="alert"
            className="m-0 inline-flex items-start gap-1.5 text-madder-deep"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "13px",
              lineHeight: 1.4,
            }}
          >
            <span className="mt-[2px] shrink-0">
              <ErrorGlyph />
            </span>
            <span>{errorMessage(t, error)}</span>
          </p>
        ) : (
          <p
            className="m-0 text-stone-500"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "13px",
            }}
          >
            {t("picker.helper")}
          </p>
        )}
      </div>
    </form>
  );
}

// @version v0.4.0
