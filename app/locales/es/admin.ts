/**
 * Spanish translations — admin namespace
 *
 * This locale namespace carries the Spanish strings for the shared
 * admin chrome — the back-office heading, the top-level user and
 * project sections, and the all/archived project pickers the admin
 * landing page uses.
 *
 * @version v0.3.0
 */
export default {
  heading: {
    admin: "Administración",
    users: "Usuarios",
    projects: "Proyectos",
    all_users: "Todos los usuarios",
    create_user: "Crear usuario",
    all_projects: "Todos los proyectos",
    archived_projects: "Proyectos archivados",
  },
  cataloguing_projects: {
    title: "Proyectos de catalogación",
  },
  cataloguing_users: {
    title: "Usuarios de catalogación",
  },
  tab: {
    users: "Usuarios",
    projects: "Proyectos",
    publish: "Publicar",
    promote: "Promover",
  },
  table: {
    name: "Nombre",
    email: "Correo electrónico",
    role: "Rol",
    admin: "Administrador",
    admin_status: "Admin",
    user: "Usuario",
    last_active: "Última actividad",
    projects: "Proyectos",
    created: "Creado",
    archived: "Archivado",
    lead: "Coordinador(es)",
    members: "Miembros",
    project: "Proyecto",
    actions: "Acciones",
    description: "Descripción",
    volumes: "Volúmenes",
  },
  action: {
    add_user: "Agregar usuario",
    create_user: "Crear usuario",
    new_user: "Nuevo usuario",
    edit_user: "Editar usuario",
    edit: "Editar",
    delete: "Eliminar",
    delete_user: "Eliminar usuario",
    cancel: "Cancelar",
    change_role: "Cambiar rol",
    archive: "Archivar",
    restore: "Restaurar",
    show_active: "Ver activos",
    show_archived: "Ver archivados",
    new_project: "Nuevo proyecto",
    open_project: "Abrir proyecto",
    manage_volumes: "Gestionar unidades compuestas",
  },
  empty: {
    no_users: "Aún no hay usuarios.",
    no_projects: "Aún no hay proyectos. Crea uno para empezar.",
    no_volumes: "Aún no hay unidades compuestas. Abre el proyecto para agregar.",
    no_archived: "No hay proyectos archivados.",
  },
  error: {
    self_admin: "No puedes cambiar tu propio estado de administrador.",
    user_not_found: "Usuario no encontrado.",
    invalid_email: "Ingresa una dirección de correo válida.",
    duplicate_email: "Ya existe un usuario con este correo.",
    user_created: "Usuario {{email}} creado.",
    user_invited: "Invitación enviada a {{email}}.",
    invite_email_failed: "No se pudo enviar el correo de invitación. Inténtalo de nuevo.",
    admin_toggled_on: "{{email}} ahora es administrador.",
    admin_toggled_off: "{{email}} ya no es administrador.",
    missing_project_id: "Falta el ID del proyecto.",
    project_archived: "Proyecto archivado.",
    project_restored: "Proyecto restaurado.",
    project_created: "Proyecto creado.",
    project_updated: "Proyecto actualizado.",
    project_deleted: "Proyecto eliminado.",
    invalid_name: "El nombre debe tener entre 3 y 100 caracteres.",
    unknown_action: "Acción desconocida.",
    delete_confirm: "Eliminar permanentemente \"{{name}}\" y todos sus datos? Esta acción no se puede deshacer.",
    delete_confirm_type: "Escribe \"{{name}}\" para confirmar la eliminación. Esta acción no se puede deshacer.",
  },
  pagination: {
    showing: "Mostrando {{start}}-{{end}} de {{total}} usuarios",
    previous: "Anterior",
    next: "Siguiente",
  },
  filter: {
    all: "Todos",
    admin: "Administrador",
    lead: "Líder",
    reviewer: "Revisor",
    cataloguer: "Catalogador",
  },
  confirm: {
    delete_user: "¿Está seguro de que desea eliminar a {{name}}? Esta acción no se puede deshacer.",
  },
  placeholder: {
    email: "usuario@ejemplo.com",
    select_user: "Seleccionar usuario\u2026",
    no_users_available: "Todos los usuarios ya fueron agregados",
  },
} as const;
