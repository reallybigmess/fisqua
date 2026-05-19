/**
 * Spanish translations — comments namespace
 *
 * This locale namespace carries the Spanish strings for the entry-,
 * page-, and QC-flag comment threads attached to volumes — the new
 * comment composer, the reply affordance, the role labels, and the
 * empty-state copy. Keys are deliberately Spanish in shape because
 * the comment feature was first built in Spanish and the ES values
 * map onto the same keys.
 *
 * @version v0.4.0
 */
export default {
  comentarios: "Comentarios",
  responder: "Responder",
  enviar: "Enviar",
  cancelar: "Cancelar",
  comentar: "Comentar",
  nuevo_comentario: "Nuevo comentario",
  roles: {
    catalogador: "Catalogador",
    revisor: "Revisor",
    lead: "Responsable",
  },
  timestamps: {
    hace_un_momento: "Hace un momento",
    hace_minutos: "Hace {{count}} min",
    hace_horas: "Hace {{count}} h",
    hace_dias: "Hace {{count}} d",
  },
  target: {
    entry_label: "En esta entrada",
    page_label: "En esta página",
  },
  on_page: "en la página {{pageLabel}}",
  // Menú kebab + edición en línea + diálogo de confirmación
  // + chips de estado. Las claves replican la estructura inglesa para que
  // el componente pueda buscar ambos idiomas con el mismo prefijo corto.
  comments: {
    kebab: {
      aria_label: "Acciones del comentario",
      edit: "Editar",
      delete: "Eliminar",
      resolve: "Marcar como resuelto",
      reopen: "Reabrir",
    },
    confirm: {
      delete_root_with_replies: {
        title: "¿Eliminar este comentario?",
        body: "Esta acción eliminará este comentario y sus {{count}} respuesta(s).",
      },
      delete_simple: {
        title: "¿Eliminar este comentario?",
        body: "Esta acción no se puede deshacer.",
      },
      delete: {
        confirm: "Eliminar",
        cancel: "Cancelar",
      },
    },
    edit: {
      save: "Guardar",
      cancel: "Cancelar",
      aria_label: "Editar el texto del comentario",
      empty_error: "El comentario no puede estar vacío.",
    },
    status: {
      edited: "Editado",
      resolved: "Resuelto",
    },
    error: {
      delete_failed: "No se pudo eliminar el comentario. Inténtalo de nuevo.",
      edit_failed: "No se pudo guardar el cambio. Inténtalo de nuevo.",
      resolve_failed: "No se pudo cambiar el estado. Inténtalo de nuevo.",
      forbidden: "No tienes permiso para hacer esto.",
    },
  },
} as const;

// Version: v0.3.1 (2026-04-18) — comment kebab / confirm / status / edit copy
