/**
 * English translations — common namespace
 *
 * This locale namespace carries the cross-cutting English strings
 * every other namespace builds on top of — the app brand name and the
 * shared button vocabulary (Save, Cancel, Create, Delete, Apply,
 * Clear). i18next loads it as the default namespace, so bare keys
 * like `t("button.save")` resolve here without an explicit prefix.
 *
 * @version v0.3.0
 */
export default {
  app_name: "Fisqua",
  button: {
    save: "Save",
    cancel: "Cancel",
    create: "Create",
    delete: "Delete",
    apply: "Apply",
    clear: "Clear",
  },
  label: {
    loading: "Loading...",
    search: "Search",
    actions: "Actions",
    name: "Name",
    email: "Email",
    role: "Role",
    status: "Status",
    none: "None",
    yes: "Yes",
    no: "No",
    back: "Back",
    close: "Close",
    confirm: "Confirm",
    edit: "Edit",
    details: "Details",
  },
  domain: {
    document_count_one: "{{count}} document",
    document_count_other: "{{count}} documents",
    image_count_one: "{{count}} image",
    image_count_other: "{{count}} images",
    volume_count_one: "{{count}} volume",
    volume_count_other: "{{count}} volumes",
    volume_count_full_one: "{{count}} volume",
    volume_count_full_other: "{{count}} volumes",
  },
  error: {
    generic_title: "Something went wrong",
    generic_detail: "An unexpected error occurred.",
    not_found: "The requested page could not be found.",
    try_again: "Try again",
  },
  pagination: {
    previous: "Previous",
    next: "Next",
    page_of: "Page {{current}} of {{total}}",
  },
} as const;
