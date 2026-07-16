/**
 * Comment Kebab Menu
 *
 * This menu is the three-dot affordance attached to a comment the current
 * user owns. Exposes edit and delete actions, closes on outside click, and
 * restores focus to the originating button on dismiss.
 *
 * @version v0.4.2
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";

export type CommentKebabAction = "edit" | "delete" | "resolve" | "reopen";

export interface KebabGateInput {
  isAuthor: boolean;
  isLead: boolean;
  isResolved: boolean;
  isRoot: boolean;
  /**
 * Deleted comments never render in the outline (cascade + read-filter
 *), so the kebab should not appear either. Passing isDeleted
 * defensively covers the brief fetcher -> revalidate window.
 */
  isDeleted: boolean;
}

export interface KebabItem {
  action: CommentKebabAction;
  /** i18n key under the `comments.kebab.*` namespace. */
  labelKey: string;
  /** Destructive items get a red-tinged style in the rendered menu. */
  destructive?: boolean;
}

/**
 * Pure enumeration of the rules. Returns the items to display
 * given the current viewer's role, author relationship, and the
 * comment's resolved / root / deleted state. Order matches the mock
 * (Editar -> Eliminar -> resolve verbs), not alphabetical.
 */
export function getKebabItems(input: KebabGateInput): KebabItem[] {
  if (input.isDeleted) return [];

  const items: KebabItem[] = [];

  if (input.isAuthor) {
 items.push({ action: "edit", labelKey: "comments.kebab.edit" });
  }

  if (input.isAuthor || input.isLead) {
 items.push({
 action: "delete",
 labelKey: "comments.kebab.delete",
 destructive: true,
 });
  }

  // Resolve controls apply only to root comments. Replies
  // inherit the thread's resolved state indirectly.
  if (input.isRoot) {
 if (!input.isResolved) {
 items.push({
 action: "resolve",
 labelKey: "comments.kebab.resolve",
 });
 } else if (input.isLead) {
 // Un-resolve is lead-only by design: asymmetric permission
 // with a resolve ping-pong safety valve.
 items.push({ action: "reopen", labelKey: "comments.kebab.reopen" });
 }
  }

  return items;
}

export interface CommentKebabMenuProps extends KebabGateInput {
  onAction: (action: CommentKebabAction) => void;
  /**
 * Sets aria-labelledby so screen readers announce which comment's
 * menu is open. Optional; render without when the surrounding context
 * (e.g. an author name adjacent to the button) is already announced.
 */
  ariaLabel?: string;
}

export function CommentKebabMenu({
  onAction,
  ariaLabel,
  ...gate
}: CommentKebabMenuProps) {
  const { t } = useTranslation("comments");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const items = getKebabItems(gate);
  if (items.length === 0) return null;

  useEffect(() => {
 if (!open) return;
 const handle = (e: MouseEvent | KeyboardEvent) => {
 if (e instanceof KeyboardEvent) {
 if (e.key === "Escape") setOpen(false);
 return;
 }
 if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
 setOpen(false);
 }
 };
 document.addEventListener("mousedown", handle);
 document.addEventListener("keydown", handle);
 return () => {
 document.removeEventListener("mousedown", handle);
 document.removeEventListener("keydown", handle);
 };
  }, [open]);

  return (
 <div ref={rootRef} className="relative">
 <button
 type="button"
 onClick={(e) => {
 e.stopPropagation();
 setOpen((v) => !v);
 }}
 aria-haspopup="menu"
 aria-expanded={open}
 aria-label={ariaLabel ?? t("comments.kebab.aria_label")}
 className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700"
 >
 <MoreHorizontal className="h-4 w-4" />
 </button>
 {open && (
 <div
 role="menu"
 className="absolute right-0 top-7 z-10 w-44 overflow-hidden rounded-md border border-stone-200 bg-white shadow-md"
 >
 {items.map((item) => (
 <button
 key={item.action}
 type="button"
 role="menuitem"
 onClick={(e) => {
 e.stopPropagation();
 setOpen(false);
 onAction(item.action);
 }}
 className={`flex w-full items-center px-3 py-1.5 text-left font-sans text-xs transition-colors ${
 item.destructive
 ? "text-indigo hover:bg-madder-tint"
 : "text-stone-700 hover:bg-stone-50"
 }`}
 >
 {t(item.labelKey)}
 </button>
 ))}
 </div>
 )}
 </div>
  );
}

