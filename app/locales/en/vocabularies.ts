/**
 * English translations — vocabularies namespace
 *
 * This locale namespace carries the English strings for the
 * controlled-vocabulary admin surface — the page heading, the
 * term-management affordances (add, save, approve, deprecate), and
 * the merge/split workflow labels that authority editors use to keep
 * the function and subject vocabularies tidy.
 *
 * @version v0.3.0
 */
export default {
  // Page
  page_title: "Vocabularies",
  add_function: "Add function",
  add_term: "Add term",
  save_term: "Save term",
  approve_term: "Approve term",
  merge_into: "Merge into...",
  split_term: "Split term",
  deprecate_term: "Deprecate term",
  rename_term: "Rename term",
  reject_term: "Reject term",
  edit_term: "Edit",
  delete_term: "Delete",

  // Empty states
  no_functions_found: "No functions found",
  no_functions_body:
    "No functions match your filters. Try adjusting the category or status filter.",
  no_proposed: "No proposed terms awaiting review.",
  no_linked_entities: "No entities use this function.",
  no_terms_defined: "No terms defined. Add one above.",

  // Validation and errors
  cannot_delete: "Cannot delete: used by {{count}} records",
  deprecate_confirm:
    "Deprecate '{{term}}'? {{count}} entities currently use this function. They will retain the function label but it will no longer appear in typeahead suggestions.",
  reject_confirm: "Reject '{{term}}'? Provide a reason for rejection.",
  error_save:
    "Could not save the term. Check your connection and try again.",
  error_merge:
    "Merge failed. The target term may have been deleted. Refresh and try again.",

  // Statuses
  status_approved: "Approved",
  status_proposed: "Proposed",
  status_deprecated: "Deprecated",

  // Categories
  cat_civil_office: "Civil office",
  cat_military_rank: "Military rank",
  cat_ecclesiastical_office: "Ecclesiastical office",
  cat_academic_degree: "Academic degree",
  cat_honorific: "Honorific",
  cat_occupation_trade: "Occupation / trade",
  cat_documentary_role: "Documentary role",
  cat_kinship: "Kinship",
  cat_status_condition: "Status / condition",
  cat_institutional_ref: "Institutional reference",

  // Vocabulary names
  vocab_entity_roles: "Entity roles",
  vocab_place_roles: "Place roles",
  vocab_entity_types: "Entity types",
  vocab_place_types: "Place types",
  vocab_primary_functions: "Primary functions",

  // Vocab card subtitles
  vocab_entity_roles_desc: "Roles linking entities to descriptions",
  vocab_place_roles_desc: "Roles linking places to descriptions",
  vocab_entity_types_desc: "Person, family, or corporate body",
  vocab_place_types_desc: "Country, city, parish, hacienda, and more",
  vocab_primary_functions_desc: "Historical functions and titles",

  // Counts and labels
  n_terms: "{{count}} terms",
  n_proposed: "{{count}} proposed",
  linked_entities: "Linked entities",
  review_queue: "Review queue",
  all_filter: "All",
  search_placeholder: "Search functions...",

  // Table columns
  col_function: "Function",
  col_category: "Category",
  col_usage: "Usage",
  col_status: "Status",
  col_actions: "Actions",

  // Detail
  proposed_by: "Proposed by",
  field_canonical: "Canonical label",
  field_category: "Category",
  field_status: "Status",
  field_notes: "Notes",

  // Enum management warnings
  enum_redeployment_warning:
    "Changes to these vocabularies require a code update and redeployment.",
  enum_pending_changes: "Pending changes (not yet deployed)",
} as const;
