/**
 * English translations — repositories namespace
 *
 * This locale namespace carries the English strings for the
 * repositories admin surface — the list page, the create/edit form,
 * and the destructive actions. Repositories are the top-level
 * institutional anchors the description tree hangs off, so the labels
 * follow ISAAR(CPF)'s phrasing for archival institutions.
 *
 * @version v0.3.0
 */
export default {
  title: "Repositories",
  add: "Add repository",
  create_title: "New repository",
  create_submit: "Create repository",
  save: "Save changes",
  edit: "Edit repository",
  discard: "Discard changes",
  back: "Back to repositories",
  delete: "Delete repository",
  delete_modal_dismiss: "Go back",
  delete_modal_title: "Delete repository",
  delete_modal_body:
    "Are you sure you want to delete {{name}}? This action cannot be undone.",
  delete_modal_confirm_label: 'Type "{{code}}" to confirm',
  delete_blocked: "Cannot delete — {{count}} linked descriptions",
  cascade_warning: "This repository has {{count}} linked descriptions.",
  cascade_examples: "Examples:",
  empty_title: "No repositories",
  empty_body: "Add the first repository to start linking descriptions.",
  search_placeholder: "Search by name or code...",
  filter_enabled: "Enabled",
  filter_disabled: "Disabled",
  filter_all: "All",
  columns_label: "Columns",
  badge_enabled: "Enabled",
  badge_disabled: "Disabled",
  results_count: "Showing {{count}} of {{total}} repositories",
  error_duplicate_code: "A repository with that code already exists.",
  error_generic: "An error occurred. Try again.",
  error_required: "This field is required.",
  success_created: "Repository created.",
  success_updated: "Repository updated.",
  success_deleted: "Repository deleted.",
  section_identity: "Identity area",
  section_contact: "Contact area",
  section_admin: "Administrative",
  "field.code": "Code",
  "field.name": "Name",
  "field.shortName": "Short name",
  "field.countryCode": "Country code",
  "field.country": "Country",
  "field.city": "City",
  "field.address": "Address",
  "field.website": "Website",
  "field.notes": "Notes",
  "field.rightsText": "Rights text (METS)",
  "field.enabled": "Status",

  // Linked descriptions
  linked_descriptions: "Linked descriptions",
  no_linked_descriptions: "No linked descriptions",
  delete_blocked_inline:
    "Cannot delete: this repository has {{count}} linked descriptions",

  // Display metadata
  display_title_label: "Display title",
  display_title_helper:
    "Overrides name for frontend display. Leave blank to use name.",
  subtitle_label: "Subtitle",
  subtitle_helper: "Shown below the title on the frontend",
  hero_image_url_label: "Hero image URL",
  hero_image_url_helper:
    "URL to header image (R2 bucket or external URL)",

  // Draft/changelog
  commit_note_placeholder: "Note about changes (optional)",
  autosave_saving: "Saving...",
  autosave_saved: "Draft saved",
  conflict_banner:
    "{{name}} has unsaved changes since {{time}}.",
  overwrite_confirm:
    "This record was modified by {{name}} at {{time}}. Do you want to overwrite?",
  overwrite_button: "Overwrite",
  overwrite_cancel: "Cancel",
} as const;
