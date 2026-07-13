/**
 * Spanish translations — viewer namespace
 *
 * This locale namespace carries the Spanish strings for the
 * segmentation viewer — the toolbar, the boundary-state save status,
 * the unsaved-changes prompts, and the custom unsaved-changes modal
 * that replaces the native `window.confirm` on in-app navigation.
 *
 * Save-status keys bajo `save_status:` — `error` ("Error al guardar",
 * convención colombiana preferida a la calcada "Falló el guardado"),
 * `save_failed_retry` ("No se pudo guardar — reintentar", em-dash con
 * espacios, sin voseo), y `save_now` ("Guardar ahora").
 *
 * Unsaved-navigation key bajo `save_status:` — `unsaved_confirm_leave`
 * ("Tienes cambios sin guardar. ¿Salir de todas formas?"). Forma tú
 * (sin voseo). Mismo texto que el namespace de descripción,
 * deliberadamente — un solo prompt en los dos editores hace que la
 * experiencia de "salir con trabajo pendiente" sea idéntica.
 *
 * Modal personalizado de cambios sin guardar — cuatro claves bajo
 * `save_status:`: `unsaved_dialog_title`, `unsaved_dialog_body`,
 * `unsaved_dialog_stay`, `unsaved_dialog_leave` — con el texto del
 * `<UnsavedChangesDialog>` que reemplaza el `window.confirm` nativo.
 * Los strings replican palabra-por-palabra el namespace de
 * descripción para que el catalogador vea el mismo diálogo en los
 * dos editores. Forma tú (sin voseo).
 *
 * @version v0.4.2
 */
export default {
  toolbar: {
    undo: "Deshacer",
    undo_shortcut: "Deshacer (Ctrl+Z)",
    redo: "Rehacer",
    redo_shortcut: "Rehacer (Ctrl+Shift+Z)",
    add_boundary: "Agregar división",
    delete_boundary: "Eliminar división",
    zoom_in: "Acercar",
    zoom_out: "Alejar",
    fit_to_width: "Ajustar al ancho",
    go_to_image: "Ir a imagen",
    back_to_volumes: "Volver a unidades compuestas",
    annotation: "Anotación",
    annotationPoint: "Punto",
    annotationBox: "Recuadro",
    annotationMove: "Mover",
  },
  save_status: {
    saved: "Guardado",
    saving: "Guardando...",
    unsaved: "Sin guardar",
    error: "Error al guardar",
    save_failed_retry: "No se pudo guardar — reintentar",
    save_now: "Guardar ahora",
    unsaved_confirm_leave: "Tienes cambios sin guardar. ¿Salir de todas formas?",
    unsaved_dialog_title: "Cambios sin guardar",
    unsaved_dialog_body:
      "Tienes cambios sin guardar. Si sales de esta página ahora, vas a perder cualquier trabajo que no se haya guardado todavía.",
    unsaved_dialog_stay: "Seguir en la página",
    unsaved_dialog_leave: "Salir de todas formas",
  },
  move_tool: {
    not_author: "Solo puedes mover tus propias anotaciones.",
    error_server: "No se pudo mover la anotación. Inténtalo de nuevo.",
  },
  outline: {
    title: "Estructura",
    hint: "Haz clic entre imágenes para agregar límites",
    page_boundary: "División entre páginas",
    within_page_boundary: "División dentro de página",
    document: "Documento",
    blank: "En blanco",
    continuation: "Continuación",
    front_matter: "Material preliminar",
    back_matter: "Material final",
    no_title: "Sin título",
    no_type: "(sin definir)",
    type_label: "Tipo",
    is_document_label: "¿Es un documento?",
    is_document_yes: "Sí",
    is_document_no: "No",
    subtype_label: "Subtipo",
    subtype_unset: "(seleccionar)",
    subtype_other: "Otro",
    subtype_other_placeholder: "Escribe un subtipo personalizado",
    non_doc_label: "Clase",
    title_label: "Título",
    ref_label: "Ref.",
    level_label: "Nivel",
    delete_boundary: "Eliminar límite",
    confirm_delete: "¿Eliminar?",
    confirm_delete_tooltip: "Confirmar eliminación",
    indent_tooltip: "Anidar bajo el elemento anterior",
    outdent_tooltip: "Mover al nivel superior",
    type: {
      item: "Documento",
      blank: "En blanco",
      front_matter: "Material preliminar",
      back_matter: "Material final",
      test_images: "Imágenes de prueba/calibración",
    },
    comments_label: "Comentarios",
    has_comments: "Tiene comentarios",
    reviewer_comment_label: "Comentario del revisor:",
    accepting: "Aceptando...",
    // Task 14 (CONTEXT rev 4): etiquetas de las tarjetas de comentario
    // en el esquema y copia de advertencia al eliminar una entrada.
    comment_kind_annotation: "Anotación",
    comment_kind_comment: "Comentario",
    comment_doc_prefix: "Doc {{n}}",
    comment_img_prefix: "img {{n}}",
    comment_reply: "Responder",
    comment_mark_seen: "Marcar como visto",
    comment_thread_header: "Hilo de conversación",
    add_comment: "Añadir comentario",
    delete_with_attached_count:
      "{{count, plural, one {Se eliminará # comentario vinculado a esta entrada.} other {Se eliminarán # comentarios vinculados a esta entrada.}}}",
    delete_with_anchored_remaining:
      "{{count, plural, one {# comentario vinculado a las imágenes permanecerá.} other {# comentarios vinculados a las imágenes permanecerán.}}}",
    readonly: {
      segmented: "Enviada para revisión",
      approved: "Esta unidad compuesta ha sido aprobada",
      not_assigned: "Solo lectura — no tienes asignación en esta unidad compuesta",
    },
  },
  // Diálogo de comentario obligatorio.
  comment_prompt: {
    title: "Agregar comentario",
    placeholder: "Escribe tu comentario...",
    submit: "Guardar",
    cancel: "Cancelar",
    region_label: "Región en p. {{page}}",
    error_empty: "El comentario no puede estar vacío.",
    error_server: "No se pudo guardar. Inténtalo de nuevo.",
  },
  // Aviso cuando el script de OpenSeadragon no carga.
  load_error: {
    message: "No se pudo cargar el visor de imágenes. Revisa tu conexión e intenta de nuevo.",
    retry: "Reintentar",
  },
} as const;

/* @version v0.4.2 */
