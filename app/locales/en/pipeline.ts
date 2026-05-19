/**
 * English translations — pipeline namespace
 *
 * This locale namespace carries the English strings for the
 * cross-project pipeline view — the global heading, the assign-
 * describer affordance, the team search box, and the per-row time
 * indicators ("today", "{{count}}d") that the pipeline table renders
 * for each unit in flight.
 *
 * @version v0.3.0
 */
export default {
  title: "Pipeline",
  all_projects: "All projects",
  assign_describer: "Assign describer",
  assign_confirm: "Assign",
  assign_cancel: "Cancel",
  search_team: "Search team members...",
  time_days: "{{count}}d",
  time_today: "today",
  go_to_promote: "Go to promote",
  error_load:
    "Unable to load the pipeline. Please refresh the page or try again later.",
  error_assign:
    "Could not assign describer. The entry may have been reassigned. Refresh and try again.",
  col_unstarted: "Unstarted",
  col_segmenting: "Segmenting",
  col_seg_review: "Seg. review",
  col_ready_to_describe: "Ready to describe",
  col_describing: "Describing",
  col_desc_review: "Desc. review",
  col_ready_to_promote: "Ready to promote",
  sent_back: "Sent back",
  stage_segmentation: "Segmentation",
  stage_description: "Description",
  empty_segmentation: "No volumes in the segmentation pipeline yet.",
  empty_description: "No entries in the description pipeline yet.",
} as const;
