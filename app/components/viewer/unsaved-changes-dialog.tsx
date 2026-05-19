/**
 * Unsaved Changes Dialog
 *
 * This dialog is the custom in-app modal that fires when `useBlocker`
 * (React Router 7) intercepts a dirty navigation in either editor route.
 * Replaces an earlier native `window.confirm()` flow. The native confirm
 * has no i18n leverage on its buttons (they stay "OK / Cancel" in the
 * user's OS language even when the message is translated), no Tailwind /
 * brand integration, and it blocks browser automation — three reasons a
 * custom dialog is worth carrying.
 *
 * The sendBeacon flush semantics — best-effort fire-and-forget,
 * 60 KiB strict-less-than size guard, `blocker.proceed()` after — are
 * preserved verbatim in both editor routes. Only the UI of the
 * confirmation changes.
 *
 * Pattern mirror: the modal shape follows the hand-rolled dialog
 * convention already established in
 * `app/components/qc-flags/flag-qc-dialog.tsx`,
 * `app/components/qc-flags/resolve-qc-flag-dialog.tsx`, and the
 * `app/components/admin/split-dialog.tsx` family — fixed inset-0
 * backdrop, centred rounded-xl white card, X close button using
 * lucide's `X` icon. No new shared primitive is introduced; that
 * refactor is intentionally deferred.
 *
 * Safety contract:
 *
 *   - Stay-on-page is the safe default. Pressing Escape, clicking the
 *     backdrop, clicking the X close button, and clicking the explicit
 *     Stay button all route through `onStay`, which the caller wires
 *     to `blocker.reset()`. An accidental Enter keystroke while the
 *     dialog has focus also calls `onStay` because the Stay button
 *     carries `autoFocus` — Enter activates the focused button, which
 *     is Stay.
 *
 *   - The Leave button is the destructive path and is NOT the default
 *     focus. The caller wires it to a best-effort `sendBeacon` flush
 *     followed by `blocker.proceed()`. The button is styled
 *     `bg-madder` for visual parity with the editor's error state pill
 *     (the "you are leaving with unsaved work" warning rhymes with
 *     "your save attempt failed" in the cataloguer's mental model).
 *
 *   - Backdrop-click vs. child-click. The backdrop's `onClick`
 *     dispatches to `onStay` only when `event.target ===
 *     event.currentTarget` — i.e. the click originated on the
 *     backdrop itself, not on a child element inside the card. This
 *     matches the established pattern in `split-dialog.tsx` (which
 *     uses an `e.stopPropagation()` guard on the card) but is more
 *     robust to nested children whose own onClick handlers might or
 *     might not stop propagation.
 *
 * i18n contract:
 *
 *   The component is i18n-agnostic. Callers pass the four rendered
 *   strings (`titleLabel`, `bodyLabel`, `stayLabel`, `leaveLabel`) via
 *   props, mirroring the `SaveStatus` labels-as-props contract. The
 *   description editor resolves them against the
 *   `description.editor.unsaved_dialog_*` keys; the segmentation
 *   viewer resolves the same shape under
 *   `viewer.save_status.unsaved_dialog_*`. Resolving them inside the
 *   component would force a namespace asymmetry the codebase has
 *   already rejected once.
 *
 * Accessibility:
 *
 *   - The card carries `role="dialog"` and `aria-modal="true"` so
 *     assistive tech treats it as a modal.
 *   - The card's `aria-labelledby` points at the `<h2>` carrying the
 *     dialog title — screen readers announce it on focus.
 *   - The Escape keydown listener is registered at the `window` level
 *     while `open` is true, so the dialog dismisses with Escape
 *     regardless of which child element has focus.
 *
 * @version v0.4.1
 */
import { useEffect } from "react";
import { X } from "lucide-react";

export type UnsavedChangesDialogProps = {
  /**
   * Whether the dialog is open. When `false`, the component returns
   * `null` — no orphan overlay element, no Escape listener.
   */
  open: boolean;
  /** Dialog heading text. Resolved by the caller against its i18n namespace. */
  titleLabel: string;
  /** Body paragraph text. Resolved by the caller against its i18n namespace. */
  bodyLabel: string;
  /**
   * Stay button label. Also used as the `aria-label` on the X close
   * button so the entire "stay on page" affordance carries one
   * accessible name.
   */
  stayLabel: string;
  /** Leave button label. */
  leaveLabel: string;
  /**
   * Called when the user chooses to stay on the page — via the Stay
   * button, the X close button, the backdrop click, or the Escape
   * key. Caller wires this to `blocker.reset()`.
   */
  onStay: () => void;
  /**
   * Called when the user chooses to leave. Caller wires this to the
   * sendBeacon flush + `blocker.proceed()` sequence.
   */
  onLeave: () => void;
};

const TITLE_ID = "unsaved-changes-dialog-title";

/**
 * Pure presentational arm of the dialog — no hooks, no side effects.
 * Returns either `null` (when `open=false`) or the JSX tree. The
 * window-level Escape listener lives in the wrapping
 * `UnsavedChangesDialog` component below, which composes the
 * `useEffect` registration around this pure view.
 *
 * Exported so the component tests can invoke it directly without
 * running into "Invalid hook call" errors under the Workers vitest
 * pool, which does not install a React renderer dispatcher. The
 * tests target this view; the wrapping component is a thin
 * useEffect-only adapter.
 */
export function UnsavedChangesDialogView({
  open,
  titleLabel,
  bodyLabel,
  stayLabel,
  leaveLabel,
  onStay,
  onLeave,
}: UnsavedChangesDialogProps) {
  if (!open) return null;

  // Backdrop click handler — fires onStay only when the click target
  // is the backdrop itself, not a child element. Using
  // `target === currentTarget` instead of `stopPropagation` on the
  // card matches the recommended React idiom and tolerates deeply
  // nested children whose onClick handlers may not stop propagation.
  const handleBackdropClick = (e: {
    target: unknown;
    currentTarget: unknown;
  }) => {
    if (e.target === e.currentTarget) {
      onStay();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal={true}
        aria-labelledby={TITLE_ID}
        className="w-full max-w-md rounded-xl bg-white shadow-lg"
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-6 pb-4">
          <div className="flex-1">
            <h2
              id={TITLE_ID}
              className="font-display text-xl font-semibold text-stone-800"
            >
              {titleLabel}
            </h2>
          </div>
          <button
            type="button"
            onClick={onStay}
            aria-label={stayLabel}
            className="text-stone-400 hover:text-stone-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 pb-4">
          <p className="text-sm text-stone-600">{bodyLabel}</p>
        </div>

        {/* Footer */}
        <div className="flex gap-3 p-6 pt-2">
          <button
            type="button"
            autoFocus={true}
            onClick={onStay}
            className="flex-1 rounded-md bg-verdigris px-4 py-2 text-sm font-medium text-parchment hover:bg-verdigris-deep"
          >
            {stayLabel}
          </button>
          <button
            type="button"
            onClick={onLeave}
            className="flex-1 rounded-md bg-madder px-4 py-2 text-sm font-medium text-parchment hover:bg-madder-deep"
          >
            {leaveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UnsavedChangesDialog(props: UnsavedChangesDialogProps) {
  const { open, onStay } = props;
  // Escape closes the dialog via onStay. Listener is registered at the
  // window level while `open` is true so it works regardless of which
  // child has keyboard focus. Cleanup removes the listener on close
  // so we never leak a handler across mount cycles.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onStay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onStay]);

  return <UnsavedChangesDialogView {...props} />;
}

/* @version v0.4.1 */
