/**
 * Spanish translations — vocabularies namespace
 *
 * This locale namespace carries the Spanish strings for the
 * controlled-vocabulary admin surface — the page heading, the
 * term-management affordances (add, save, approve, deprecate), and
 * the merge/split workflow labels that authority editors use to keep
 * the function and subject vocabularies tidy.
 *
 * @version v0.4.1
 */
export default {
  // Page
  page_title: "Vocabularios",
  add_function: "Agregar funci\u00f3n",
  add_term: "Agregar t\u00e9rmino",
  save_term: "Guardar t\u00e9rmino",
  approve_term: "Aprobar t\u00e9rmino",
  merge_into: "Fusionar con...",
  split_term: "Dividir t\u00e9rmino",
  deprecate_term: "Deprecar t\u00e9rmino",
  rename_term: "Renombrar t\u00e9rmino",
  reject_term: "Rechazar t\u00e9rmino",
  edit_term: "Editar",
  delete_term: "Eliminar",

  // Empty states
  no_functions_found: "No se encontraron funciones",
  no_functions_body:
    "Ninguna funci\u00f3n coincide con los filtros. Intenta ajustar la categor\u00eda o el estado.",
  no_proposed: "No hay t\u00e9rminos propuestos pendientes de revisi\u00f3n.",
  no_linked_entities: "Ninguna entidad usa esta funci\u00f3n.",
  no_terms_defined: "No hay t\u00e9rminos definidos. Agrega uno arriba.",

  // Validation and errors
  cannot_delete: "No se puede eliminar: usado por {{count}} registros",
  deprecate_confirm:
    "Deprecar '{{term}}'? {{count}} entidades usan esta funci\u00f3n actualmente. Conservar\u00e1n la etiqueta pero ya no aparecer\u00e1 en las sugerencias.",
  reject_confirm:
    "Rechazar '{{term}}'? Incluye una raz\u00f3n para el rechazo.",
  error_save:
    "No se pudo guardar el t\u00e9rmino. Verifica tu conexi\u00f3n e intenta de nuevo.",
  error_merge:
    "La fusi\u00f3n fall\u00f3. El t\u00e9rmino destino puede haber sido eliminado. Actualiza e intenta de nuevo.",

  // Statuses
  status_approved: "Aprobado",
  status_proposed: "Propuesto",
  status_deprecated: "Deprecado",

  // Categories
  cat_civil_office: "Cargo civil",
  cat_military_rank: "Rango militar",
  cat_ecclesiastical_office: "Cargo eclesi\u00e1stico",
  cat_academic_degree: "Grado acad\u00e9mico",
  cat_honorific: "Honor\u00edfico",
  cat_occupation_trade: "Oficio / ocupaci\u00f3n",
  cat_documentary_role: "Rol documental",
  cat_kinship: "Parentesco",
  cat_status_condition: "Estado / condici\u00f3n",
  cat_institutional_ref: "Referencia institucional",

  // Vocabulary names
  vocab_entity_roles: "Roles de entidad",
  vocab_place_roles: "Roles de lugar",
  vocab_entity_types: "Tipos de entidad",
  vocab_place_types: "Tipos de lugar",
  vocab_primary_functions: "Funciones principales",

  // Vocab card subtitles
  vocab_entity_roles_desc: "Roles que vinculan entidades a descripciones",
  vocab_place_roles_desc: "Roles que vinculan lugares a descripciones",
  vocab_entity_types_desc: "Persona, familia o entidad corporativa",
  vocab_place_types_desc: "Pa\u00eds, ciudad, parroquia, hacienda y m\u00e1s",
  vocab_primary_functions_desc: "Funciones y t\u00edtulos hist\u00f3ricos",

  // Counts and labels
  n_terms: "{{count}} t\u00e9rminos",
  n_proposed: "{{count}} propuestos",
  linked_entities: "Entidades vinculadas",
  review_queue: "Cola de revisi\u00f3n",
  all_filter: "Todos",
  search_placeholder: "Buscar funciones...",

  // Table columns
  col_function: "Funci\u00f3n",
  col_category: "Categor\u00eda",
  col_usage: "Uso",
  col_status: "Estado",
  col_actions: "Acciones",

  // Detail
  proposed_by: "Propuesto por",
  field_canonical: "Etiqueta can\u00f3nica",
  field_category: "Categor\u00eda",
  field_status: "Estado",
  field_notes: "Notas",

  // Enum management warnings
  enum_redeployment_warning:
    "Los cambios en estos vocabularios requieren una actualizaci\u00f3n del c\u00f3digo y un redespliegue.",
  enum_pending_changes: "Cambios pendientes (a\u00fan no desplegados)",

  // Linked-entities list overflow (first page + remainder)
  linked_more: "{{count}} m\u00e1s",

  // Shared merge/split dialog labels. Tuteo matches this namespace's
  // register; \u00abfusionar\u00bb (not \u00abcombinar\u00bb) matches merge_into and
  // error_merge above; \u00abtodas\u00bb agrees with the dialog's rows
  // (entidades), unlike the entities namespace's masculine v\u00ednculos.
  mergeTitle: "Fusionar funci\u00f3n",
  mergeSearch: "Buscar funci\u00f3n destino...",
  mergeReassignTitle: "Reasignar entidades",
  mergeReassignSubtitle: "{{name}} tiene {{count}} entidades vinculadas",
  mergeConfirm: "Confirmar fusi\u00f3n",
  mergeCancel: "Cancelar",
  splitTitle: "Dividir funci\u00f3n",
  splitSubtitle:
    "Se crear\u00e1 una nueva funci\u00f3n a partir de {{name}}. Selecciona las entidades que deben pasar a la nueva funci\u00f3n.",
  splitConfirm: "Confirmar divisi\u00f3n",
  splitCancel: "Cancelar",
  splitNameLabel: "Nombre de la nueva funci\u00f3n",
  splitNamePlaceholder: "Escribe el nombre de la nueva funci\u00f3n...",
  loadMore: "Cargar m\u00e1s",
  selectAll: "Seleccionar todas",
  deselectAll: "Deseleccionar todas",
} as const;
