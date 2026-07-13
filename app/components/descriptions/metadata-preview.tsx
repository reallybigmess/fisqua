/**
 * Metadata Preview
 *
 * This card is the summary tile rendered alongside the description form,
 * showing the record's repository, parent, level, and key identifiers at
 * a glance.
 *
 * @version v0.4.2
 */

import { useState } from "react";
import { Link, type FetcherWithComponents } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowUp, ArrowDown } from "lucide-react";
import { MoveDialog } from "~/components/descriptions/move-dialog";
import { StatusBadge } from "~/components/descriptions/status-badges";
import type { TreeItem } from "./miller-columns";

// ---------------------------------------------------------------------------
// Level badge colours (same as miller-item)
// ---------------------------------------------------------------------------

const LEVEL_BADGE_STYLES: Record<string, string> = {
  fonds: "bg-indigo-tint text-indigo",
  subfonds: "bg-verdigris-tint text-verdigris",
  collection: "bg-verdigris-tint text-verdigris",
  series: "bg-indigo-tint text-indigo",
  subseries: "bg-saffron-tint text-saffron-deep",
  section: "bg-saffron-tint text-saffron-deep",
  volume: "bg-stone-100 text-stone-700",
  file: "bg-stone-100 text-stone-700",
  item: "bg-stone-100 text-stone-500",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MetadataPreviewProps {
  item: TreeItem | null;
  onNavigateAway?: () => void;
  fetcher?: FetcherWithComponents<unknown>;
  onItemDeleted?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MetadataPreview({
  item,
  onNavigateAway,
  fetcher,
  onItemDeleted,
}: MetadataPreviewProps) {
  const { t } = useTranslation("descriptions_admin");
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  if (!item) return null;
  // Repositories are pure navigation containers — no metadata to show.
  if (item.kind === "repository") return null;

  const badgeStyle =
    LEVEL_BADGE_STYLES[item.descriptionLevel] || "bg-stone-100 text-stone-500";
  const levelLabel = t(`level_${item.descriptionLevel}`, {
    defaultValue: item.descriptionLevel,
  });

  const scopeContent = item.scopeContent
    ? item.scopeContent.length > 150
      ? `${item.scopeContent.substring(0, 150)}...`
      : item.scopeContent
    : "\u2014";

  const hasChildren = item.childCount > 0;

  // -----------------------------------------------------------------------
  // Action handlers
  // -----------------------------------------------------------------------

  const handleReorder = (direction: "up" | "down") => {
    if (!fetcher) return;
    fetcher.submit(
      { _action: "reorder", descriptionId: item.id, direction },
      { method: "post" }
    );
  };

  const handleMove = (newParentId: string) => {
    if (!fetcher) return;
    fetcher.submit(
      { _action: "move", descriptionId: item.id, newParentId },
      { method: "post" }
    );
    setShowMoveDialog(false);
  };

  const handleDelete = () => {
    if (!fetcher) return;
    fetcher.submit(
      { _action: "delete", descriptionId: item.id },
      { method: "post" }
    );
    setShowDeleteConfirm(false);
    onItemDeleted?.();
  };

  return (
    <>
      <div className="border-t border-stone-200 bg-stone-50 px-4 py-3">
        <div className="grid grid-cols-[1fr_auto] gap-6">
          {/* Left: metadata fields */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <div>
              <span className="font-sans text-xs text-stone-500">
                {t("fields.referenceCode")}
              </span>
              <p className="font-sans text-sm text-stone-700">
                {item.referenceCode}
              </p>
            </div>
            <div>
              <span className="font-sans text-xs text-stone-500">
                {t("fields.descriptionLevel")}
              </span>
              <p className="mt-0.5">
                <span
                  className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${badgeStyle}`}
                >
                  {levelLabel}
                </span>
              </p>
            </div>
            <div>
              <span className="font-sans text-xs text-stone-500">
                {t("fields.dateExpression")}
              </span>
              <p className="font-sans text-sm text-stone-700">
                {item.dateExpression || "\u2014"}
              </p>
            </div>
            <div>
              <span className="font-sans text-xs text-stone-500">
                {t("fields.childCount")}
              </span>
              <p className="font-sans text-sm text-stone-700">
                {item.childCount}
              </p>
            </div>
            <div className="col-span-2">
              <span className="font-sans text-xs text-stone-500">
                {t("fields.scopeContent")}
              </span>
              <p className="font-sans text-sm text-stone-700">{scopeContent}</p>
            </div>
            <div>
              <span className="font-sans text-xs text-stone-500">
                {t("published_badge")}
              </span>
              <p className="mt-0.5">
                <StatusBadge
                  isPublished={item.isPublished}
                  lastExportedAt={null}
                  updatedAt={0}
                />
              </p>
            </div>
          </div>

          {/* Right: action buttons */}
          <div className="flex flex-col gap-2">
            <Link
              to={`/admin/descriptions/${item.id}`}
              onClick={onNavigateAway}
              className="inline-flex items-center justify-center rounded-md bg-indigo px-3 py-1.5 text-sm font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("edit")}
            </Link>
            <Link
              to={`/admin/descriptions/new?parentId=${item.id}`}
              onClick={onNavigateAway}
              className="inline-flex items-center justify-center rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("add_child")}
            </Link>
            <button
              type="button"
              onClick={() => setShowMoveDialog(true)}
              className="inline-flex items-center justify-center rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              {t("move_button")}
            </button>
            {/* Reorder up/down */}
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => handleReorder("up")}
                aria-label={t("aria_move_up")}
                className="inline-flex flex-1 items-center justify-center rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleReorder("down")}
                aria-label={t("aria_move_down")}
                className="inline-flex flex-1 items-center justify-center rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                <ArrowDown className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => !hasChildren && setShowDeleteConfirm(true)}
              disabled={hasChildren}
              title={
                hasChildren
                  ? t("error_delete_blocked", { count: item.childCount })
                  : undefined
              }
              className={
                hasChildren
                  ? "inline-flex cursor-not-allowed items-center justify-center rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-madder-deep opacity-50"
                  : "inline-flex items-center justify-center rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-semibold text-madder-deep hover:bg-madder-tint"
              }
            >
              {t("delete_description")}
            </button>
          </div>
        </div>
      </div>

      {/* Move dialog */}
      {showMoveDialog && (
        <MoveDialog
          description={{
            id: item.id,
            title: item.title,
            referenceCode: item.referenceCode,
            descriptionLevel: item.descriptionLevel,
            childCount: item.childCount,
          }}
          currentParentId={null}
          onClose={() => setShowMoveDialog(false)}
          onConfirm={handleMove}
        />
      )}

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
            <h2 className="text-lg font-semibold text-stone-700">
              {t("delete_description")}
            </h2>
            <p className="mt-2 font-serif text-15 text-stone-500 max-w-measure mx-auto">
              {t("error_delete_confirm", { title: item.title })}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
              >
                {t("delete_cancel")}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="rounded-md bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
              >
                {t("delete_description")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
