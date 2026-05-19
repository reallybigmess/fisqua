/**
 * Spanish translations — team namespace
 *
 * This locale namespace carries the Spanish strings for the
 * collaborative-cataloguing team page — the cross-project member
 * table, the project-assignment dialog, and the load indicators that
 * surface active volumes and entries per cataloguer.
 *
 * @version v0.3.0
 */
export default {
  title: "Equipo",
  name: "Nombre",
  email: "Correo",
  projects: "Proyectos",
  active_volumes: "Volúmenes activos",
  active_entries: "Entradas activas",
  idle: "Sin asignaciones activas",
  assign_to_project: "Asignar a proyecto",
  select_project: "Seleccionar proyecto",
  select_role: "Seleccionar rol",
  assign: "Asignar",
  cancel: "Cancelar",
  role_lead: "Responsable",
  role_cataloguer: "Catalogador",
  role_reviewer: "Revisor",
  roles_legend: "Roles del proyecto",
  role_lead_description: "Dirige el proyecto y el equipo",
  role_cataloguer_description: "Describe registros",
  role_reviewer_description: "Revisa y aprueba el trabajo",
  remove_from_project: "Eliminar",
  confirm_remove: "¿Eliminar a {{name}} de {{project}}?",
  error_user_not_found: "Usuario no encontrado",
  error_project_not_found: "Proyecto no encontrado",
  error_already_member: "El usuario ya es miembro de este proyecto",
  error_membership_not_found: "Membresía no encontrada",
  success_assigned: "Usuario asignado al proyecto",
  success_removed: "Usuario eliminado del proyecto",
} as const;
