/**
 * Admin — Optimistic-Lock Conflict Dialog
 *
 * Modal shown when an update action returns `error: "conflict"` because
 * the record's `updatedAt` moved under the editor (another user saved
 * first). Offers cancel, or a force-overwrite `<Form>` that re-submits
 * `_action=update` with `_force=true` and the editor's original
 * `_updatedAt`.
 *
 * Shared by all three admin detail editors (`entities.$id`,
 * `places.$id`, `descriptions.$id`). Divergence parameterised via
 * `modifiedByName`: the entities/places copies pass an empty name (they
 * do not resolve the conflicting user), while descriptions passes the
 * resolved `modifiedBy` name. The caller keeps its own visibility guard
 * (`showConflictDialog && actionData?.error === "conflict"`) and passes
 * the conflict fields down.
 *
 * @version v0.4.1
 */

import { Form } from "react-router";

export function ConflictDialog({
  modifiedByName,
  modifiedAt,
  recordUpdatedAt,
  onCancel,
  t,
}: {
  modifiedByName: string;
  modifiedAt: number | null;
  recordUpdatedAt: number | string;
  onCancel: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-stone-700">
          {t("overwrite_confirm", {
            name: modifiedByName,
            time: modifiedAt != null ? new Date(modifiedAt).toLocaleString() : "",
          })}
        </h2>
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("overwrite_cancel")}
          </button>
          <Form method="post">
            <input type="hidden" name="_action" value="update" />
            <input type="hidden" name="_force" value="true" />
            <input
              type="hidden"
              name="_updatedAt"
              value={String(recordUpdatedAt)}
            />
            <button
              type="submit"
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("overwrite_button")}
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}
