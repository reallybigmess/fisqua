/**
 * Spanish translations — description namespace (cataloguing)
 *
 * This locale namespace deals with the cataloguing-side labels for the
 * segmentation/viewer-context description form. Mirrors the EN namespace
 * shape one-to-one (English KEYS, Spanish VALUES). Both files share
 * `satisfies ResourceLanguage` against the common `app/locales/en.ts`
 * shape; one without the other would fail the `i18n-completeness.test.ts`
 * keystone.
 *
 * Spanish style: Colombian Spanish, tú-form, no voseo. Never `querés`,
 * `preferís`, `sabés`, `tenés`, `sos`; always `quieres`, `prefieres`,
 * `sabes`, `tienes`, `eres`.
 *
 * Description-level keys: deprecated `expediente` and `unidad_documental`
 * (legacy level names) replaced with the canonical `DESCRIPTION_LEVELS`
 * enum from `app/lib/validation/enums.ts`. Spanish value rendering
 * follows Zasqua's archival-terminology conventions — file =
 * "Expediente", item = "Unidad documental simple", and the rest follow
 * the canonical ISAD(G) Spanish renditions used elsewhere in the
 * codebase.
 *
 * Save-status keys bajo `editor:` — `save_status_error` ("Error al
 * guardar", convención colombiana preferida a la calcada "Falló el
 * guardado"), `save_failed_retry` ("No se pudo guardar — reintentar",
 * em-dash con espacios, sin voseo), y `save_now` ("Guardar ahora").
 *
 * Unsaved-navigation key bajo `editor:` — `unsaved_confirm_leave`
 * ("Tienes cambios sin guardar. ¿Salir de todas formas?"). Forma tú
 * (sin voseo). Es el prompt heredado de `window.confirm(...)` que
 * dispara `useBlocker` antes de proceder con una navegación interna
 * mientras hay trabajo no guardado o no resuelto.
 *
 * Modal personalizado de cambios sin guardar — cuatro claves bajo
 * `editor:`: `unsaved_dialog_title`, `unsaved_dialog_body`,
 * `unsaved_dialog_stay`, `unsaved_dialog_leave` — con el texto del
 * `<UnsavedChangesDialog>` que reemplaza el `window.confirm` nativo.
 * Forma tú (sin voseo); se conserva "Salir de todas formas" para
 * mantener consistencia con la clave heredada `unsaved_confirm_leave`.
 * El cuerpo del diálogo usa el registro impersonal "no se haya
 * guardado" para el cierre y tú-form para la apertura ("Tienes
 * cambios").
 *
 * @version v0.4.1
 */
export default {
  status: {
    unassigned: "Sin asignar",
    assigned: "Asignado",
    in_progress: "En curso",
    described: "Descrito",
    reviewed: "Revisado",
    approved: "Aprobado",
    sent_back: "Devuelto",
  },
  sections: {
    identity: "Identificación",
    physical_description: "Descripción física",
    content: "Contenido",
    conditions_access: "Acceso y condiciones",
    notes: "Notas",
    entities_places: "Personas y lugares",
  },
  fields: {
    title: "Título",
    translatedTitle: "Título traducido",
    translatedTitle_hint: "Traducción al inglés",
    descriptionLevel: "Nivel de descripción",
    resourceType: "Tipo de recurso",
    dateExpression: "Fecha",
    dateExpression_placeholder: "1815-1820, ca. 1823",
    dateStart: "Fecha inicial",
    dateEnd: "Fecha final",
    extent: "Extensión",
    extent_placeholder: "6 folios, 1 cuaderno",
    dimensions: "Dimensiones",
    dimensions_placeholder: "21 x 15 cm",
    medium: "Medio/Soporte",
    medium_placeholder: "papel",
    scopeContent: "Alcance y contenido",
    language: "Idioma",
    language_placeholder: "español, latín",
    originalReference: "Signatura original",
    notes: "Notas generales",
    internalNotes: "Notas del archivero",
    referenceCode: "Código de referencia",
    optional: "Opcional",
  },
  resource_types: {
    texto: "Texto",
    imagen: "Imagen",
    cartografico: "Cartográfico",
    mixto: "Mixto",
  },
  description_levels: {
    fonds: "Fondo",
    subfonds: "Subfondo",
    series: "Serie",
    subseries: "Subserie",
    file: "Expediente",
    item: "Unidad documental simple",
    collection: "Colección",
    section: "Sección",
    volume: "Volumen",
  },
  actions: {
    enviar_para_revision: "Enviar para revisión",
    guardar: "Guardar",
  },
  validation: {
    campo_requerido: "Este campo es obligatorio",
    formato_fecha_invalido: "Formato de fecha no válido",
  },
  tabs: {
    segmentacion: "Segmentación",
    descripcion: "Descripción",
  },
  dashboard: {
    reviewer_feedback_label: "Comentarios del revisor:",
    problem_type: {
      incorrect_boundaries: "Límites incorrectos",
      merged_documents: "Documentos fusionados",
      split_document: "Documento dividido",
      missing_pages: "Páginas faltantes",
      other: "Otro",
    },
  },
  no_entries_in_volume: "No hay entradas en este volumen.",
  item_position: "Item {{position}}",
  assignment: {
    asignar_catalogador: "Asignar catalogador",
    asignar_revisor: "Asignar revisor",
    sin_asignar: "Sin asignar",
    seleccionar_siguientes: "Seleccionar {{count}} siguientes",
    seleccionar_no_asignados: "Seleccionar no asignados",
    items_seleccionados_one: "{{count}} ítem seleccionado",
    items_seleccionados_other: "{{count}} ítems seleccionados",
    asignar: "Asignar",
    asignar_entradas: "Asignar entradas",
    progreso_equipo: "Progreso del equipo",
    entradas: "entradas",
    paginas: "Páginas",
    item: "Item",
    posicion: "Pos.",
    catalogador: "Catalogador",
    revisor: "Revisor",
    estado: "Estado",
    alerta_resegmentacion: "Este volumen tiene reportes de re-segmentación abiertos",
    selection_options: "Opciones de selección",
  },
  progress: {
    items_approved: "{{approved}}/{{total}} ítems aprobados",
  },
  promote: {
    listos_para_descripcion: "Listos para descripción",
    entradas_aprobadas: "{{count}} entradas aprobadas",
    pasar_a_descripcion: "Pasar a descripción",
    volumenes_en_descripcion: "Volúmenes en descripción",
    descripcion_no_iniciada: "Descripción no iniciada",
    columna_volumen: "Volúmenes",
    columna_entradas: "Entradas",
    columna_progreso: "Progreso",
    columna_alertas: "Alertas",
    columna_acciones: "Acciones",
    asignar: "Asignar",
  },
  navigation: {
    anterior: "Anterior",
    siguiente: "Siguiente",
    de: "de",
  },
  completion: {
    seccion_completa: "Sección completa",
    seccion_incompleta: "Sección incompleta",
  },
  locked: {
    entities_places: "La vinculación de personas y lugares estará disponible próximamente",
  },
  editor: {
    subtitle: "Catalogación — Descripción",
    cerrar_sesion: "Cerrar sesión",
    readonly_unassigned: "Esta entrada aún no ha sido asignada. Asigna un catalogador desde la página de asignaciones para comenzar a describir.",
    readonly_not_assigned: "No estás asignado como catalogador de esta entrada.",
    readonly_status: "Esta entrada no puede editarse en su estado actual.",
    save_status_saved: "Guardado",
    save_status_saving: "Guardando...",
    save_status_unsaved: "Sin guardar",
    save_status_error: "Error al guardar",
    save_failed_retry: "No se pudo guardar — reintentar",
    save_now: "Guardar ahora",
    unsaved_confirm_leave: "Tienes cambios sin guardar. ¿Salir de todas formas?",
    unsaved_dialog_title: "Cambios sin guardar",
    unsaved_dialog_body:
      "Tienes cambios sin guardar. Si sales de esta página ahora, vas a perder cualquier trabajo que no se haya guardado todavía.",
    unsaved_dialog_stay: "Seguir en la página",
    unsaved_dialog_leave: "Salir de todas formas",
    pantalla_completa: "Expandir",
    contraer_imagen: "Contraer",
    descripcion_pausada: "La descripción de este volumen está pausada por un reporte de re-segmentación",
    reportar_problema: "Reportar problema",
  },
  resegmentation: {
    reportar_problema: "Reportar problema de segmentación",
    warning: "Al enviar este reporte, se pausará la descripción de todo el volumen hasta que un revisor corrija la segmentación.",
    tipo_problema: "Tipo de problema",
    limites_incorrectos: "Límites incorrectos",
    limites_incorrectos_desc: "El documento empieza o termina en otro lugar",
    documentos_fusionados: "Documentos fusionados",
    documentos_fusionados_desc: "Esto debería ser más de un item",
    documento_dividido: "Documento dividido",
    documento_dividido_desc: "Este item y otro(s) son un solo documento",
    paginas_faltantes: "Páginas faltantes o sobrantes",
    otro: "Otro",
    entradas_afectadas: "Entradas afectadas",
    descripcion_placeholder: "Describe lo que observas y qué corrección se necesita...",
    enviar_reporte: "Enviar reporte",
    cancelar: "Cancelar",
  },
  // Tokens de error emitidos por el validador (CR-04). Mantener en
  // paralelo con el namespace administrativo `descriptions` para que
  // los códigos estables `field_required` / `invalid_level` se
  // resuelvan a texto localizado en ambas superficies.
  error_required: "Este campo es obligatorio para el estándar activo.",
  error_invalid_level:
    "Este nivel no es válido para el nivel de la descripción padre.",
} as const;

/* @version v0.4.1 */
