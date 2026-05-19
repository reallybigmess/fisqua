/**
 * Spanish translations — workflow namespace
 *
 * This locale namespace carries the Spanish strings for the
 * cataloguing workflow state machine — the six status labels
 * (sin comenzar, en curso, segmentado, necesita revisión, revisado,
 * aprobado) and the action labels that drive transitions between them.
 *
 * @version v0.3.0
 */
export default {
  status: {
    unstarted: "Sin comenzar",
    in_progress: "En curso",
    segmented: "Segmentado",
    sent_back: "Necesita revisión",
    reviewed: "Revisado",
    approved: "Aprobado",
  },
  action: {
    assign: "Asignar",
    approve: "Aprobar",
    send_back: "Rechazar",
    submit_for_review: "Enviar para revisión",
    accept_corrections: "Aceptar correcciones",
    unassign: "Desasignar",
  },
  role: {
    lead: "Coordinador",
    cataloguer: "Catalogador",
    reviewer: "Revisor",
  },
  bulk: {
    selected_one: "{{count}} unidad compuesta seleccionada",
    selected_other: "{{count}} uds. seleccionadas",
  },
  dropdown: {
    cataloguer_placeholder: "Catalogador...",
    reviewer_placeholder: "Revisor...",
    unassigned: "Sin asignar",
  },
  dialog: {
    confirm_assign: "Asignar unidad compuesta",
    confirm_unassign: "Desasignar unidad compuesta",
    confirm_approve: "Aprobar unidad compuesta",
    confirm_send_back: "Rechazar unidad compuesta",
    submit_title: "Enviar para revisión",
    submit_body: "Enviar <strong>{{volumeName}}</strong> para revisión? No podrás editar hasta que el revisor la devuelva.",
    submit_confirm: "Enviar para revisión",
    send_back_title: "Rechazar",
    send_back_body: "Indica qué necesita corrección en <strong>{{volumeName}}</strong>:",
    send_back_placeholder: "Describe los problemas que necesitan corrección...",
    send_back_min_chars: "Mínimo {{min}} caracteres ({{current}}/{{min}})",
    send_back_confirm: "Rechazar",
  },
} as const;
