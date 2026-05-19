/**
 * Spanish translations — pipeline namespace
 *
 * This locale namespace carries the Spanish strings for the
 * cross-project pipeline view — the global heading, the assign-
 * describer affordance, the team search box, and the per-row time
 * indicators ("hoy", "{{count}}d") that the pipeline table renders
 * for each unit in flight.
 *
 * @version v0.3.0
 */
export default {
  title: "Pipeline",
  all_projects: "Todos los proyectos",
  assign_describer: "Asignar descriptor",
  assign_confirm: "Asignar",
  assign_cancel: "Cancelar",
  search_team: "Buscar miembros del equipo...",
  time_days: "{{count}}d",
  time_today: "hoy",
  go_to_promote: "Ir a promover",
  error_load:
    "No se pudo cargar el pipeline. Actualice la p\u00e1gina o intente m\u00e1s tarde.",
  error_assign:
    "No se pudo asignar el descriptor. La entrada pudo haber sido reasignada. Actualice e intente de nuevo.",
  col_unstarted: "Sin iniciar",
  col_segmenting: "Segmentando",
  col_seg_review: "Rev. segmentaci\u00f3n",
  col_ready_to_describe: "Listo para describir",
  col_describing: "Describiendo",
  col_desc_review: "Rev. descripci\u00f3n",
  col_ready_to_promote: "Listo para promover",
  sent_back: "Devuelto",
  stage_segmentation: "Segmentación",
  stage_description: "Descripción",
  empty_segmentation: "Aún no hay unidades compuestas en el flujo de segmentación.",
  empty_description: "Aún no hay entradas en el flujo de descripción.",
} as const;
