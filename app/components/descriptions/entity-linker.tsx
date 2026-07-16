/**
 * Entity Linker
 *
 * This dialog deals with linking an entity authority record to the current
 * description, with typeahead search, role picker, and inline create-new
 * flow.
 *
 * @version v0.4.3
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  ArrowDown,
  Pencil,
  X,
  Plus,
} from "lucide-react";
import { SearchPopover } from "./search-popover";
import { entityRoleOptionGroups } from "~/lib/role-options";

export interface DescriptionEntityLink {
  id: string;
  descriptionId: string;
  entityId: string;
  role: string;
  roleNote: string | null;
  sequence: number;
  honorific: string | null;
  function: string | null;
  nameAsRecorded: string | null;
  createdAt: number;
  entityDisplayName: string;
  entityCode: string | null;
}

interface EntityLinkerProps {
  descriptionId: string;
  links: DescriptionEntityLink[];
  isEditing: boolean;
}

interface SelectedEntity {
  id: string;
  name: string;
  code: string;
}

export function EntityLinker({
  descriptionId,
  links,
  isEditing,
}: EntityLinkerProps) {
  const { t } = useTranslation("descriptions_admin");
  const fetcher = useFetcher();
  // Grouped, localised role options — the picker can only offer
  // vocabulary values (see `~/lib/role-options`).
  const roleGroups = entityRoleOptionGroups(t);
  const [showSearch, setShowSearch] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(
    null
  );
  const [addRole, setAddRole] = useState<string>("creator");
  const [addHonorific, setAddHonorific] = useState("");
  const [addFunction, setAddFunction] = useState("");
  const [addNameAsRecorded, setAddNameAsRecorded] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editHonorific, setEditHonorific] = useState("");
  const [editFunction, setEditFunction] = useState("");
  const [editNameAsRecorded, setEditNameAsRecorded] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const existingEntityIds = links.map((l) => l.entityId);

  function handleSelect(item: { id: string; name: string; code: string }) {
    setSelectedEntity(item);
    setShowSearch(false);
  }

  function handleConfirmAdd() {
    if (!selectedEntity) return;
    const maxSeq = links.length > 0 ? Math.max(...links.map((l) => l.sequence)) : -1;
    fetcher.submit(
      {
        _action: "link_entity",
        descriptionId,
        entityId: selectedEntity.id,
        role: addRole,
        sequence: String(maxSeq + 1),
        honorific: addHonorific,
        function: addFunction,
        nameAsRecorded: addNameAsRecorded,
      },
      { method: "post" }
    );
    resetAddForm();
  }

  function resetAddForm() {
    setSelectedEntity(null);
    setShowSearch(false);
    setAddRole("creator");
    setAddHonorific("");
    setAddFunction("");
    setAddNameAsRecorded("");
  }

  function startEdit(link: DescriptionEntityLink) {
    setEditingId(link.id);
    setEditRole(link.role);
    setEditHonorific(link.honorific ?? "");
    setEditFunction(link.function ?? "");
    setEditNameAsRecorded(link.nameAsRecorded ?? "");
  }

  function handleSaveEdit() {
    if (!editingId) return;
    fetcher.submit(
      {
        _action: "update_entity_link",
        linkId: editingId,
        role: editRole,
        honorific: editHonorific,
        function: editFunction,
        nameAsRecorded: editNameAsRecorded,
      },
      { method: "post" }
    );
    setEditingId(null);
  }

  function handleRemove(linkId: string) {
    fetcher.submit(
      { _action: "remove_entity_link", linkId },
      { method: "post" }
    );
    setConfirmRemoveId(null);
  }

  function handleReorder(linkId: string, direction: "up" | "down") {
    fetcher.submit(
      { _action: "reorder_entity_link", linkId, direction },
      { method: "post" }
    );
  }

  // Styling preview string
  function stylingPreview(link: DescriptionEntityLink) {
    const parts = [link.honorific, link.function, link.nameAsRecorded].filter(
      Boolean
    );
    return parts.length > 0 ? parts.join(" ") : null;
  }

  return (
    <div>
      {/* Linked entity list */}
      {links.length > 0 && (
        <ul className="space-y-2">
          {links.map((link, idx) => (
            <li
              key={link.id}
              className="flex items-start gap-2 rounded border border-stone-200 px-3 py-2"
            >
              {/* Reorder arrows (edit mode only) */}
              {isEditing && (
                <div className="flex flex-col gap-0.5 pt-0.5">
                  <button
                    type="button"
                    disabled={idx === 0}
                    aria-label={t("aria_move_up")}
                    onClick={() => handleReorder(link.id, "up")}
                    className={
                      idx === 0
                        ? "cursor-not-allowed text-stone-300"
                        : "text-stone-500 hover:text-stone-700"
                    }
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === links.length - 1}
                    aria-label={t("aria_move_down")}
                    onClick={() => handleReorder(link.id, "down")}
                    className={
                      idx === links.length - 1
                        ? "cursor-not-allowed text-stone-300"
                        : "text-stone-500 hover:text-stone-700"
                    }
                  >
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </div>
              )}

              {/* Content area */}
              {editingId === link.id ? (
                /* Inline edit mode */
                <div className="flex-1 space-y-2">
                  <select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value)}
                    className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
                  >
                    {roleGroups.map((g) => (
                      <optgroup key={g.key} label={g.label}>
                        {g.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={editHonorific}
                    onChange={(e) => setEditHonorific(e.target.value)}
                    placeholder={t("honorific_label")}
                    className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
                  />
                  <input
                    type="text"
                    value={editFunction}
                    onChange={(e) => setEditFunction(e.target.value)}
                    placeholder={t("function_label")}
                    className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
                  />
                  <input
                    type="text"
                    value={editNameAsRecorded}
                    onChange={(e) => setEditNameAsRecorded(e.target.value)}
                    placeholder={t("name_as_recorded_label")}
                    className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
                  />
                  <div className="flex gap-2">
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
                </div>
              ) : (
                /* Display mode */
                <div className="flex flex-1 items-center gap-2">
                  <span className="text-sm text-stone-700">
                    {link.entityDisplayName}
                  </span>
                  <span className="rounded bg-indigo-tint px-1.5 py-0.5 text-xs font-medium text-indigo-deep">
                    {t(`role_${link.role}`, link.role)}
                  </span>
                  {stylingPreview(link) && (
                    <span className="text-xs italic text-stone-500">
                      {stylingPreview(link)}
                    </span>
                  )}
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
                        name: link.entityDisplayName,
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

      {/* Add entity flow */}
      {isEditing && !selectedEntity && (
        <div className="relative mt-3">
          <button
            type="button"
            onClick={() => setShowSearch(!showSearch)}
            className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-deep hover:text-indigo"
          >
            <Plus className="h-4 w-4" />
            {t("add_entity")}
          </button>
          {showSearch && (
            <SearchPopover
              type="entity"
              onSelect={handleSelect}
              onClose={() => setShowSearch(false)}
              excludeIds={existingEntityIds}
            />
          )}
        </div>
      )}

      {/* Selected entity — role + styling form */}
      {isEditing && selectedEntity && (
        <div className="mt-3 space-y-2 rounded border border-stone-200 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-stone-700">
              {selectedEntity.name}
            </span>
            <button
              type="button"
              onClick={() => setSelectedEntity(null)}
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
              {roleGroups.map((g) => (
                <optgroup key={g.key} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("honorific_label")}
            </label>
            <input
              type="text"
              value={addHonorific}
              onChange={(e) => setAddHonorific(e.target.value)}
              className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("function_label")}
            </label>
            <input
              type="text"
              value={addFunction}
              onChange={(e) => setAddFunction(e.target.value)}
              className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-indigo">
              {t("name_as_recorded_label")}
            </label>
            <input
              type="text"
              value={addNameAsRecorded}
              onChange={(e) => setAddNameAsRecorded(e.target.value)}
              className="w-full rounded border border-stone-200 px-2 py-1 text-sm"
            />
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
