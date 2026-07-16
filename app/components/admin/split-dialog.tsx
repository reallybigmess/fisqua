/**
 * Split Dialog
 *
 * This dialog deals with splitting one record into two for vocabulary
 * terms. Walks the operator through picking which linked descriptions
 * follow which side of the split, validates both halves are non-empty,
 * and emits the split payload.
 *
 * @version v0.4.1
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Form } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LinkReassignmentList,
  type DescriptionLink,
} from "./link-reassignment-list";

interface SplitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sourceId: string;
  sourceName: string;
  /**
   * Informational only — the component body does NOT branch on this
   * value. It records which authority surface the dialog is serving
   * (entities, places, or vocabulary terms) for the consumer's own
   * clarity; all label resolution flows through `i18nNamespace`.
   */
  entityType: "entity" | "place" | "vocabulary";
  links: DescriptionLink[];
  i18nNamespace: string;
  /**
   * When provided, the dialog renders a labelled, required text input
   * for the new record's canonical name and submits it as `newName`.
   * The confirm button is disabled while the field is empty. When
   * omitted (entities/places), no name field is rendered and behaviour
   * is unchanged — the split target's name is derived server-side.
   */
  splitNameField?: { label: string; placeholder: string };
  /**
   * The source record's `updatedAt`. When provided (entities/places), it
   * rides the split submission as a hidden `_updatedAt` so the server can
   * reject a split staged against a record modified since the form loaded
   * — the same optimistic-lock guard the update intent uses. Omitted for
   * vocabulary terms, whose action does not carry the guard.
   */
  recordUpdatedAt?: number | string;
}

export function SplitDialog({
  isOpen,
  onClose,
  sourceId,
  sourceName,
  entityType,
  links,
  i18nNamespace,
  splitNameField,
  recordUpdatedAt,
}: SplitDialogProps) {
  const { t } = useTranslation(i18nNamespace);
  const dialogRef = useRef<HTMLDivElement>(null);

  const [selectedLinkIds, setSelectedLinkIds] = useState<Set<string>>(
    () => new Set()
  );
  const [newName, setNewName] = useState("");

  // Reset when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setSelectedLinkIds(new Set()); // defaultChecked=false: no links selected by default
      setNewName("");
    }
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (isOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [isOpen]);

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  const handleToggleLink = useCallback((id: string) => {
    setSelectedLinkIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedLinkIds(new Set(links.map((l) => l.id)));
  }, [links]);

  const handleDeselectAll = useCallback(() => {
    setSelectedLinkIds(new Set());
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-labelledby="split-dialog-title"
        tabIndex={-1}
        className="max-w-2xl rounded-lg bg-white p-6 shadow-lg focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="split-dialog-title"
          className="font-serif text-lg font-semibold text-stone-700"
        >
          {t("splitTitle")}
        </h2>
        <p className="mt-1 text-sm text-stone-500">
          {t("splitSubtitle", { name: sourceName })}
        </p>

        {splitNameField && (
          <div className="mt-4">
            <label
              htmlFor="split-new-name"
              className="block text-sm font-medium text-indigo"
            >
              {splitNameField.label}
            </label>
            <input
              id="split-new-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={splitNameField.placeholder}
              required
              autoFocus
              className="mt-1 w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-indigo focus:outline-none focus:ring-1 focus:ring-indigo"
            />
          </div>
        )}

        {links.length > 0 && (
          <div className="mt-4">
            <LinkReassignmentList
              links={links}
              selectedIds={selectedLinkIds}
              onToggle={handleToggleLink}
              defaultChecked={false}
              loadMoreLabel={t("loadMore")}
              selectAllLabel={t("selectAll", { defaultValue: "Select all" })}
              deselectAllLabel={t("deselectAll", {
                defaultValue: "Deselect all",
              })}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            {t("splitCancel")}
          </button>
          <Form method="post">
            <input type="hidden" name="_action" value="split" />
            {recordUpdatedAt != null && (
              <input
                type="hidden"
                name="_updatedAt"
                value={String(recordUpdatedAt)}
              />
            )}
            <input
              type="hidden"
              name="linkIds"
              value={JSON.stringify(Array.from(selectedLinkIds))}
            />
            {splitNameField && (
              <input type="hidden" name="newName" value={newName} />
            )}
            <button
              type="submit"
              disabled={splitNameField ? !newName.trim() : undefined}
              className="rounded-md bg-indigo px-4 py-2 text-sm font-semibold text-parchment hover:bg-indigo-deep disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("splitConfirm")}
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}
