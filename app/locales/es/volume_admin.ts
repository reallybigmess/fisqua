/**
 * Spanish translations — volume_admin namespace
 *
 * This locale namespace carries the Spanish strings for the volume
 * detail page under `/admin/volumes/$id` — the breadcrumb, the
 * "open in viewer" affordance, the section headings (progress,
 * assignments, workflow, metadata, danger zone) and the empty-state
 * copy for the entries table.
 *
 * @version v0.3.0
 */
export default {
  breadcrumb_volumes: "Unidades compuestas",
  open_in_viewer: "Abrir en el visor",
  pages: "{{count}} páginas",
  section_progress: "Progreso",
  section_assignments: "Asignaciones",
  section_workflow: "Flujo de trabajo",
  section_metadata: "Metadatos",
  section_danger_zone: "Zona de riesgo",
  entries_empty: "Aún no hay entradas. Las entradas se crean durante la segmentación.",
  col_description_status: "Estado de descripción",
  col_count: "Cantidad",
  col_total: "Total",
  cataloguer_label: "Catalogador (segmentación)",
  reviewer_label: "Revisor",
  unassigned: "Sin asignar",
  change_status_to: "Cambiar estado a",
  select_new_status: "Seleccionar nuevo estado...",
  apply: "Aplicar",
  no_transitions: "No hay transiciones de estado disponibles para su rol.",
  sent_back_prefix: "Devuelto:",
  sent_back_reason: "Motivo de la devolución",
  name_label: "Nombre",
  reference_code_label: "Código de referencia",
  save_metadata: "Guardar metadatos",
  metadata_updated: "Metadatos de la unidad actualizados",
  cataloguer_assigned: "Catalogador asignado",
  cataloguer_unassigned: "Catalogador desasignado",
  reviewer_assigned: "Revisor asignado",
  reviewer_unassigned: "Revisor desasignado",
  status_changed: "Estado cambiado a {{status}}",
  error_name_required: "El nombre y el código de referencia son obligatorios",
  error_invalid_request: "Solicitud inválida",
  error_unknown_action: "Acción desconocida",
  error_transition_failed: "La transición falló",
  delete_eligible: "Esta unidad está sin iniciar y sin asignar. Se puede eliminar.",
  delete_ineligible:
    "Esta unidad no se puede eliminar. Solo se pueden eliminar las unidades sin iniciar y sin asignar. Cambie el estado a \"sin iniciar\" y desasígnela primero.",
  delete_confirm: "¿Eliminar {{name}}? Esto no se puede deshacer.",
  delete_button: "Eliminar unidad",
  force_delete_heading: "Eliminación forzada (superadministrador)",
  force_delete_warning:
    "Esto eliminará permanentemente la unidad y todas las entradas, comentarios, alertas y registros de actividad relacionados. Todo el trabajo de catalogación sobre esta unidad se perderá. Esto no se puede deshacer.",
  force_delete_type_name: "Escriba \"{{name}}\" para confirmar",
  force_delete_confirm:
    "¿Realmente forzar la eliminación de {{name}}? Se destruirá todo el trabajo de catalogación.",
  force_delete_name_mismatch:
    "El nombre escrito no coincide. Escriba \"{{name}}\" exactamente.",
  force_delete_button: "Forzar eliminación de la unidad",
} as const;
