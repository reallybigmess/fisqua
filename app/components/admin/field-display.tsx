/**
 * Admin — Field Display
 *
 * Read-mode label/value pair shared by the authority-detail ViewMode
 * blocks (`entities.$id`, `places.$id`). A single em-dash placeholder
 * stands in whenever the value counts as "no value"; the presence test
 * is the exported `isDisplayableFieldValue` predicate so a legitimate
 * falsy-but-real `0` still renders.
 *
 * Extraction note: `entities.$id` already used this predicate; the
 * sibling `places.$id` copy inlined the equivalent
 * `value != null && value !== ""` check. Both are the same behaviour;
 * this module is the single source and `places` now shares the
 * predicate rather than duplicating the inline check.
 *
 * @version v0.4.1
 */

/**
 * Pure predicate: does this field value count as present?
 *
 * A legitimate `0` (or any other falsy-but-real value) must still
 * render -- only `null`, `undefined`, and the empty string count as
 * "no value". Exported so tests pin the falsy-0 case without rendering.
 */
export function isDisplayableFieldValue(
  value: string | number | null | undefined,
): boolean {
  return value != null && value !== "";
}

export function FieldDisplay({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-sm text-stone-700">
        {isDisplayableFieldValue(value) ? String(value) : "—"}
      </p>
    </div>
  );
}
