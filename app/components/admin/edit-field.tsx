/**
 * Admin — Edit Field Primitives
 *
 * Text-input and textarea primitives for the authority-detail EditMode
 * forms. `EditField` was a byte-identical local copy in both
 * `entities.$id` and `places.$id`; it is the extraction target. The
 * `EditTextarea` sibling is single-use today (`entities.$id` only) and
 * is co-located here as the kindred form primitive so both edit-field
 * building blocks live in one place.
 *
 * Both render the same label/input/error structure: an indigo label
 * with an optional required marker, a stone-bordered control, and a
 * madder field-level error paragraph wired via `aria-describedby`.
 *
 * @version v0.4.1
 */

export function EditField({
  name,
  label,
  defaultValue,
  required,
  error,
}: {
  name: string;
  label: string;
  defaultValue: string;
  required?: boolean;
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

export function EditTextarea({
  name,
  label,
  defaultValue,
  error,
}: {
  name: string;
  label: string;
  defaultValue: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-indigo">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        rows={3}
        defaultValue={defaultValue}
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
