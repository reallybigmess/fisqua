/**
 * Spanish translations — common namespace
 *
 * This locale namespace carries the cross-cutting Spanish strings
 * every other namespace builds on top of — the app brand name and the
 * shared button vocabulary (Guardar, Cancelar, Crear, Eliminar,
 * Aplicar, Limpiar). i18next loads it as the default namespace, so
 * bare keys like `t("button.save")` resolve here without an explicit
 * prefix.
 *
 * @version v0.3.0
 */
export default {
  app_name: "Fisqua",
  button: {
    save: "Guardar",
    cancel: "Cancelar",
    create: "Crear",
    delete: "Eliminar",
    apply: "Aplicar",
    clear: "Limpiar",
  },
  label: {
    loading: "Cargando...",
    search: "Buscar",
    actions: "Acciones",
    name: "Nombre",
    email: "Correo electrónico",
    role: "Rol",
    status: "Estado",
    none: "Ninguno",
    yes: "Sí",
    no: "No",
    back: "Volver",
    close: "Cerrar",
    confirm: "Confirmar",
    edit: "Editar",
    details: "Detalles",
  },
  domain: {
    document_count_one: "{{count}} documento",
    document_count_other: "{{count}} documentos",
    image_count_one: "{{count}} imagen",
    image_count_other: "{{count}} imágenes",
    volume_count_one: "{{count}} unidad compuesta",
    volume_count_other: "{{count}} uds.",
    volume_count_full_one: "{{count}} unidad compuesta",
    volume_count_full_other: "{{count}} unidades compuestas",
  },
  error: {
    generic_title: "Algo salió mal",
    generic_detail: "Ocurrió un error inesperado.",
    not_found: "No se encontró la página solicitada.",
    try_again: "Intentar de nuevo",
  },
  pagination: {
    previous: "Anterior",
    next: "Siguiente",
    page_of: "Página {{current}} de {{total}}",
  },
} as const;
