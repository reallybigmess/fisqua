/**
 * English translations — comments namespace
 *
 * This locale namespace carries the English strings for the entry-,
 * page-, and QC-flag comment threads attached to volumes — the new
 * comment composer, the reply affordance, the role labels, and the
 * empty-state copy. Keys are deliberately Spanish in shape because
 * the comment feature was first built in Spanish and the EN values
 * map onto the same keys.
 *
 * @version v0.4.0
 */
export default {
  comentarios: "Comments",
  responder: "Reply",
  enviar: "Send",
  cancelar: "Cancel",
  comentar: "Comment",
  nuevo_comentario: "New comment",
  roles: {
    catalogador: "Cataloguer",
    revisor: "Reviewer",
    lead: "Lead",
  },
  timestamps: {
    hace_un_momento: "Just now",
    hace_minutos: "{{count}} min ago",
    hace_horas: "{{count}} h ago",
    hace_dias: "{{count}} d ago",
  },
  target: {
    entry_label: "On this entry",
    page_label: "On this page",
  },
  on_page: "on page {{pageLabel}}",
  // Kebab menu + inline edit + delete confirm + state chips.
  // Keys are grouped by surface (kebab, confirm, edit, status, error) so
  // the component can fetch them with a short, predictable prefix.
  comments: {
    kebab: {
      aria_label: "Comment actions",
      edit: "Edit",
      delete: "Delete",
      resolve: "Mark as resolved",
      reopen: "Reopen",
    },
    confirm: {
      delete_root_with_replies: {
        title: "Delete this comment?",
        body: "This will delete this comment and its {{count}} repl{{count, plural, one{y} other{ies}}}.",
      },
      delete_simple: {
        title: "Delete this comment?",
        body: "This cannot be undone.",
      },
      delete: {
        confirm: "Delete",
        cancel: "Cancel",
      },
    },
    edit: {
      save: "Save",
      cancel: "Cancel",
      aria_label: "Edit comment body",
      empty_error: "Comment cannot be empty.",
    },
    status: {
      edited: "Edited",
      resolved: "Resolved",
    },
    error: {
      delete_failed: "Could not delete the comment. Please try again.",
      edit_failed: "Could not save the edit. Please try again.",
      resolve_failed:
        "Could not update the resolution status. Please try again.",
      forbidden: "You don't have permission to do that.",
    },
  },
} as const;

// Version: v0.3.1 (2026-04-18) — comment kebab / confirm / status / edit copy
