/**
 * Admin — Authority Detail Header
 *
 * The breadcrumb and title/action-row cluster shared by the authority
 * detail editors (`entities.$id`, `places.$id`). Both carried a
 * structurally identical breadcrumb (root link, chevron, current
 * record) and an identical title row (serif h1 plus the
 * merge/split/edit/delete action buttons, hidden while editing or when
 * the record is merged).
 *
 * `descriptions.$id` deliberately does NOT use these: its breadcrumb
 * renders a collapsing ancestor chain and its action row has a
 * different button set (add-child / edit / delete, no merge/split and
 * no merged state). That route keeps its own header markup.
 *
 * Both components are i18n-agnostic: callers resolve their namespace's
 * strings (`AdminBreadcrumb`) or pass a `t` for the button labels
 * (`AuthorityDetailHeader`).
 *
 * @version v0.4.1
 */

import { Link } from "react-router";
import { ChevronRight, Pencil, Trash2, Merge, Split } from "lucide-react";

export function AdminBreadcrumb({
  rootTo,
  rootLabel,
  current,
}: {
  rootTo: string;
  rootLabel: string;
  current: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm">
      <ol className="flex items-center gap-1">
        <li>
          <Link to={rootTo} className="text-stone-500 hover:text-stone-700">
            {rootLabel}
          </Link>
        </li>
        <li>
          <ChevronRight className="h-4 w-4 text-stone-400" />
        </li>
        <li className="text-stone-700">{current}</li>
      </ol>
    </nav>
  );
}

export function AuthorityDetailHeader({
  title,
  isEditing,
  isMerged,
  hasDescriptions,
  descLinkCount,
  mergeTo,
  splitTo,
  onEdit,
  onDelete,
  t,
}: {
  title: string;
  isEditing: boolean;
  isMerged: boolean;
  hasDescriptions: boolean;
  descLinkCount: number;
  mergeTo: string;
  splitTo: string;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="font-serif text-2xl font-semibold text-stone-700">
        {title}
      </h1>

      {!isEditing && !isMerged && (
        <div className="flex gap-2">
          <Link
            to={mergeTo}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Merge className="h-4 w-4" />
            {t("mergeButton")}
          </Link>
          <Link
            to={splitTo}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Split className="h-4 w-4" />
            {t("splitButton")}
          </Link>
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-2 rounded-md border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50"
          >
            <Pencil className="h-4 w-4" />
            {t("editButton")}
          </button>
          <button
            type="button"
            onClick={() => !hasDescriptions && onDelete()}
            disabled={hasDescriptions}
            aria-disabled={hasDescriptions ? "true" : undefined}
            title={
              hasDescriptions
                ? t("deleteBlocked", { count: descLinkCount })
                : undefined
            }
            className={
              hasDescriptions
                ? "inline-flex cursor-not-allowed items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment opacity-50"
                : "inline-flex items-center gap-2 rounded-lg bg-madder px-4 py-2 text-sm font-semibold text-parchment hover:bg-madder-deep"
            }
          >
            <Trash2 className="h-4 w-4" />
            {t("deleteButton")}
          </button>
        </div>
      )}
    </div>
  );
}
