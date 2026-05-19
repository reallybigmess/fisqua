/**
 * English translations — viewer namespace
 *
 * This locale namespace carries the English strings for the
 * segmentation viewer — the toolbar, the boundary-state save status,
 * the unsaved-changes prompts, and the custom unsaved-changes modal
 * that replaces the native `window.confirm` on in-app navigation.
 *
 * Save-status keys under `save_status:` — `error` (the four-state
 * addition for the new madder/red state), `save_failed_retry` (the
 * visible retry affordance label), and `save_now` (wired to the
 * Cmd/Ctrl+S handler and the visible Save now button).
 *
 * Unsaved-navigation key under `save_status:` —
 * `unsaved_confirm_leave` is the legacy `window.confirm(...)` prompt
 * fired by `useBlocker` in the viewer route before proceeding with
 * an outgoing in-app navigation while the boundary state is dirty,
 * saving, or settled to error. Mirrors the description editor
 * wording verbatim so cataloguers see the same prompt in both
 * editors.
 *
 * Custom unsaved-changes modal — four keys under `save_status:`:
 * `unsaved_dialog_title`, `unsaved_dialog_body`,
 * `unsaved_dialog_stay`, `unsaved_dialog_leave` — carry the strings
 * for the in-app `<UnsavedChangesDialog>` that replaces the native
 * `window.confirm`. Strings mirror the description namespace
 * verbatim so cataloguers see the same dialog in both editors. The
 * legacy `unsaved_confirm_leave` key stays in place.
 *
 * @version v0.4.1
 */
export default {
  toolbar: {
    undo: "Undo",
    undo_shortcut: "Undo (Ctrl+Z)",
    redo: "Redo",
    redo_shortcut: "Redo (Ctrl+Shift+Z)",
    add_boundary: "Add boundary",
    delete_boundary: "Delete boundary",
    zoom_in: "Zoom in",
    zoom_out: "Zoom out",
    fit_to_width: "Fit to width",
    go_to_image: "Go to image",
    back_to_volumes: "Back to volumes",
    annotation: "Annotation",
    annotationPoint: "Point",
    annotationBox: "Box",
    annotationMove: "Move",
  },
  save_status: {
    saved: "Saved",
    saving: "Saving...",
    unsaved: "Unsaved",
    error: "Save failed",
    save_failed_retry: "Save failed — retry",
    save_now: "Save now",
    unsaved_confirm_leave: "You have unsaved changes. Leave anyway?",
    unsaved_dialog_title: "Unsaved changes",
    unsaved_dialog_body:
      "You have unsaved changes. If you leave this page now, any work that has not been saved will be lost.",
    unsaved_dialog_stay: "Stay on page",
    unsaved_dialog_leave: "Leave anyway",
  },
  move_tool: {
    not_author: "You can only move your own annotations.",
    error_server: "Could not move the annotation. Please try again.",
  },
  outline: {
    title: "Outline",
    hint: "Click between images to add boundaries",
    page_boundary: "Page boundary",
    within_page_boundary: "Within-page boundary",
    document: "Document",
    blank: "Blank",
    continuation: "Continuation",
    front_matter: "Front matter",
    back_matter: "Back matter",
    no_title: "Untitled",
    no_type: "(unset)",
    type_label: "Type",
    is_document_label: "Is it a document?",
    is_document_yes: "Yes",
    is_document_no: "No",
    subtype_label: "Subtype",
    subtype_unset: "(select)",
    subtype_other: "Other",
    subtype_other_placeholder: "Type a custom subtype",
    non_doc_label: "Kind",
    title_label: "Title",
    ref_label: "Ref.",
    level_label: "Level",
    delete_boundary: "Delete boundary",
    confirm_delete: "Delete?",
    confirm_delete_tooltip: "Confirm deletion",
    indent_tooltip: "Nest under previous item",
    outdent_tooltip: "Move to parent level",
    type: {
      item: "Document",
      blank: "Blank",
      front_matter: "Front matter",
      back_matter: "End matter",
      test_images: "Test/calibration images",
    },
    comments_label: "Comments",
    has_comments: "Has comments",
    reviewer_comment_label: "Reviewer comment:",
    accepting: "Accepting...",
    // Outline comment-card labels and the
    // entry-delete warning copy.
    comment_kind_annotation: "Annotation",
    comment_kind_comment: "Comment",
    comment_doc_prefix: "Doc {{n}}",
    comment_img_prefix: "img {{n}}",
    comment_reply: "Reply",
    comment_mark_seen: "Mark as seen",
    comment_thread_header: "Conversation thread",
    add_comment: "Add comment",
    delete_with_attached_count:
      "{{count, plural, one {# attached comment linked to this entry will be deleted.} other {# attached comments linked to this entry will be deleted.}}}",
    delete_with_anchored_remaining:
      "{{count, plural, one {# comment linked to the images will remain.} other {# comments linked to the images will remain.}}}",
    readonly: {
      segmented: "Submitted for review",
      approved: "This volume has been approved",
      not_assigned: "Read-only -- you are not assigned to this volume",
    },
  },
  // Mandatory-comment prompt dialog.
  comment_prompt: {
    title: "Add a comment",
    placeholder: "Write your comment...",
    submit: "Save",
    cancel: "Cancel",
    region_label: "Region on p. {{page}}",
    error_empty: "Comment cannot be empty.",
    error_server: "Could not save. Please try again.",
  },
} as const;

/* @version v0.4.1 */
