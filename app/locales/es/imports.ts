/**
 * Traducciones al español — namespace imports
 *
 * Este namespace lleva las cadenas en español de toda la superficie del
 * módulo de importaciones en `/admin/imports`: la carga de archivos y la
 * lista de cargas preparadas, la elección de perfiles predefinidos y las
 * superficies para crear, editar y ver perfiles de asignación, el informe
 * de simulación con su tabla de rechazos, la confirmación, la lista de
 * ejecuciones y el detalle de cada una, y la acción de reversión.
 *
 * Español colombiano: tuteo, sin voseo. Las etiquetas, los marcadores de
 * posición y los textos de accesibilidad van en infinitivo; el
 * imperativo con tú se reserva para el texto de ayuda instructivo.
 *
 * @version v0.6.0
 */
export default {
  title: "Importaciones",
  intro:
    "Incorpora a este espacio de trabajo registros de catálogo desde una hoja de cálculo. Cuatro pasos: cargar un CSV, verificarlo con un perfil de asignación, revisar la simulación y confirmar como una importación reversible.",

  busy: {
    dryRun: "Ejecutando la simulación…",
    commit: "Confirmando…",
    upload: "Cargando…",
    revert: "Revirtiendo…",
  },

  nav: {
    back: "Volver a importaciones",
    breadcrumb: "Ruta de navegación",
    uploads: "Cargas",
    profiles: "Perfiles de asignación",
  },

  upload: {
    help: "Exporta tus registros como un CSV en UTF-8. Solo se aceptan archivos en UTF-8; cualquier otro se rechaza con un mensaje claro para que nada se dañe en silencio.",
    fileLabel: "Archivo CSV",
    stagingNote:
      "Tu archivo se carga y queda a la espera de la verificación: nada se modifica en el catálogo hasta el paso de importación. Tanto el archivo que cargas como los informes que la verificación genera a partir de él se conservan dentro de tu espacio de trabajo.",
  },

  uploads: {
    colFile: "Archivo",
    colRows: "Filas",
    colSize: "Tamaño",
    colStatus: "Estado",
    colStaged: "Preparación",
    colActions: "Acciones",
    view: "Ver",
    status: {
      staged: "Preparada",
      committed: "Confirmada",
      discarded: "Descartada",
    },
  },

  profiles: {
    heading: "Perfiles de asignación",
    intro: "Un perfil asigna las columnas de tu hoja de cálculo a los campos de descripción. Los perfiles pertenecen a este espacio de trabajo y llevan versión.",
    empty: "Aún no hay perfiles. Crea uno para asignar tus columnas.",
    sharedEmpty: "No hay perfiles compartidos con este espacio de trabajo.",
    ownHeading: "Este espacio de trabajo",
    sharedHeading: "Compartidos con este espacio de trabajo",
    create: "Crear un perfil",
    edit: "Editar",
    view: "Ver",
    sharedBadge: "Compartido · solo lectura",
    starterBadge: "Predefinido",
    version: "v{{version}}",
  },

  starters: {
    heading: "Empezar desde un formato que ya tienes",
    intro:
      "Si tus registros ya están en un formato de exportación común, empieza desde una asignación predefinida y ajústala. Al elegir una, se abre en el editor para que la revises antes de tu primera importación.",
    use: "Usar este predefinido",
    templateIntro:
      "¿Empiezas un catálogo desde cero? Descarga la plantilla de Fisqua: sus columnas ya coinciden con el estándar de descripción de este espacio de trabajo.",
    templateDownload: "Descargar la plantilla de Fisqua",
    fromScratch: {
      name: "Empezar desde cero",
      desc: "Asigna tus columnas a mano, para un formato que ninguno de los predefinidos cubre.",
      action: "Crear un perfil",
    },
    atomIsadg: {
      name: "CSV de AtoM ISAD(G)",
      desc: "El CSV ISAD(G) que AtoM exporta e importa, columna por columna, con valores separados por barras.",
    },
    agnFuid: {
      name: "FUID del AGN (inventario documental)",
      desc: "El Formato Único de Inventario Documental de Colombia: el formato de control de inventario que conserva la mayoría de los archivos colombianos.",
    },
    eap: {
      name: "Listado de catálogo EAP",
      desc: "La plantilla de listado del Endangered Archives Programme (British Library): descripción ISAD(G) multinivel.",
    },
    meap: {
      name: "Metadatos MEAP (nivel de ítem)",
      desc: "La plantilla del Modern Endangered Archives Program (UCLA): una fila por objeto digitalizado, sin jerarquía.",
    },
    canonical: {
      name: "Plantilla de Fisqua",
      desc: "La plantilla propia de este espacio de trabajo, generada a partir de su estándar de descripción: la vía más rápida para un catálogo nuevo.",
    },
    errors: {
      duplicate_name:
        "Ya tienes un perfil con el nombre de este predefinido. <profile>Cambia el nombre del existente</profile> y vuelve a elegir el predefinido.",
      not_offered:
        "Ese predefinido no está disponible para el estándar de descripción de este espacio de trabajo.",
      invalid_bindings: "No se pudo preparar este predefinido. Inténtalo de nuevo.",
    },
  },

  profileEditor: {
    createHeading: "Crear un perfil de asignación",
    editHeading: "Editar perfil de asignación",
    viewHeading: "Perfil de asignación",
    name: "Nombre del perfil",
    namePlaceholder: "p. ej. CSV de AtoM ISAD(G)",
    sharedToggle: "Compartir con los espacios de trabajo miembros",
    sharedHelp: "Al compartirlo, los espacios de trabajo miembros de esta federación pueden usar este perfil en modo de solo lectura.",
    bindingsHeading: "Asignación de columnas",
    bindingsHelp: "Asigna cada columna de origen, por su nombre de encabezado, a un campo de descripción. Agrega una transformación cuando el valor necesite ajustarse.",
    sourceHeader: "Columna de origen (nombre de encabezado)",
    targetField: "Campo de descripción",
    transform: "Transformación",
    chooseTarget: "Elegir un campo",
    addBinding: "Agregar una asignación",
    removeBinding: "Quitar",
    save: "Guardar perfil",
    delete: "Eliminar perfil",
    deleteConfirm: "¿Eliminar este perfil? Las cargas y las ejecuciones que lo usaron siguen funcionando; solo se elimina el perfil.",
    cancel: "Cancelar",
    readOnlyNote: "Este perfil está compartido por el espacio de trabajo líder de la federación y no se puede editar aquí.",
    availableHeaders: "Columnas detectadas en la carga",
    transformKind: {
      none: "Copia directa",
      direct: "Copia directa",
      defaultWhenBlank: "Valor por defecto si está vacío",
      constant: "Valor constante",
      concatenate: "Concatenar columnas",
      splitRejoin: "Separar y volver a unir",
      date: "Interpretar fecha",
      vocabulary: "Reasignar vocabulario",
      carryForward: "Heredar de la fila anterior",
    },
    errors: {
      invalid_bindings: "La asignación tiene problemas. Corrige los elementos señalados y guarda de nuevo.",
      at_least_one_binding: "Agrega al menos una asignación de columna.",
      duplicate_target: "Dos asignaciones apuntan al mismo campo. Cada campo se puede asignar una sola vez.",
      reference_code_binding_required: "Asigna una columna de origen al código de referencia: las filas se identifican por él.",
      invalid_target: "Un campo asignado no está disponible para el estándar de descripción de este espacio de trabajo.",
      name_required: "Ponle un nombre al perfil.",
      duplicate_name:
        "Ya existe un perfil con ese nombre en este espacio de trabajo. <profile>Abre el perfil existente</profile> o elige otro nombre.",
      not_found: "No se encontró ese perfil.",
    },
  },

  journey: {
    stepsLabel: "Pasos de la importación",
    fileMeta: "{{rows}} filas · {{size}}",
    profileTag: "perfil {{profile}}",
    discard: "Descartar la carga",
    columns: "Columnas coincidentes",
    continue: "Continuar a la verificación",
    continueImport: "Continuar a la importación",
    step: {
      upload: "Carga",
      check: "Verificación",
      dryRun: "Simulación",
      import: "Importación",
    },
    sub: {
      uploadDone: "{{rows}} filas preparadas",
      checkNeedsProfile: "Falta elegir un perfil",
      checkPending: "{{pending}} decisiones pendientes",
      checkPendingDecisions_one: "{{count}} decisión pendiente",
      checkPendingDecisions_other: "{{count}} decisiones pendientes",
      checkBlockingCount_one: "{{count}} bloqueante",
      checkBlockingCount_other: "{{count}} bloqueantes",
      checkReady: "Todas las decisiones tomadas",
      checkClean: "Sin decisiones por tomar",
      dryRunLocked: "Se desbloquea cuando se resuelva cada hallazgo",
      dryRunReady: "Lista para ejecutar",
      dryRunDone: "{{creates}} por crear · {{rejects}} por rechazar",
      importLocked: "Se ejecuta tras una simulación limpia",
      importReady: "Lista para confirmar",
      importDone: "Confirmada",
    },
  },

  landing: {
    uploadContinue: "Cargar y continuar a la verificación",
    rail: {
      upload: "Prepara un CSV en UTF-8 para empezar",
      check: "Hallazgos y decisiones, antes de ejecutar nada",
      dryRun: "Simulación fila por fila",
      import: "Confirmación con un mensaje para el registro permanente",
    },
    inProgressHeading: "Importaciones en curso",
    inProgressEmpty: "No hay importaciones en curso. Prepara un CSV arriba para empezar.",
    rowMeta: "{{rows}} filas · {{size}} · preparada el {{staged}}",
    resume: "Reanudar",
    state: {
      needsProfile: "Falta elegir un perfil",
      checkPending: "Verificación pendiente",
      check: "Verificación: {{made}} / {{total}} decisiones",
      dryRunReady: "Simulación lista",
      importReady: "Importación lista",
    },
  },

  finished: {
    heading: "Finalizadas",
    colFinished: "Finalización",
    colOutcome: "Resultado",
    imported: "Importada",
    viewRun: "Ver la ejecución",
    delete: "Eliminar",
    deleteConfirm: "¿Eliminar esta carga y su archivo preparado?",
    deleteConfirmAction: "Confirmar eliminación",
    deleteCancel: "Cancelar",
    deleteNote:
      "Eliminar borra la carga descartada y su archivo preparado, y no se puede deshacer. Las cargas importadas nunca se pueden eliminar: su archivo es la fuente de registro de la ejecución.",
    errors: {
      notDiscarded: "Solo se pueden eliminar las cargas descartadas.",
    },
  },

  check: {
    heading: "Hallazgos de la verificación",
    chooseProfileHeading: "Elegir un perfil de asignación",
    chooseProfileHelp:
      "La verificación y la simulación clasifican cada fila con este perfil. Elige el que corresponde a tu archivo.",
    useProfile: "Continuar",
    noProfiles:
      "Un perfil de asignación asigna las columnas de tu hoja de cálculo a los campos de descripción: la verificación y la simulación clasifican cada fila con él. Este espacio de trabajo aún no tiene ninguno; crea uno y vuelve para verificar esta carga.",
    ledger:
      "Las filas se identifican por su código de referencia, el identificador único que lleva cada fila. Acepta un hallazgo para importar esas filas tal como están, o corrige el archivo y vuelve a cargarlo.",
    ledgerCount: "{{made}} / {{total}} decisiones tomadas",
    noFindings: "No hay decisiones por tomar: cada fila está lista. Continúa a la simulación.",
    kindDecision: "Decisión",
    kindBlocking: "Bloqueante",
    kindNote: "Nota",
    accepted: "Aceptado",
    readOnly: "Esta carga está cerrada. La verificación se muestra solo como referencia.",
    noRecord: "No hay una verificación registrada para esta carga.",
    accept: "Aceptar: importar tal cual",
    undo: "Deshacer",
    howToFix: "Cómo corregir el archivo",
    fixHint:
      "Completa {{columns}} en esas filas de tu archivo de origen, luego descarta esta carga y <landing>prepara el archivo corregido</landing>.",
    fixHintNoColumns:
      "Completa los valores faltantes en tu archivo de origen, luego descarta esta carga y <landing>prepara el archivo corregido</landing>.",
    decisionTitle: {
      single: "{{code}} ({{level}}) no tiene {{fields}}",
      multiple: "{{count}} filas de nivel {{level}} no tienen {{fields}}",
    },
    decisionBody:
      "Esta asignación exige {{fields}} en el nivel {{level}}, el lugar de la fila en la jerarquía (colección, serie, expediente, ítem), y esas filas los dejan vacíos.",
    cascade: {
      self: "Sin resolver, esas {{count}} filas se rechazarán.",
      descendants: "Sin resolver, sus {{cascade}} filas subordinadas se rechazan con ellas.",
      accepted: "Esas filas se importarán tal como están, contadas como advertencias en la ejecución.",
    },
    blocking: {
      duplicate: "{{count}} filas comparten el código de referencia {{code}}",
      duplicateBody:
        "Las filas {{rows}} comparten {{code}}. Los códigos de referencia deben ser únicos, y el orden del archivo nunca se toma como prueba de cuál es el correcto, así que esas filas se rechazarán. Quita o recodifica los duplicados en tu archivo de origen y <landing>vuelve a cargarlo</landing>, o continúa: quedan fuera de esta importación y aparecen en el CSV de rechazos.",
      missing: "{{count}} filas no tienen código de referencia",
      missingBody:
        "Las filas se identifican por su código de referencia; {{count}} filas lo dejan en blanco y se rechazarán. Agrega un código de referencia a cada una y <landing>vuelve a cargar el archivo</landing>.",
      unresolvable: "{{count}} filas apuntan a una unidad superior que no existe ({{parent}})",
      unresolvableBody:
        "La unidad superior {{parent}} no está ni en el archivo ni en este espacio de trabajo, así que esas filas se rechazarán. <landing>Importa primero la unidad contenedora</landing> y luego <landing>vuelve a cargar los ítems</landing>, o corrige la referencia a la unidad superior en tu archivo de origen.",
      cycle: "{{count}} filas forman un ciclo de jerarquía",
      cycleBody:
        "Esas filas se referencian entre sí en círculo, así que ningún orden puede crearlas. Rompe el ciclo en tu archivo de origen y <landing>vuelve a cargarlo</landing>.",
      invalid: "{{count}} filas tienen valores no válidos",
      invalidBody:
        "Las filas {{rows}} traen un valor que no pasa la validación: demasiado largo, o no válido para su campo. Se rechazarán sin importar lo que decidas arriba; corrige los valores en tu archivo de origen y <landing>vuelve a cargarlo</landing>.",
      rowsMore: "{{shown}} de {{count}} filas mostradas",
    },
    info: {
      unmapped: "{{count}} columnas no están asignadas por este perfil",
      unmappedBody:
        "{{columns}}: quedan sin asignar; sus valores no se importan. No hay nada que hacer, salvo que te sorprenda.",
      unbound: "{{count}} columnas asignadas no están en el archivo",
      unboundBody:
        "{{columns}}: el perfil las asigna, pero el archivo no tiene esas columnas. Sus campos de destino quedan vacíos.",
      warning: "{{count}} valores se ajustaron ({{code}})",
      warningBody:
        "Esas filas traían valores que la asignación reformó o completó por defecto. Se importan con una nota, nunca con un rechazo.",
      warningCode: {
        unknown_vocabulary: "vocabulario no reconocido",
        unparseable_date: "fecha no interpretable",
        uncertain_date: "fecha incierta",
        date_day_clamped: "día ajustado",
        reversed_date_range: "rango de fechas invertido",
        ambiguous_day_month: "día y mes ambiguos",
        carry_forward_no_predecessor: "sin valor que heredar",
        missing_source_column: "columna de origen ausente",
        separator_collision: "colisión de separador",
        accepted_missing_required: "campos faltantes aceptados",
      },
    },
    gate: {
      lockedOne: "La simulación está bloqueada: falta 1 decisión por tomar arriba.",
      lockedMany: "La simulación está bloqueada: faltan {{count}} decisiones por tomar arriba.",
      unlocked: "Todas las decisiones tomadas. La simulación está desbloqueada.",
      trivial: "No hay decisiones por tomar. La simulación está desbloqueada.",
      run: "Continuar a la simulación",
      runLocked: "Ejecutar simulación",
    },
    errors: {
      locked: "Resuelve cada decisión de arriba antes de ejecutar la simulación.",
      runFailed: "No se pudo completar la simulación. Inténtalo de nuevo.",
      notStaged: "Esta carga ya no se puede verificar.",
      noProfile: "Elige primero un perfil de asignación.",
      invalidProfile:
        "La asignación de ese perfil ya no es válida. Ábrelo, corrige los elementos señalados e inténtalo de nuevo.",
      unknownFinding: "Ese hallazgo ya no está presente. Vuelve a cargar la verificación e inténtalo de nuevo.",
    },
    levels: {
      fonds: "fondo",
      subfonds: "subfondo",
      series: "serie",
      subseries: "subserie",
      file: "expediente",
      item: "ítem",
      collection: "colección",
      section: "sección",
      volume: "volumen",
    },
    fieldNames: {
      referenceCode: "código de referencia",
      title: "título",
      descriptionLevel: "nivel de descripción",
      dateExpression: "fecha",
      dateStart: "fecha inicial",
      dateEnd: "fecha final",
      extent: "extensión",
      scopeContent: "alcance y contenido",
      accessConditions: "condiciones de acceso",
      language: "idioma",
      creatorDisplay: "productor",
      repositoryId: "repositorio",
    },
  },

  report: {
    heading: "Informe de simulación",
    runHeading: "Ejecutar una simulación",
    runHelp: "Una simulación clasifica cada fila sin escribir nada. Revisa el informe y luego confirma en un paso aparte.",
    profileLabel: "Perfil de asignación",
    chooseProfile: "Elegir un perfil",
    updateExisting: "Actualizar los registros que ya existen",
    run: "Ejecutar simulación",
    rerun: "Volver a ejecutar la simulación",
    generatedAt: "Generado el {{when}}",
    modeUpsert: "Actualizar existentes: activado; los registros que ya existen se actualizan",
    modeCreateOnly: "Actualizar existentes: desactivado; los registros que ya existen se omiten",
    creates: "Creaciones",
    updates: "Actualizaciones",
    skips: "Omitidos",
    rejects: "Rechazos",
    warnings: "Advertencias",
    rejectsHeading: "Filas rechazadas",
    colRow: "Fila",
    colReference: "Código de referencia",
    colTitle: "Título (textual)",
    colReason: "Motivo",
    downloadRejects: "Descargar CSV de rechazos",
    downloadReport: "Descargar informe",
    commitHeading: "Confirmar",
    commitHelp:
      "Al confirmar, las filas revisadas se escriben en tu catálogo como una ejecución: un acto registrado y reversible, con su propio mensaje y su autor. Los registros existentes se actualizan en su lugar, nunca se eliminan.",
    commitNote: "No se elimina nada: los registros existentes se actualizan en su lugar, nunca se borran.",
    repositoryLabel: "Repositorio para los registros nuevos",
    chooseRepository: "Elegir un repositorio",
    repositoryHelp:
      "Las descripciones nuevas se archivan en este repositorio. Los registros que ya existen conservan el suyo.",
    messageLabel: "Mensaje de la ejecución",
    messagePlaceholder: "p. ej. Inventario de diezmos del ACC, primera importación",
    messageHelp: "Obligatorio. Indica qué es esta importación y por qué: queda registrado con la ejecución.",
    justificationLabel: "Justificación (opcional)",
    attest: "Revisé el informe de simulación: {{writes}} escrituras, {{rejects}} rechazos",
    alreadyCommitted: "Esta carga ya se confirmó.",
    viewRun: "Ver la ejecución",
    noRepositories:
      "Cada registro del catálogo nombra el repositorio que custodia los materiales: el archivo, la biblioteca o la institución a la que pertenecen las descripciones. Este espacio de trabajo aún no tiene ninguno; agrega uno y la importación se lo asignará a cada registro importado.",
    addRepository: "Agregar un repositorio",
    manageRepositories: "Administrar repositorios",
    commit: "Confirmar importación",
    commitBlocked: {
      notStaged: "Esta carga está cerrada.",
      noReport: "<dryRun>Ejecuta primero una simulación</dryRun>.",
      attest: "Marca arriba la confirmación de revisión para habilitar el botón.",
    },
    commitErrors: {
      notStaged: "Esta carga ya no se puede confirmar.",
      noReport: "Ejecuta primero una simulación y luego confirma.",
      messageRequired: "Escribe un mensaje que describa esta importación.",
      noRepository: "Elige un repositorio para los registros nuevos.",
      profileStale:
        "El perfil de asignación cambió desde esta simulación. <dryRun>Ejecuta una simulación nueva</dryRun> antes de confirmar.",
      decisionsPending:
        "La verificación tiene decisiones pendientes. <check>Resuélvelas</check>, <dryRun>ejecuta una simulación nueva</dryRun> y luego confirma.",
      decisionsChanged:
        "Las decisiones cambiaron desde esta simulación. <dryRun>Ejecuta una simulación nueva</dryRun> antes de confirmar.",
      alreadyCommitted: "Esta carga ya se confirmó. Cada carga se confirma una sola vez.",
    },
    warning: {
      parent_change_ignored:
        "El archivo le asigna a este registro una unidad superior distinta; las importaciones nunca reubican registros existentes: se conserva la unidad superior actual.",
    },
    reason: {
      missing_reference_code: "Falta el código de referencia: fila bloqueada",
      duplicate_reference_code: "El código de referencia aparece más de una vez en el archivo",
      unresolvable_parent: "No se pudo resolver la unidad superior",
      parent_rejected: "Su unidad superior fue rechazada",
      parent_cycle: "Las relaciones de jerarquía forman un ciclo",
      value_too_long: "Un valor supera la longitud máxima",
      missing_required_field: "Falta un campo obligatorio",
      invalid_description_level: "Nivel de descripción no reconocido",
      invalid_field: "Un campo no pasó la validación",
    },
    reasonDetail: {
      missing_required_field: "Faltan campos obligatorios: {{fields}}",
      parent_rejected: "Su unidad superior ({{parent}}) fue rechazada",
      duplicate_reference_code: "Código de referencia repetido: también en las filas {{rows}}",
    },
    errors: {
      noProfile: "Elige un perfil de asignación para ejecutar la simulación.",
      invalidProfile: "La asignación de ese perfil ya no es válida. Ábrelo, corrige los elementos señalados e inténtalo de nuevo.",
      runFailed: "No se pudo completar la simulación. Inténtalo de nuevo.",
      notStaged: "Esta carga ya no admite simulaciones.",
    },
  },

  runs: {
    link: "Ejecuciones",
    heading: "Ejecuciones de importación",
    intro:
      "Cada importación confirmada queda registrada aquí como una ejecución reversible, con su mensaje, su autor y sus conteos.",
    empty: "Aún no hay ejecuciones. Confirma una simulación para crear una.",
    colMessage: "Mensaje",
    colKind: "Tipo",
    colStatus: "Estado",
    colCounts: "Conteos",
    colCreated: "Inicio",
    countsSummary:
      "{{created}} creados · {{updated}} actualizados · {{unchanged}} sin cambios · {{skipped}} omitidos · {{rejected}} rechazados",
    revertCountsSummary: "{{reverted}} revertidos · {{kept}} conservados",
    unchanged: "Sin cambios",
    kind: {
      import: "Importación",
      revert: "Reversión",
    },
    status: {
      pending: "Pendiente",
      running: "En curso",
      complete: "Completada",
      error: "Con error",
    },
  },

  runDetail: {
    back: "Volver a las ejecuciones",
    profile: "Perfil de asignación",
    profileDeleted: "Perfil eliminado",
    created: "Inicio",
    step: "Paso: {{step}}",
    starting: "Iniciando…",
    progressLabel: "Progreso de la ejecución",
    errorHeading: "La ejecución falló",
    countsHeading: "Resultados",
    pathCapped:
      "{{capped}} registros superan la profundidad de jerarquía que cubre la caché de rutas. Se importaron completos; solo se omitió la caché interna de rutas.",
    downloadSource: "Descargar CSV de origen",
    downloadReport: "Descargar informe",
    downloadRejects: "Descargar CSV de rechazos",
    acceptedHeading: "Vacíos aceptados",
    acceptedIntro: "Vacíos en campos obligatorios que se importaron a sabiendas, por clase.",
    acceptedItem: "{{count}} filas de nivel {{level}} se importaron sin {{fields}}",
  },

  revert: {
    heading: "Revertir esta ejecución",
    help: "La reversión deshace los cambios de esta ejecución como una ejecución nueva y registrada. Los registros que creó se eliminan; los que actualizó se restauran a sus valores anteriores. Los registros editados después de la ejecución se conservan intactos, nunca se sobrescriben.",
    helpRevertOfRevert: "Revertir una reversión vuelve a aplicar la ejecución que deshizo. Esos cambios regresan como una ejecución nueva y registrada; los registros editados desde entonces se conservan intactos.",
    messageLabel: "Mensaje de la reversión",
    messagePlaceholder: "p. ej. Reversión de la importación de diezmos del ACC: perfil equivocado",
    messageHelp: "Obligatorio. Indica por qué reviertes: queda registrado con la ejecución de reversión.",
    justificationLabel: "Justificación (opcional)",
    confirm: "Entiendo que esto revierte los cambios de la ejecución y conserva los registros editados después",
    submit: "Revertir ejecución",
    note: "No se fuerza nada: los registros editados después de la ejecución se conservan y se reportan, nunca se sobrescriben.",
    revertsLabel: "Revierte:",
    revertedByLabel: "Revertida por:",
    countsHeading: "Resultados de la reversión",
    split: "Revertidos {{reverted}} · conservados {{kept}}",
    deleted: "Eliminados",
    restored: "Restaurados",
    reinserted: "Recreados",
    skippedEdited: "Conservados · editados después",
    skippedForeignChildren: "Conservados · con unidades subordinadas nuevas",
    skippedConflict: "Conservados · código en uso",
    downloadReport: "Descargar informe de reversión",
    errors: {
      revertFailed: "No se pudo iniciar la reversión. Inténtalo de nuevo.",
      notRevertable: "Esta ejecución no se puede revertir.",
      notComplete: "Esta ejecución no ha terminado, así que aún no se puede revertir.",
      alreadyReverted: "Esta ejecución ya fue revertida.",
      messageRequired: "Escribe un mensaje que describa esta reversión.",
    },
  },

  errors: {
    encoding: "El archivo no es UTF-8 válido. Vuelve a exportarlo como UTF-8 y cárgalo de nuevo.",
    empty: "El archivo no tiene filas para importar.",
    unterminatedQuote: "El archivo tiene una comilla sin cerrar y no se puede leer con seguridad. Corrige el CSV y cárgalo de nuevo.",
    duplicateHeaders: "El archivo tiene más de una columna llamada {{headers}}. Cambia el nombre de las columnas duplicadas y cárgalo de nuevo.",
    noFile: "Elige un archivo CSV para cargar.",
    uploadFailed: "No se pudo preparar la carga. Inténtalo de nuevo.",
  },
} as const;
