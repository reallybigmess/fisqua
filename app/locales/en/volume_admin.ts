/**
 * English translations — volume_admin namespace
 *
 * This locale namespace carries the English strings for the volume
 * detail page under `/admin/volumes/$id` — the breadcrumb, the
 * "open in viewer" affordance, the section headings (progress,
 * assignments, workflow, metadata, danger zone) and the empty-state
 * copy for the entries table.
 *
 * @version v0.3.0
 */
export default {
  breadcrumb_volumes: "Volumes",
  open_in_viewer: "Open in viewer",
  pages: "{{count}} pages",
  section_progress: "Progress",
  section_assignments: "Assignments",
  section_workflow: "Workflow",
  section_metadata: "Metadata",
  section_danger_zone: "Danger zone",
  entries_empty: "No entries yet. Entries are created during segmentation.",
  col_description_status: "Description status",
  col_count: "Count",
  col_total: "Total",
  cataloguer_label: "Cataloguer (segmentation)",
  reviewer_label: "Reviewer",
  unassigned: "Unassigned",
  change_status_to: "Change status to",
  select_new_status: "Select new status...",
  apply: "Apply",
  no_transitions: "No status transitions available for your role.",
  sent_back_prefix: "Sent back:",
  sent_back_reason: "Reason for sending back",
  name_label: "Name",
  reference_code_label: "Reference code",
  save_metadata: "Save metadata",
  metadata_updated: "Volume metadata updated",
  cataloguer_assigned: "Cataloguer assigned",
  cataloguer_unassigned: "Cataloguer unassigned",
  reviewer_assigned: "Reviewer assigned",
  reviewer_unassigned: "Reviewer unassigned",
  status_changed: "Status changed to {{status}}",
  error_name_required: "Name and reference code are required",
  error_invalid_request: "Invalid request",
  error_unknown_action: "Unknown action",
  error_transition_failed: "Transition failed",
  delete_eligible: "This volume is unstarted and unassigned. It can be deleted.",
  delete_ineligible:
    "This volume cannot be deleted. Only unstarted volumes with no assignee can be removed. Change the status to \"unstarted\" and unassign it first.",
  delete_confirm: "Delete {{name}}? This cannot be undone.",
  delete_button: "Delete volume",
  force_delete_heading: "Force delete (superadmin)",
  force_delete_warning:
    "This will permanently delete the volume and all related entries, comments, flags, and activity log rows. Any cataloguing work on this volume will be lost. This cannot be undone.",
  force_delete_type_name: "Type \"{{name}}\" to confirm",
  force_delete_confirm:
    "Really force-delete {{name}}? All cataloguing work will be destroyed.",
  force_delete_name_mismatch:
    "Typed name does not match. Please type \"{{name}}\" exactly.",
  force_delete_button: "Force delete volume",
} as const;
