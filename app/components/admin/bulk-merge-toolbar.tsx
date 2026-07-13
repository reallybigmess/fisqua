/**
 * Admin — Bulk-merge toolbar (authority lists)
 *
 * Sits directly above the entities/places table and appears only when
 * at least one row is selected (design handoff surface 5). It drives the
 * two-row merge entry point: Merge is enabled at exactly two selected
 * records and opens the merge workbench pre-loaded with the pair; at one
 * or three-plus it is disabled with an inline hint.
 *
 * The caller owns the selection `Set`; this component is presentational
 * plus the merge navigation. `basePath` (e.g. `/admin/entities`) forms
 * the workbench URL `${basePath}/${a}/merge?survivor=${b}`.
 *
 * @version v0.4.2
 */

import { useNavigate } from "react-router";
import { GitMerge, Info } from "lucide-react";

export function BulkMergeToolbar({
  selectedIds,
  onClear,
  basePath,
  t,
}: {
  selectedIds: string[];
  onClear: () => void;
  basePath: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const navigate = useNavigate();
  const count = selectedIds.length;
  if (count === 0) return null;

  const canMerge = count === 2;

  return (
    <div className="mb-3 flex items-center justify-between rounded-lg border border-indigo-tint bg-indigo-wash px-4 py-2">
      <span className="text-13 nums font-semibold text-indigo">
        {t("bulkSelected", { count })}
      </span>
      <div className="flex items-center gap-3">
        {!canMerge && (
          <span className="flex items-center gap-1 text-13 text-indigo-soft">
            <Info className="h-4 w-4" strokeWidth={1.5} />
            {t("bulkHintPickTwo")}
          </span>
        )}
        <button
          type="button"
          onClick={onClear}
          className="text-13 font-semibold text-indigo hover:underline"
        >
          {t("bulkClear")}
        </button>
        <button
          type="button"
          disabled={!canMerge}
          onClick={() =>
            navigate(`${basePath}/${selectedIds[0]}/merge?survivor=${selectedIds[1]}`)
          }
          className={`inline-flex items-center gap-2 rounded-md bg-indigo px-4 py-2 text-13 font-semibold text-parchment ${
            canMerge ? "hover:bg-indigo-deep" : "cursor-not-allowed opacity-30"
          }`}
        >
          <GitMerge className="h-4 w-4" strokeWidth={1.5} />
          {t("bulkMerge")}
        </button>
      </div>
    </div>
  );
}
