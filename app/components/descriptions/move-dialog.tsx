/**
 * Move Dialog
 *
 * This dialog deals with moving a description from one parent to another
 * within the tree, with a destination picker and cascade preview.
 *
 * @version v0.4.2
 */

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MoveDialogDescription {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
  childCount: number;
}

interface MiniTreeItem {
  id: string;
  title: string;
  referenceCode: string;
  descriptionLevel: string;
  childCount: number;
}

interface MiniColumn {
  parentId: string;
  title: string;
  items: MiniTreeItem[];
}

interface MoveDialogProps {
  description: MoveDialogDescription;
  currentParentId: string | null;
  onClose: () => void;
  onConfirm: (newParentId: string) => void;
}

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
// MoveDialog
// ---------------------------------------------------------------------------

export function MoveDialog({
  description,
  currentParentId,
  onClose,
  onConfirm,
}: MoveDialogProps) {
  const { t } = useTranslation("descriptions_admin");

  const [columns, setColumns] = useState<MiniColumn[]>([]);
  const [selectionPath, setSelectionPath] = useState<string[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<MiniTreeItem | null>(
    null
  );
  const [loading, setLoading] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Fetch children helper
  // -----------------------------------------------------------------------

  const fetchChildren = useCallback(
    async (parentId: string): Promise<MiniTreeItem[]> => {
      const res = await fetch(
        `/admin/descriptions/api/children/${parentId}`
      );
      if (!res.ok) return [];
      const items: MiniTreeItem[] = await res.json();
      // Filter out the description being moved (cannot move to self or its subtree)
      return items.filter((item) => item.id !== description.id);
    },
    [description.id]
  );

  // -----------------------------------------------------------------------
  // Load root on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    fetchChildren("root").then((items) => {
      setColumns([
        {
          parentId: "root",
          title: t("root_column_title"),
          items,
        },
      ]);
    });
  }, [fetchChildren, t]);

  // -----------------------------------------------------------------------
  // Item click handler
  // -----------------------------------------------------------------------

  const handleItemClick = useCallback(
    async (depth: number, item: MiniTreeItem) => {
      // Update selection
      const nextPath = selectionPath.slice(0, depth);
      nextPath[depth] = item.id;
      setSelectionPath(nextPath);
      setSelectedTarget(item);

      // Trim columns to clicked depth
      setColumns((prev) => prev.slice(0, depth + 1));

      // Load children if any
      if (item.childCount > 0) {
        setLoading(item.id);
        const children = await fetchChildren(item.id);
        setColumns((prev) => [
          ...prev.slice(0, depth + 1),
          { parentId: item.id, title: item.title, items: children },
        ]);
        setLoading(null);
      }
    },
    [selectionPath, fetchChildren]
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  const isCurrentParent = selectedTarget?.id === currentParentId;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-lg">
        {/* Header */}
        <h2 className="font-serif text-2xl font-semibold text-stone-700">
          {t("move_title")}
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          {t("move_subtitle", { title: description.title })}
        </p>

        {/* Warning if description has children */}
        {description.childCount > 0 && (
          <p className="mt-2 text-sm text-saffron-deep">
            {t("error_move_children", { count: description.childCount })}
          </p>
        )}

        {/* Mini tree browser */}
        <div
          className="mt-4 flex overflow-x-auto overflow-y-hidden rounded border border-stone-200"
          style={{ maxHeight: 384 }}
        >
          {columns.map((col, depth) => (
            <div
              key={`${col.parentId}-${depth}`}
              className="w-[220px] flex-none overflow-y-auto border-r border-stone-200 last:border-r-0"
              style={{ maxHeight: 384 }}
            >
              <div className="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-1.5">
                <span className="text-xs font-semibold text-stone-500">
                  {col.title}
                </span>
              </div>
              <ul>
                {col.items.map((item) => {
                  const isSelected = selectionPath[depth] === item.id;
                  const isCurrent = item.id === currentParentId;
                  const badgeStyle =
                    LEVEL_BADGE_STYLES[item.descriptionLevel] ||
                    "bg-stone-100 text-stone-500";

                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => handleItemClick(depth, item)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                          isSelected
                            ? "bg-indigo-deep text-parchment"
                            : isCurrent
                              ? "bg-indigo-tint text-stone-700"
                              : "text-stone-700 hover:bg-stone-100"
                        }`}
                      >
                        <span
                          className={`inline-block rounded-full px-1.5 py-0.5 text-10 font-medium ${
                            isSelected
                              ? "bg-white/20 text-white"
                              : badgeStyle
                          }`}
                        >
                          {item.descriptionLevel.slice(0, 3).toUpperCase()}
                        </span>
                        <span className="flex-1 truncate">{item.title}</span>
                        {item.childCount > 0 && (
                          <ChevronRight
                            className={`h-3 w-3 flex-none ${
                              isSelected ? "text-white/70" : "text-stone-400"
                            }`}
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
                {col.items.length === 0 && (
                  <li className="px-3 py-4 text-center text-xs text-stone-400">
                    {t("no_results")}
                  </li>
                )}
              </ul>
            </div>
          ))}

          {/* Loading indicator */}
          {loading && (
            <div className="flex w-[220px] flex-none items-center justify-center border-r border-stone-200">
              <Loader2 className="h-5 w-5 animate-spin text-stone-500" />
            </div>
          )}
        </div>

        {/* Selected target display */}
        {selectedTarget && (
          <div className="mt-3 rounded bg-stone-50 px-3 py-2 text-sm text-stone-700">
            <span className="text-stone-500">
              {isCurrentParent ? `(${t("fields.parentId")})` : ""}{" "}
            </span>
            {selectedTarget.title}{" "}
            <span className="text-xs text-stone-500">
              ({selectedTarget.referenceCode})
            </span>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("move_cancel")}
          </button>
          <button
            type="button"
            disabled={!selectedTarget || isCurrentParent}
            onClick={() => {
              if (selectedTarget && !isCurrentParent) {
                onConfirm(selectedTarget.id);
              }
            }}
            className={`rounded-md px-4 py-2 text-sm font-semibold text-white ${
              selectedTarget && !isCurrentParent
                ? "bg-indigo hover:bg-indigo-deep"
                : "cursor-not-allowed bg-indigo-deep opacity-50"
            }`}
          >
            {t("move_confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
