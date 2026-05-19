/**
 * English translations — description namespace (cataloguing)
 *
 * This locale namespace deals with the cataloguing-side labels for the
 * segmentation/viewer-context description form
 * (`app/components/description/description-form.tsx`, used when a
 * tenant has `crowdsourcing_enabled`). This namespace and
 * the admin namespace (`app/locales/{en,es}/descriptions.ts`) both
 * key `fields.<columnName>` / `sections.<id>` against stable English
 * identifiers that match `app/db/schema.ts` columns and the
 * standard-config section IDs in `app/lib/standards/{isadg,dacs,rad}.ts`.
 *
 * Historical note: prior Spanish keys in `sections:` (`identificacion`,
 * `descripcion_fisica`, `contenido`, `notas`, `personas_lugares`,
 * `acceso_condiciones`) and in `fields:` (`titulo`, `titulo_traducido`,
 * `tipo_recurso`, `fecha`, `fecha_inicial`, `fecha_final`, `extension`,
 * `dimensiones`, `medio_soporte`, `alcance_contenido`, `idioma`,
 * `signatura_original`, `notas_generales`, `notas_archivero`,
 * `codigo_referencia`, `nivel_descripcion`) were renamed to English
 * column-name keys. The `satisfies ResourceLanguage` constraint at
 * `app/locales/en.ts` and the `i18n-completeness.test.ts` keystone
 * surface every consumer at TypeScript compile time.
 *
 * Per-standard overrides as sibling literal-string keys at the same
 * nesting level (matches the admin namespace shape; see
 * `app/locales/en/descriptions.ts` header on the verified i18next
 * dot-keySeparator behaviour).
 *
 * Description-level keys: deprecated `expediente` and `unidad_documental`
 * (legacy level names that never aligned with the canonical
 * `DESCRIPTION_LEVELS` enum in `app/lib/validation/enums.ts`) replaced
 * with the canonical level set: fonds, subfonds, series, subseries,
 * file, item, collection, section, volume.
 *
 * Resource types are kept on their existing Spanish keys
 * (`texto`/`imagen`/`cartografico`/`mixto`) because the cataloguing
 * form's resource-type dropdown options use those literal values today
 * (not the canonical `RESOURCE_TYPES` enum); a separate v0.5+ pass
 * will harmonise the resource-type vocabulary with the schema enum.
 *
 * Save-status keys under `editor:` — `save_status_error`,
 * `save_failed_retry`, and `save_now` (wired to the Cmd/Ctrl+S handler
 * and the visible save button).
 *
 * Unsaved-navigation keys under `editor:` — `unsaved_confirm_leave`
 * is the legacy `window.confirm(...)` prompt fired by `useBlocker`
 * before proceeding with an outgoing in-app navigation while the
 * editor has unsaved or unsettled work. It stays in place for
 * historical compatibility; a future cleanup pass can drop it once
 * nothing references it.
 *
 * Custom unsaved-changes modal keys under `editor:` —
 * `unsaved_dialog_title`, `unsaved_dialog_body`, `unsaved_dialog_stay`,
 * `unsaved_dialog_leave` — carry the strings for the in-app
 * `<UnsavedChangesDialog>` that replaces the native `window.confirm`.
 *
 * @version v0.4.1
 */
export default {
  status: {
    unassigned: "Unassigned",
    assigned: "Assigned",
    in_progress: "In progress",
    described: "Described",
    reviewed: "Reviewed",
    approved: "Approved",
    sent_back: "Sent back",
  },
  sections: {
    identity: "Identification",
    physical_description: "Physical description",
    content: "Content",
    conditions_access: "Access and conditions",
    notes: "Notes",
    entities_places: "People and places",
  },
  fields: {
    title: "Title",
    translatedTitle: "Translated title",
    translatedTitle_hint: "English translation",
    descriptionLevel: "Level of description",
    resourceType: "Resource type",
    dateExpression: "Date",
    dateExpression_placeholder: "1815-1820, ca. 1823",
    dateStart: "Start date",
    dateEnd: "End date",
    extent: "Extent",
    extent_placeholder: "6 folios, 1 notebook",
    dimensions: "Dimensions",
    dimensions_placeholder: "21 x 15 cm",
    medium: "Medium/Support",
    medium_placeholder: "paper",
    scopeContent: "Scope and content",
    language: "Language",
    language_placeholder: "Spanish, Latin",
    originalReference: "Original reference",
    notes: "General notes",
    internalNotes: "Archivist notes",
    referenceCode: "Reference code",
    optional: "Optional",
  },
  resource_types: {
    texto: "Text",
    imagen: "Image",
    cartografico: "Cartographic",
    mixto: "Mixed",
  },
  description_levels: {
    fonds: "Fonds",
    subfonds: "Subfonds",
    series: "Series",
    subseries: "Subseries",
    file: "File",
    item: "Item",
    collection: "Collection",
    section: "Section",
    volume: "Volume",
  },
  actions: {
    enviar_para_revision: "Submit for review",
    guardar: "Save",
  },
  validation: {
    campo_requerido: "This field is required",
    formato_fecha_invalido: "Invalid date format",
  },
  tabs: {
    segmentacion: "Segmentation",
    descripcion: "Description",
  },
  no_entries_in_volume: "No entries in this volume.",
  item_position: "Item {{position}}",
  assignment: {
    asignar_catalogador: "Assign cataloguer",
    asignar_revisor: "Assign reviewer",
    sin_asignar: "Unassigned",
    seleccionar_siguientes: "Select next {{count}}",
    seleccionar_no_asignados: "Select unassigned",
    items_seleccionados_one: "{{count}} item selected",
    items_seleccionados_other: "{{count}} items selected",
    asignar: "Assign",
    asignar_entradas: "Assign entries",
    progreso_equipo: "Team progress",
    entradas: "entries",
    paginas: "Pages",
    item: "Item",
    posicion: "Pos.",
    catalogador: "Cataloguer",
    revisor: "Reviewer",
    estado: "Status",
    alerta_resegmentacion: "This volume has open re-segmentation reports",
    selection_options: "Selection options",
  },
  dashboard: {
    reviewer_feedback_label: "Reviewer feedback:",
    problem_type: {
      incorrect_boundaries: "Incorrect boundaries",
      merged_documents: "Merged documents",
      split_document: "Split document",
      missing_pages: "Missing pages",
      other: "Other",
    },
  },
  progress: {
    items_approved: "{{approved}}/{{total}} items approved",
  },
  promote: {
    listos_para_descripcion: "Ready for description",
    entradas_aprobadas: "{{count}} approved entries",
    pasar_a_descripcion: "Move to description",
    volumenes_en_descripcion: "Volumes in description",
    descripcion_no_iniciada: "Description not started",
    columna_volumen: "Volumes",
    columna_entradas: "Entries",
    columna_progreso: "Progress",
    columna_alertas: "Alerts",
    columna_acciones: "Actions",
    asignar: "Assign",
  },
  navigation: {
    anterior: "Previous",
    siguiente: "Next",
    de: "of",
  },
  completion: {
    seccion_completa: "Section complete",
    seccion_incompleta: "Section incomplete",
  },
  locked: {
    entities_places: "People and places linking will be available soon",
  },
  editor: {
    subtitle: "Cataloguing — Description",
    cerrar_sesion: "Log out",
    readonly_unassigned: "This entry has not been assigned yet. Assign a cataloguer from the assignments page to start describing.",
    readonly_not_assigned: "You are not assigned as the describer for this entry.",
    readonly_status: "This entry cannot be edited in its current status.",
    save_status_saved: "Saved",
    save_status_saving: "Saving...",
    save_status_unsaved: "Unsaved",
    save_status_error: "Save failed",
    save_failed_retry: "Save failed — retry",
    save_now: "Save now",
    unsaved_confirm_leave: "You have unsaved changes. Leave anyway?",
    unsaved_dialog_title: "Unsaved changes",
    unsaved_dialog_body:
      "You have unsaved changes. If you leave this page now, any work that has not been saved will be lost.",
    unsaved_dialog_stay: "Stay on page",
    unsaved_dialog_leave: "Leave anyway",
    pantalla_completa: "Expand",
    contraer_imagen: "Collapse",
    descripcion_pausada: "Description work on this volume is paused due to a re-segmentation report",
    reportar_problema: "Report issue",
  },
  resegmentation: {
    reportar_problema: "Report segmentation issue",
    warning: "Submitting this report will pause all description work on this volume until a reviewer corrects the segmentation.",
    tipo_problema: "Problem type",
    limites_incorrectos: "Incorrect boundaries",
    limites_incorrectos_desc: "The document starts or ends at a different place",
    documentos_fusionados: "Merged documents",
    documentos_fusionados_desc: "This should be more than one item",
    documento_dividido: "Split document",
    documento_dividido_desc: "This item and other(s) are a single document",
    paginas_faltantes: "Missing or extra pages",
    otro: "Other",
    entradas_afectadas: "Affected entries",
    descripcion_placeholder: "Describe what you observe and what correction is needed...",
    enviar_reporte: "Submit report",
    cancelar: "Cancel",
  },
  // Validator-emitted error tokens (CR-04). Keep parallel with the
  // admin `descriptions` namespace so the standard-aware validator
  // factory's stable `field_required` / `invalid_level` issue codes
  // resolve to localised text in both surfaces.
  error_required: "This field is required for the active standard.",
  error_invalid_level:
    "This level is not valid for the parent description's level.",
} as const;

/* @version v0.4.1 */
