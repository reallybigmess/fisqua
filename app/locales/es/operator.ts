/**
 * Traducciones al español — namespace operator
 *
 * This locale namespace carries las cadenas para la superficie del
 * operador: navegación de la barra superior, lista de inquilinos,
 * formulario de creación, página de detalle del inquilino, el banner
 * de suplantación que se renderiza en los subdominios durante una
 * sesión de "ingresar como", y un conjunto pequeño de errores
 * genéricos del operador.
 *
 * Español colombiano: tuteo, sin voseo. Las formas verbales válidas
 * son `tú prefieres / quieres / sabes / eres / tienes`. NUNCA usar
 * `preferís / querés / sabés / sos / tenés`.
 *
 * @version v0.6.0
 */
export default {
  brand: "Fisqua Operador",
  nav: {
    tenants: "Inquilinos",
    logout: "Cerrar sesión",
    end_impersonation: "Salir de la suplantación",
  },
  tenants_list: {
    page_title: "Inquilinos",
    new_tenant_button: "Nuevo inquilino",
    columns: {
      slug: "Identificador",
      name: "Nombre",
      kind: "Tipo",
      descriptive_standard: "Estándar",
      capabilities: "Capacidades",
      disabled: "Desactivado",
      actions: "Acciones",
    },
    badges: {
      platform: "[plataforma]",
      disabled: "Desactivado",
    },
    capabilities: {
      crowdsourcing: "Colaboración abierta",
      vocabulary_hub: "Centro de vocabularios",
      publish_pipeline: "Canal de publicación",
      multi_repository: "Multi-repositorio",
      authorities: "Autoridades",
      imports: "Importaciones",
    },
    view_link: "Ver",
    empty_state: "Aún no hay inquilinos.",
  },
  // Cadenas de creación y detalle del inquilino.
  tenant_new: {
    page_title: "Crear inquilino",
    fields: {
      slug: "Identificador",
      slug_help:
        "Letras minúsculas, dígitos y guiones. Reservados: platform, www, api, admin, app.",
      name: "Nombre visible",
      descriptive_standard: "Estándar descriptivo",
      capabilities_legend: "Capacidades",
      quota_storage_bytes: "Cuota de almacenamiento (bytes)",
      quota_storage_help: "Opcional. Déjalo en blanco para no limitarlo.",
      bootstrap_email: "Correo del primer superadministrador",
      bootstrap_email_help:
        "Le enviaremos a esta persona un enlace mágico para iniciar sesión.",
    },
    submit: "Crear inquilino e invitar al superadministrador",
    errors: {
      slug_taken: "Este identificador ya está en uso.",
      slug_reserved: "Este identificador está reservado.",
      slug_invalid:
        "Identificador no válido. Usa letras minúsculas, dígitos y guiones.",
      bootstrap_email_invalid: "Ingresa una dirección de correo válida.",
    },
  },
  tenant_detail: {
    page_title: "Inquilino: {{name}}",
    sections: {
      overview: "Resumen",
      capabilities: "Capacidades",
      impersonate: "Ingresar como",
      danger_zone: "Zona de riesgo",
    },
    overview: {
      slug: "Identificador",
      kind: "Tipo",
      descriptive_standard: "Estándar descriptivo",
      created_at: "Creado",
      disabled_at: "Desactivado el",
    },
    capabilities_form: {
      submit: "Guardar capacidades",
      success: "Capacidades guardadas.",
    },
    impersonate_form: {
      role_legend: "¿Con cuál rol quieres iniciar sesión en este inquilino?",
      reason_label: "Motivo (opcional)",
      reason_help: "Queda registrado en la bitácora de auditoría.",
      submit: "Ingresar como {{role}}",
    },
    soft_disable: {
      title: "Desactivar este inquilino",
      help:
        "El subdominio del inquilino devuelve 404. Las rutas del operador siguen viéndolo. Reactívalo limpiando la marca de desactivación.",
      submit: "Desactivar",
      reenable: "Reactivar",
      confirm_disable:
        "Confirmar: ¿desactivar {{slug}}? Escribe el identificador para confirmar.",
    },
  },
  banner: {
    impersonating: "Suplantando {{role}} en {{tenant}}",
    end_button: "Salir de la suplantación",
  },
  errors: {
    not_operator: "No eres un operador de la instancia.",
    no_session: "Inicia sesión para continuar.",
  },
} as const;

// @version v0.4.0
