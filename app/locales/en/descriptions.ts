/**
 * English translations — descriptions namespace (admin)
 *
 * This locale namespace deals with the admin-side labels for the
 * standard-aware description form.
 * Single namespace with per-standard overrides as sibling literal-string
 * keys; column-name keys; sections are i18n-keyed too. The flat
 * `field_X` / `section_X` keys from v0.3 normalise to nested
 * `fields.<columnName>` / `sections.<id>` keys, with per-standard
 * overrides as sibling literal-string keys at the same nesting level
 * (e.g. `sections["context.dacs"]` lives next to `sections.context`).
 *
 * keySeparator setting (verified 2026-05-03 against
 * `app/middleware/i18next.ts`): the project does NOT set
 * `keySeparator: false`, so i18next uses its default dot separator.
 * In that mode i18next's resolver checks for an exact literal-key
 * match before drilling, so storing the override as a literal key
 * `"context.dacs"` resolves correctly via `t("sections.context.dacs")`
 * without breaking `t("sections.context")`. This is the shape `tStd`
 * (`app/lib/i18n/standard-aware.ts`) consumes — `tStd(t,
 * "sections.context", "dacs")` resolves the override; `tStd(t,
 * "sections.context", "isadg")` falls back to the bare key.
 *
 * Section ID rename: `section_access` (v0.3) → `sections.conditions`
 * — matches the `accessConditions` column area concept and aligns
 * with `app/lib/standards/isadg.ts`'s ISAD 3.4 section id.
 *
 * The legacy related-materials flat key is removed: the corresponding
 * column was dropped in migration 0036 (0% populated in the production
 * audit); the locale entry is removed in lockstep.
 *
 * @version v0.4.3
 */
export default {
  // Page
  page_title: "Descriptions",
  new_description: "New description",
  create_description: "Create description",
  save_changes: "Save changes",
  edit: "Edit",
  discard_changes: "Discard changes",
  back_to_descriptions: "Back to descriptions",
  delete_description: "Delete description",
  delete_cancel: "Go back",
  move_button: "Move...",
  move_title: "Move description",
  move_subtitle: "Select the new parent for '{{title}}'.",
  move_confirm: "Confirm move",
  move_cancel: "Cancel",
  add_child: "Add child",
  reorder: "Reorder",
  breadcrumb_new: "New description",
  breadcrumb_root: "Descriptions",
  empty_heading: "No descriptions",
  empty_body:
    "Add the first description or import existing records.",
  filter_placeholder: "Filter...",
  ref_code_helper:
    "Suggested from parent record. You can edit it.",
  parent_helper: "Parent: {{parentTitle}}",

  // Section labels: keyed by stable English section id from the
  // standard configs (`app/lib/standards/{isadg,dacs,rad}.ts`). Per-
  // standard overrides live as sibling literal keys (e.g.
  // `"context.dacs"`) and resolve via `tStd(t, "sections.context",
  // standard)` — see file header note on keySeparator semantics.
  sections: {
    // Shared (ISAD(G) baseline + DACS/RAD overlapping)
    identity: "Identification",
    context: "Context",
    content: "Content and structure",
    conditions: "Conditions of access and use",
    allied: "Allied materials",
    notes: "Notes",
    bibliographic: "Bibliographic data",
    digital: "Digital objects",
    entities: "Linked entities",
    places: "Linked places",

    // Per-standard override: DACS calls the context block
    // "Biographical/Historical Note" rather than "Context".
    "context.dacs": "Biographical/Historical Note",

    // DACS-specific section labels
    description_control: "Description Control",
    acquisition: "Acquisition and Appraisal Information",
    related_materials: "Related Materials",
    conditions_access: "Conditions of Access and Use",
    rights: "Rights Statements",

    // RAD-specific section labels
    edition: "Edition",
    // RAD class-specific section renders empty in v0.4 (no
    // cartographic/architectural/philatelic columns post-Phase-30; see
    // `app/lib/standards/rad.ts` header).
    class_specific: "Class of Materials Specific Details",
    dates_creation: "Dates of Creation",
    physical_description: "Physical Description",
    publishers_series: "Publisher's Series",
    archival_description: "Archival Description",
    standard_number: "Standard Number",
    access_points: "Access Points",
  },

  // Field labels: keyed by column name on `descriptions`.
  // Per-standard overrides as sibling literal keys at the same level.
  fields: {
    // Identity area
    referenceCode: "Reference code",
    localIdentifier: "Local identifier",
    title: "Title",
    translatedTitle: "Translated title",
    uniformTitle: "Uniform title",
    descriptionLevel: "Level of description",
    resourceType: "Resource type",
    genre: "Genre",
    repositoryId: "Repository",
    parentId: "Parent record",
    childCount: "Child items",

    // Per-standard override: RAD distinguishes "Title proper" from
    // supplied/parallel titles (1.1B1 / 2.1B); ISAD(G) and DACS use
    // the bare "Title".
    "title.rad": "Title proper",

    // Date / extent
    dateExpression: "Date(s)",
    dateStart: "Start date",
    dateEnd: "End date",
    dateCertainty: "Date certainty",
    extent: "Extent",
    dimensions: "Dimensions",
    medium: "Medium",

    // Context
    creatorDisplay: "Creator",
    provenance: "Custodial history",
    adminBiogHistory: "Administrative/Biographical history",

    // Content and structure
    scopeContent: "Scope and content",
    systemOfArrangement: "System of arrangement",
    physicalCharacteristics: "Physical characteristics",
    arrangement: "Arrangement",
    ocrText: "OCR text",

    // Conditions
    accessConditions: "Conditions governing access",
    reproductionConditions: "Conditions governing reproduction",
    language: "Language of materials",

    // Allied materials
    locationOfOriginals: "Location of originals",
    locationOfCopies: "Location of copies",
    findingAids: "Finding aids",

    // Notes / citation
    notes: "Notes",
    internalNotes: "Internal notes",
    preferredCitation: "Preferred citation",

    // Acquisition (DACS)
    acquisitionInfo: "Acquisition information",

    // Bibliographic
    imprint: "Imprint",
    editionStatement: "Edition statement",
    seriesStatement: "Series statement",
    volumeNumber: "Volume number",
    issueNumber: "Issue number",
    pages: "Pages",
    sectionTitle: "Section title",
    publicationTitle: "Publication title",

    // Description control (RAD `standard_number` analogue lands here)
    descriptionsArchivists: "Archivists",
    revisionHistory: "Revision history",
    languageOfDescription: "Language of description",

    // DBE identifier (RAD authority cross-reference)
    dbeId: "DBE identifier",

    // Digital surrogate
    iiifManifestUrl: "IIIF manifest URL",
    hasDigital: "Has digital surrogate",
  },

  // Entity/place linking
  add_entity: "Add entity",
  add_place: "Add place",
  search_entity: "Search entity...",
  search_place: "Search place...",
  role_label: "Role",
  // Entity roles (must match ENTITY_ROLES in lib/validation/enums.ts)
  role_creator: "Creator",
  role_author: "Author",
  role_editor: "Editor",
  role_publisher: "Publisher",
  role_sender: "Sender",
  role_recipient: "Recipient",
  role_mentioned: "Mentioned",
  role_subject: "Subject",
  role_scribe: "Scribe",
  role_witness: "Witness",
  role_notary: "Notary",
  role_photographer: "Photographer",
  role_artist: "Artist",
  role_plaintiff: "Plaintiff",
  role_defendant: "Defendant",
  role_petitioner: "Petitioner",
  role_judge: "Judge",
  role_appellant: "Appellant",
  role_official: "Official",
  role_heir: "Heir",
  role_albacea: "Executor",
  role_spouse: "Spouse",
  role_victim: "Victim",
  role_grantor: "Grantor",
  role_donor: "Donor",
  role_seller: "Seller",
  role_buyer: "Buyer",
  role_mortgagor: "Mortgagor",
  role_mortgagee: "Mortgagee",
  role_creditor: "Creditor",
  role_debtor: "Debtor",
  role_fiador: "Surety",
  role_apoderado: "Attorney-in-Fact",
  // Place roles (must match PLACE_ROLES in lib/validation/enums.ts)
  role_created: "Created",
  role_sent_from: "Sent from",
  role_sent_to: "Sent to",
  role_published: "Published",
  role_venue: "Venue",
  // Role-picker group labels (optgroups; keys mirror ENTITY_ROLE_GROUPS)
  role_group_production: "Production & mentions",
  role_group_correspondence: "Correspondence",
  role_group_notarial: "Notarial attestation",
  role_group_legal: "Legal proceedings",
  role_group_family: "Family & inheritance",
  role_group_transactions: "Transactions",
  role_group_visual: "Visual materials",
  honorific_label: "Honorific",
  function_label: "Function",
  name_as_recorded_label: "Name as recorded",
  link_confirm: "Confirm",
  link_cancel: "Cancel",
  remove_link_confirm: "Remove link with {{name}}?",
  remove_link_button: "Remove",
  no_results: "No results found",

  // Draft/changelog
  commit_note_placeholder: "Note about changes (optional)",
  autosave_saving: "Saving...",
  autosave_saved: "Draft saved",
  conflict_banner:
    "{{name}} has unsaved changes from {{time}}.",
  overwrite_confirm:
    "This record was modified by {{name}} at {{time}}. Overwrite?",
  overwrite_button: "Overwrite",
  overwrite_cancel: "Cancel",

  // Publishing
  published_badge: "Published",
  unpublished_badge: "Unpublished",
  pending_publish: "Pending publish",
  pending_removal: "Pending removal",
  live_badge: "Live",
  publish_action: "Publish",
  unpublish_action: "Unpublish",

  // Errors
  error_generic: "An error occurred. Try again.",
  error_required: "This field is required.",
  error_duplicate_ref:
    "A description with that reference code already exists.",
  error_invalid_level:
    "The level must be below the parent record's level.",
  error_delete_blocked:
    "Cannot delete -- {{count}} child descriptions",
  error_delete_cascade:
    "Deleting this description will remove {{entityCount}} entity links and {{placeCount}} place links.",
  error_delete_confirm:
    "Are you sure you want to delete {{title}}? This action cannot be undone.",
  error_move_children:
    "This description has {{count}} children that will also be moved.",

  // Success
  success_created: "Description created.",
  success_updated: "Description updated.",
  success_deleted: "Description deleted.",
  success_moved: "Description moved.",
  success_published: "Description published.",
  success_unpublished: "Description unpublished.",
  success_entity_linked: "Entity linked.",
  success_place_linked: "Place linked.",
  success_link_removed: "Link removed.",

  // Accessibility labels
  aria_move_up: "Move up",
  aria_move_down: "Move down",
  aria_edit_link: "Edit link",
  aria_remove_link: "Remove link with {{name}}",

  // Description level display names
  level_fonds: "Fonds",
  level_subfonds: "Subfonds",
  level_series: "Series",
  level_subseries: "Subseries",
  level_file: "File",
  level_item: "Item",
  level_collection: "Collection",
  level_section: "Section",
  level_volume: "Volume",

  // View toggle
  view_tree: "File tree",
  view_columns: "Column view",

  // Column view table headers
  col_reference_code: "Reference code",
  col_title: "Title",
  col_level: "Level",
  col_repository: "Repository",
  col_has_digital: "Digital object",
  col_parent_code: "Parent code",
  col_toggle: "Columns",

  // Column view filters
  filter_level: "Description level",
  filter_repository: "Repository",
  filter_has_digital: "Has digital object",
  search_descriptions: "Search by title or reference code...",

  // Tree browser
  root_column_title: "Contents",
  loading: "Loading...",

  // No manifest placeholder
  no_manifest: "No digitized material",
  add_manifest: "Add IIIF manifest URL",

  // IIIF viewer
  loading_manifest: "Loading manifest...",
  empty_manifest: "No pages found in manifest",
  manifest_load_error: "Could not load manifest",
  zoom_in: "Zoom in",
  zoom_out: "Zoom out",
  prev_page: "Previous page",
  next_page: "Next page",
} as const;

/* @version v0.4.3 */
