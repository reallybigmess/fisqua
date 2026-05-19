/**
 * Spanish translations — qc_flags namespace
 *
 * This locale namespace carries the Spanish strings for the QC-flag
 * dialog cataloguers open from the viewer to report a problem with a
 * scanned image — the problem-type radio group (deteriorada,
 * ilegible, mal ordenada, fuera de alcance, otra) plus their
 * explanatory subtitles.
 *
 * @version v0.4.0
 */
export default {
  dialog: {
    title: "Reportar un problema de calidad",
    subtitle: "¿Qué problema tiene esta imagen?",
    page_label: "img {{position}}",
    problem_type_label: "Tipo de problema",
    problem_type: {
      damaged: "Deteriorada",
      damaged_desc:
        "Físicamente ilegible: rota, manchada o desvanecida hasta la ilegibilidad.",
      repeated: "Repetida",
      repeated_desc: "Duplicado de otra página en el mismo volumen.",
      out_of_order: "Fuera de orden",
      out_of_order_desc: "La página está en la posición equivocada.",
      missing: "Faltante",
      missing_desc: "Vacío en la numeración; falta una página esperada.",
      blank: "En blanco",
      blank_desc: "Página intencionalmente en blanco (informativo).",
      other: "Otro",
      other_desc: "Otra cosa — descríbela abajo.",
    },
    description_label: "Detalles",
    description_placeholder: "Describe lo que ves...",
    submit: "Reportar",
    cancel: "Cancelar",
  },
  badge: {
    open_count_one: "{{count}} marca abierta",
    open_count_other: "{{count}} marcas abiertas",
    no_flags: "Sin marcas abiertas",
    per_page_aria_one:
      "Esta imagen tiene {{count}} marca de control abierta",
    per_page_aria_other:
      "Esta imagen tiene {{count}} marcas de control abiertas",
    raise_button_aria:
      "Reportar un problema de calidad en img {{position}}",
  },
  card: {
    status: {
      open: "Abierta",
      resolved: "Resuelta",
      wontfix: "No se corregirá",
    },
    problem_type: {
      damaged: "Deteriorada",
      repeated: "Repetida",
      out_of_order: "Fuera de orden",
      missing: "Faltante",
      blank: "En blanco",
      other: "Otro",
    },
    reported_by: "Reportada por {{name}}",
    resolved_by: "Resuelta por {{name}}",
    resolution_action: {
      retake_requested: "Se solicitó nueva captura",
      reordered: "Página reordenada",
      marked_duplicate: "Marcada como duplicada",
      ignored: "Ignorada",
      other: "Otro",
    },
    resolve_button: "Resolver",
  },
  feed: {
    raised:
      "reportó un problema de calidad en img {{pageLabel}}",
    resolved:
      "resolvió una marca de calidad en img {{pageLabel}}",
  },
} as const;

// Version: v0.3.1 (2026-04-18) — cleanup
