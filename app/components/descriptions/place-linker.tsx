/**
 * Place Linker
 *
 * This dialog deals with linking a place authority record to the current
 * description, with typeahead search, role picker, and inline create-new
 * flow.
 *
 * @version v0.4.3
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Pencil, X, Plus } from "lucide-react";
import { SearchPopover } from "./search-popover";
import { placeRoleOptions } from "~/lib/role-options";

export interface DescriptionPlaceLink {
  id: string;
  descriptionId: string;
  placeId: string;
  role: string;
  roleNote: string | null;
  createdAt: number;
  placeLabel: string;
  placeCode: string | null;
}

interface PlaceLinkerProps {
  descriptionId: string;
  links: DescriptionPlaceLink[];
  isEditing: boolean;
}

interface SelectedPlace {
  id: string;
  name: string;
  code: string;
}

export function PlaceLinker({
  descriptionId,
  links,
  isEditing,
}: PlaceLinkerProps) {
  const { t } = useTranslation("descriptions_admin");
  const fetcher = useFetcher();
  // Flat, localised role options — the picker can only offer the seven
  // PLACE_ROLES values (see `~/lib/role-options`).
  const roleOptions = placeRoleOptions(t);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(
    null
  );
  const [addRole, setAddRole] = useState<string>("created");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const existingPlaceIds = links.map((l) => l.placeId);

  function handleSelect(item: { id: string; name: string; code: string }) {
    setSelectedPlace(item);
    setShowSearch(false);
  }

  function handleConfirmAdd() {
    if (!selectedPlace) return;
    fetcher.submit(
      {
        _action: "link_place",
        descriptionId,
        placeId: selectedPlace.id,
        role: addRole,
      },
      { method: "post" }
    );
    resetAddForm();
  }

  function resetAddForm() {
    setSelectedPlace(null);
    setShowSearch(false);
    setAddRole("created");
  }

  function startEdit(link: DescriptionPlaceLink) {
    setEditingId(link.id);
    setEditRole(link.role);
  }

  function handleSaveEdit() {
    if (!editingId) return;
    fetcher.submit(
      {
        _action: "update_place_link",
        linkId: editingId,
        role: editRole,
      },
      { method: "post" }
    );
    setEditingId(null);
  }

  function handleRemove(linkId: string) {
    fetcher.submit(
      { _action: "remove_place_link", linkId },
      { method: "post" }
    );
    setConfirmRemoveId(null);
  }

  return (
    <div>
      {/* Linked place list */}
      {links.length > 0 && (
        <ul className="space-y-2">
          {links.map((link) => (
            <li
              key={link.id}
              className="flex items-center gap-2 rounded border border-stone-200 px-3 py-2"
            >
              {/* Content area */}
              {editingId === link.id ? (
                /* Inline edit mode */
                <div className="flex flex-1 items-center gap-2">
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    className="rounded border border-stone-200 px-2 py-1 text-sm"
                  >
                    {roleOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleSaveEdit}
                    className="rounded bg-indigo px-3 py-1 text-xs font-semibold text-parchment hover:bg-indigo-deep"
                  >
                    {t("save_changes")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="text-xs text-stone-500 hover:text-stone-700"
                  >
                    {t("link_cancel")}
                  </button>
                </div>
              ) : (
                /* Display mode */
                <div className="flex flex-1 items-center gap-2">
                  <span className="text-sm text-stone-700">
                    {link.placeLabel}
                  </span>
                  <span className="rounded bg-indigo-tint px-1.5 py-0.5 text-xs font-medium text-indigo-deep">
                    {t(`role_${link.role}`, link.role)}
                  </span>
                </div>
              )}

              {/* Action buttons (edit mode, not inline editing) */}
              {isEditing && editingId !== link.id && (
                <div className="flex gap-1">
                  <button
                    type="button"
                    aria-label={t("aria_edit_link")}
                    onClick={() => startEdit(link)}
                    className="text-stone-500 hover:text-stone-700"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  {confirmRemoveId === link.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRemove(link.id)}
                        className="text-xs font-semibold text-madder hover:underline"
                      >
                        {t("remove_link_button")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveId(null)}
                        className="text-xs text-stone-500 hover:text-stone-700"
                      >
                        {t("link_cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={t("aria_remove_link", {
                        name: link.placeLabel,
                      })}
                      onClick={() => setConfirmRemoveId(link.id)}
                      className="text-stone-500 hover:text-madder"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {links.length === 0 && !isEditing && (
        <p className="text-sm text-stone-500">{"\u2014"}</p>
      )}

      {/* Add place flow */}
      {isEditing && !selectedPlace && (
        <div className="relative mt-3">
          <button
            type="button"
            onClick={() => setShowSearch(!showSearch)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-deep hover:text-indigo"
          >
            <Plus className="h-4 w-4" />
            {t("add_place")}
          </button>
          {showSearch && (
            <SearchPopover
              type="place"
              onSelect={handleSelect}
              onClose={() => setShowSearch(false)}
              excludeIds={existingPlaceIds}
            />
          )}
        </div>
      )}

      {/* Selected place — role form */}
      {isEditing && selectedPlace && (
        <div className="mt-3 space-y-2 rounded border border-stone-200 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-stone-700">
              {selectedPlace.name}
            </span>
            <button
              type="button"
              onClick={() => setSelectedPlace(null)}
              className="text-stone-500 hover:text-stone-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("role_label")}
            </label>
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
            >
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleConfirmAdd}
              className="rounded bg-indigo px-3 py-1 text-xs font-semibold text-parchment hover:bg-indigo-deep"
            >
              {t("link_confirm")}
            </button>
            <button
              type="button"
              onClick={resetAddForm}
              className="text-xs text-stone-500 hover:text-stone-700"
            >
              {t("link_cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
