/**
 * Spanish translations — repositories namespace
 *
 * This locale namespace carries the Spanish strings for the
 * repositories admin surface — the list page, the create/edit form,
 * and the destructive actions. Repositories are the top-level
 * institutional anchors the description tree hangs off, so the
 * labels follow ISAAR(CPF)'s phrasing for archival institutions.
 *
 * @version v0.6.0
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
  country_choose: "Elegir un país",
  country_code_help: "Se completa a partir del país (ISO alfa-3); edítalo si necesitas otro valor.",
  code_help:
    "Un identificador corto, único en este espacio de trabajo: etiqueta el repositorio en las listas y los selectores de registros, y acompaña cada registro exportado. Convención: prefijo del país más las iniciales de las palabras significativas del nombre, p. ej. co-ahrb.",
  code_suggested: "Sugerencia: {{code}}",
  code_use_suggestion: "Usar la sugerencia",
  single_repo_note:
    "Este espacio de trabajo usa un solo repositorio: ya está creado y todos los registros se archivan en él. Para trabajar con varios repositorios hace falta habilitar esa función en la plataforma.",
  short_name_help:
    "El nombre abreviado con que los selectores de registros y el sitio publicado etiquetan el repositorio; si falta, se usa el código y, en su defecto, el nombre completo.",
  website_help: "Se muestra en la página del repositorio en el sitio publicado.",
  notes_help: "Notas internas de este espacio de trabajo: nunca se publican ni se exportan.",
  rights_text_help:
    "La declaración de derechos de los registros digitalizados: se incluye en sus exportaciones METS (el formato estándar para empaquetar objetos digitales) y aparece en el sitio publicado como texto de reproducción de imágenes.",
  enabled_help:
    "Un repositorio deshabilitado desaparece de los selectores de registros, de las confirmaciones de importación y del índice publicado de repositorios; sus registros existentes se conservan.",
  last_repository_note:
    "El único repositorio del espacio de trabajo no se puede eliminar: en él se archivan los registros, incluidos los importados.",
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
