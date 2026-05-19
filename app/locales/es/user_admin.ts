/**
 * Spanish translations — user_admin namespace
 *
 * This locale namespace carries the Spanish strings for the
 * `/admin/users/*` surface — the system-users breadcrumb, the
 * role-flag labels (superadministrador, gestor de usuarios,
 * administrador de catalogación, catalogador, administrador de
 * registros, usuario del archivo), and the per-row project count
 * column.
 *
 * @version v0.3.0
 */
export default {
  breadcrumb_system_users: "Usuarios del sistema",
  col_projects: "Proyectos",
  no_roles: "Sin roles",
  role_super_admin: "Superadministrador",
  role_user_manager: "Gestor de usuarios",
  role_cataloguing_admin: "Administrador de catalogación",
  role_cataloguer: "Catalogador",
  role_records_admin: "Administrador de registros",
  role_archive_user: "Usuario del archivo",
  section_system: "Sistema",
  section_cataloguing: "Catalogación",
  section_records_management: "Gestión de registros",
  section_project_memberships: "Membresías en proyectos",
  super_admin_description:
    "Acceso total a todas las áreas, incluyendo gestión de usuarios y configuración del sistema",
  user_manager_description:
    "Invitar usuarios, editar perfiles y asignarlos a proyectos",
  cataloguing_admin_description:
    "Gestionar proyectos, miembros del equipo y promover entradas a descripciones",
  cataloguer_description:
    "Puede ser asignado a proyectos de catalogación y acceder al área de catalogación",
  records_admin_description:
    "Gestionar descripciones, entidades, lugares, repositorios y vocabularios",
  archive_user_description: "Acceso de solo lectura a los registros archivísticos",
  self_warning:
    "Esta es su propia cuenta. Los cambios de rol están deshabilitados para evitar una degradación accidental.",
  non_superadmin_notice:
    "Puede gestionar el perfil y las asignaciones de proyectos de este usuario. Los cambios de rol requieren acceso de superadministrador.",
  self_role_badge_tooltip: "No puede cambiar sus propios roles",
  name_label: "Nombre",
  email_label: "Correo",
  last_login_label: "Último acceso",
  created_label: "Creado",
  never: "Nunca",
  save_profile: "Guardar perfil",
  save_roles: "Guardar roles",
  assign_to_project: "+ Asignar a proyecto",
  cancel: "Cancelar",
  project_label: "Proyecto",
  role_label: "Rol",
  select_project: "Seleccionar proyecto...",
  select_role: "Seleccionar rol...",
  role_lead: "Responsable",
  role_reviewer: "Revisor",
  assign: "Asignar",
  remove: "Eliminar",
  remove_confirm: "¿Eliminar de {{project}}?",
  no_memberships: "No es miembro de ningún proyecto",
  error_email_required: "El correo es obligatorio",
  error_email_duplicate: "Otro usuario ya tiene este correo",
  error_invalid_request: "Solicitud inválida",
  error_only_superadmin_roles:
    "Solo los superadministradores pueden cambiar los roles",
  error_cannot_change_own_roles: "No puede cambiar sus propios roles",
  error_already_member: "Ya es miembro de este proyecto",
  error_forbidden: "Prohibido",
  success_profile_updated: "Perfil actualizado",
  success_roles_updated: "Roles actualizados",
  success_assigned: "Asignado al proyecto",
  success_role_updated: "Rol actualizado",
  success_removed: "Eliminado del proyecto",
} as const;
