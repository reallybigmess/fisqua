/**
 * Admin — Autosave Draft Hook
 *
 * Debounced localStorage-style draft autosave shared by the three admin
 * detail editors (`entities.$id`, `places.$id`, `descriptions.$id`).
 * All three carried a byte-identical copy of this machinery: a
 * `useFetcher` that POSTs a `_action=autosave` snapshot 2s after the
 * last form change, a form ref, a debounce ref cleaned up on unmount /
 * mode change, and a derived saving/saved status.
 *
 * The snapshot contract: every non-underscore-prefixed form field is
 * captured; `_`-prefixed control fields (`_action`, `_updatedAt`,
 * `_force`) are excluded. That filter and the status derivation are
 * exported as pure helpers (`buildDraftSnapshot`, `deriveDraftStatus`)
 * so they can be pinned without rendering — see
 * `tests/components/use-autosave-draft.test.ts`.
 *
 * @version v0.4.1
 */

import { useCallback, useEffect, useRef } from "react";
import { useFetcher } from "react-router";

/**
 * Build the draft snapshot from a form's FormData: capture every field
 * whose name does not start with `_`. The `_`-prefixed fields
 * (`_action`, `_updatedAt`, `_force`) are transport/control fields and
 * are intentionally excluded from the persisted draft.
 */
export function buildDraftSnapshot(
  formData: FormData,
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("_")) {
      snapshot[key] = value as string;
    }
  }
  return snapshot;
}

/**
 * Derive the autosave status pill value from the fetcher state and its
 * returned data. `submitting` -> "saving"; a settled response carrying
 * an `autosaved` flag -> "saved"; otherwise no pill.
 */
export function deriveDraftStatus(
  state: "idle" | "loading" | "submitting",
  data: unknown,
): "saving" | "saved" | null {
  if (state === "submitting") return "saving";
  if (data && typeof data === "object" && "autosaved" in data) return "saved";
  return null;
}

/**
 * Wire debounced draft autosave for an admin detail form. Attach the
 * returned `formRef` to the `<Form>` and `handleFormChange` to its
 * `onChange`; render the `draftStatus` pill. Autosave only fires while
 * `isEditing` is true.
 */
export function useAutosaveDraft(isEditing: boolean) {
  const draftFetcher = useFetcher();
  const formRef = useRef<HTMLFormElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  const triggerAutosave = useCallback(() => {
    if (!formRef.current || !isEditing) return;
    const snapshot = buildDraftSnapshot(new FormData(formRef.current));
    draftFetcher.submit(
      { _action: "autosave", snapshot: JSON.stringify(snapshot) },
      { method: "post" },
    );
  }, [isEditing, draftFetcher]);

  const handleFormChange = useCallback(() => {
    if (!isEditing) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(triggerAutosave, 2000);
  }, [isEditing, triggerAutosave]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isEditing]);

  const draftStatus = deriveDraftStatus(draftFetcher.state, draftFetcher.data);

  return { formRef, handleFormChange, draftStatus };
}
