/**
 * Spanish translations — repositories namespace
 *
 * This locale namespace carries the Spanish strings for the
 * repositories admin surface — the list page, the create/edit form,
 * and the destructive actions. Repositories are the top-level
 * institutional anchors the description tree hangs off, so the
 * labels follow ISAAR(CPF)'s phrasing for archival institutions.
 *
 * @version v0.3.0
 */
export default {
  title: "Repositorios",
  add: "Agregar repositorio",
  create_title: "Nuevo repositorio",
  create_submit: "Crear repositorio",
  save: "Guardar cambios",
  edit: "Editar repositorio",
  discard: "Descartar cambios",
  back: "Volver a repositorios",
  delete: "Eliminar repositorio",
  delete_modal_dismiss: "Volver",
  delete_modal_title: "Eliminar repositorio",
  delete_modal_body:
    "¿Está seguro de que desea eliminar {{name}}? Esta acción no se puede deshacer.",
  delete_modal_confirm_label: 'Escriba "{{code}}" para confirmar',
  delete_blocked:
    "No se puede eliminar — {{count}} descripciones vinculadas",
  cascade_warning:
    "Este repositorio tiene {{count}} descripciones vinculadas.",
  cascade_examples: "Ejemplos:",
  empty_title: "No hay repositorios",
  empty_body:
    "Agrega el primer repositorio para empezar a vincular descripciones.",
  search_placeholder: "Buscar por nombre o código...",
  filter_enabled: "Habilitados",
  filter_disabled: "Deshabilitados",
  filter_all: "Todos",
  columns_label: "Columnas",
  badge_enabled: "Habilitado",
  badge_disabled: "Deshabilitado",
  results_count: "Mostrando {{count}} de {{total}} repositorios",
  error_duplicate_code: "Ya existe un repositorio con ese código.",
  error_generic: "Ocurrió un error. Intenta de nuevo.",
  error_required: "Este campo es obligatorio.",
  success_created: "Repositorio creado.",
  success_updated: "Repositorio actualizado.",
  success_deleted: "Repositorio eliminado.",
  section_identity: "Área de identidad",
  section_contact: "Área de contacto",
  section_admin: "Administrativo",
  "field.code": "Código",
  "field.name": "Nombre",
  "field.shortName": "Nombre corto",
  "field.countryCode": "Código de país",
  "field.country": "País",
  "field.city": "Ciudad",
  "field.address": "Dirección",
  "field.website": "Sitio web",
  "field.notes": "Notas",
  "field.rightsText": "Texto de derechos (METS)",
  "field.enabled": "Estado",

  // Linked descriptions
  linked_descriptions: "Descripciones vinculadas",
  no_linked_descriptions: "Sin descripciones vinculadas",
  delete_blocked_inline:
    "No se puede eliminar: este repositorio tiene {{count}} descripciones vinculadas",

  // Display metadata
  display_title_label: "Título de visualización",
  display_title_helper:
    "Reemplaza el nombre en la interfaz pública. Dejar en blanco para usar el nombre.",
  subtitle_label: "Subtítulo",
  subtitle_helper: "Se muestra debajo del título en la interfaz pública",
  hero_image_url_label: "URL de imagen principal",
  hero_image_url_helper:
    "URL de la imagen de encabezado (bucket R2 o URL externa)",

  // Draft/changelog
  commit_note_placeholder: "Nota sobre los cambios (opcional)",
  autosave_saving: "Guardando...",
  autosave_saved: "Borrador guardado",
  conflict_banner:
    "{{name}} tiene cambios sin guardar desde {{time}}.",
  overwrite_confirm:
    "Este registro fue modificado por {{name}} a las {{time}}. ¿Desea sobreescribir?",
  overwrite_button: "Sobreescribir",
  overwrite_cancel: "Cancelar",
} as const;
