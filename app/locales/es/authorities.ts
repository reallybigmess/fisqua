/**
 * Spanish translations — authorities namespace
 *
 * Latin American / Colombian Spanish for the authorities module's
 * full-page merge and split workbenches, the ledger-derived status
 * band, and the list bulk-merge toolbar. Terminology tracks the
 * existing `entities`/`places` namespaces: combinar (merge), dividir
 * (split), vínculos (links).
 *
 * @version v0.4.3
 */
export default {
  // Merge workbench — page head
  mergeEyebrowEntities: "Autoridades · Entidades",
  mergeEyebrowPlaces: "Autoridades · Lugares",
  mergeHeading: "Combinar registro de autoridad",
  mergeIntro:
    "Combina un registro duplicado con el registro que se conserva. Los vínculos con descripciones pasan al registro que se conserva; el registro combinado queda como redirección.",

  // Merge — record pair
  mergeThisRecord: "Este registro · se combinará",
  mergeSurvivor: "Registro que se conserva",
  mergeSwapDirection: "invertir el sentido",
  mergeSelectSurvivor: "Selecciona el registro que se conserva para comparar",

  // Merge — survivor typeahead
  mergeSearchPlaceholder: "Busca el registro que se conserva…",
  mergeSearchLinks: "{{count}} vínculos",

  // Merge — comparison table
  mergeColField: "Campo",
  mergeColThis: "Este registro",
  mergeColSurvivor: "Se conserva",

  // Merge — linked descriptions
  mergeLinksHeading: "Descripciones vinculadas",
  mergeLinksShowing:
    "Se muestran {{shown}} de {{total}} · todas pasan al registro que se conserva salvo que las desmarques",
  mergeLinksWarning:
    "{{count}} descripciones quedarán en un registro combinado. Conservan la redirección anterior y no aparecerán bajo el registro que se conserva.",
  mergeDestSurvivor: "Se conserva",
  mergeDestStays: "Se queda",
  mergeLoadMore: "Cargar {{count}} descripciones más",

  // Linked-description context cards (both merge sides + split)
  ctxSurvivorHeading: "Descripciones vinculadas del registro que se conserva",
  ctxSurvivorKept: "Estas permanecen en el registro que se conserva.",
  ctxMergedHeading: "Descripciones vinculadas de este registro",
  ctxShowing: "Se muestran {{shown}} de {{cards}} · {{links}} vínculos",
  ctxAndMore: "… y {{count}} más",
  ctxNoLinks: "No hay descripciones vinculadas.",
  ctxAsRecorded: "tal como se registró:",
  ctxSourceOcr: "Texto OCR",

  // Merge — fold names
  mergeFoldNames:
    "Agregar el nombre (o nombres) de este registro a las variantes del registro que se conserva",
  mergeFoldNamesHelper:
    "Desactivado por defecto. Al activarlo, el nombre preferido y las variantes del registro combinado se agregan al registro que se conserva.",

  // Merge — bottom bar
  reasonLabel: "Motivo",
  reasonRequired: "· obligatorio",
  reasonPlaceholder: "¿Por qué se hace esto? (queda registrado en el historial)",
  mergeSummary: "{{moved}} vínculos pasan · {{stay}} se quedan",
  mergeConfirm: "Combinar con {{name}}",
  mergeConfirmGeneric: "Combinar registro",

  // Merge — conflict state
  conflictTitle: "Este registro cambió desde que lo abriste",
  conflictBody:
    "Se editó el {{time}}. Vuelve a cargar para ver la versión actual, o combina de todos modos con lo que tienes.",
  conflictReload: "Volver a cargar",
  conflictProceed: "Combinar de todos modos",
  conflictProceedSplit: "Dividir de todos modos",

  // Split workbench — page head
  splitHeading: "Dividir registro de autoridad",
  splitIntro:
    "Divide un registro que mezcla varios en el original y un registro nuevo. Asigna cada campo y luego reparte las descripciones vinculadas.",

  // Split — record banner
  splitBeingSplit: "Dividiendo este registro",
  splitLinkedCount: "{{count}} descripciones vinculadas",

  // Split — assignment table
  splitColField: "Campo",
  splitColGoesTo: "Va a — Original · Ambos · Registro nuevo",
  splitOriginal: "Original",
  splitBoth: "Ambos",
  splitNew: "Registro nuevo",
  splitUnassigned: "Sin asignar",
  splitNameOriginal: "Nombre del registro original",
  splitNameNew: "Nombre del registro nuevo",
  splitNamesIdentical:
    "Los dos nombres son idénticos: el registro nuevo necesita un nombre distinto.",

  // Split — divide descriptions
  splitDivideHeading: "Repartir las descripciones vinculadas",
  splitDivideNote: "Las descripciones marcadas pasan al registro nuevo",
  splitDestNew: "Registro nuevo",
  splitDestOriginal: "Original",

  // Split — bottom bar
  splitConfirm: "Dividir registro",
  splitSummaryOriginal: "El original conserva {{summary}}",
  splitSummaryNew: "El registro nuevo recibe {{summary}}",
  splitBlockerUnassigned: "Hay {{count}} campos sin asignar.",
  splitBlockerNames: "El registro nuevo necesita un nombre distinto al del original.",
  splitBlockerReason: "Agrega un motivo para poder confirmar.",
  splitDescriptionsUnit: "{{count}} descripciones",

  // Status band
  bandMerged: "Combinado con {{survivor}} el {{date}} por {{user}}",
  bandSplit: "Dividido en {{records}} el {{date}} por {{user}}",
  bandSplitFrom: "Dividido a partir de {{parent}} el {{date}} por {{user}}",
  bandViewSurvivor: "Ver registro que se conserva",
  bandViewRecords: "Ver registros",
  bandOpenLedger: "Abrir entrada del historial",
  bandRedirectedCount: "0 (redirigidas)",
  bandUnknownUser: "un usuario desconocido",

  // Bulk-merge toolbar (list surfaces)
  bulkSelected: "{{count}} seleccionados",
  bulkClear: "Quitar selección",
  bulkMerge: "Combinar…",
  bulkHintPickTwo: "Selecciona exactamente dos registros para combinar.",

  // Show-merged toggle + merged row indicator
  showMerged: "Mostrar combinados",
  mergedPill: "combinado",
  mergedArrow: "→ {{survivor}}",

  // Generic errors
  errorReasonRequired: "El motivo es obligatorio.",
  errorSurvivorRequired: "Selecciona el registro que se conserva.",
  errorNamesIdentical: "Los dos registros necesitan nombres distintos.",
  errorUnassigned: "Debes asignar cada campo antes de dividir.",
  errorGeneric: "Algo salió mal. Inténtalo de nuevo.",
  // Possible-duplicates worklist
  dupHeading: "Posibles duplicados",
  dupIntro:
    "Revisa las parejas candidatas a duplicados: combina los duplicados reales o descarta las coincidencias falsas dejando el motivo en el historial.",
  dupCountLine: "parejas candidatas · ordenadas de mayor a menor coincidencia",
  dupSignalName: "nombre normalizado",
  dupSignalDates: "fechas que se superponen",
  dupSignalWikidata: "Wikidata compartido",
  dupSignalTgn: "TGN de Getty compartido",
  dupNotDuplicate: "No es un duplicado",
  dupCompareMerge: "Comparar y combinar",
  dupModalTitle: "Marcar como no duplicado",
  dupModalBody:
    "Registra que {{a}} y {{b}} no son el mismo registro. La pareja no volverá a aparecer en esta lista.",
  dupModalCancel: "Cancelar",
  dupDismissedBanner:
    "La pareja se marcó como 'no es un duplicado' y quedó registrada en el historial. No volverá a aparecer a menos que los registros cambien.",
  dupEmptyHeading: "No hay candidatos a duplicados",
  dupEmptyBody:
    "Todas las parejas señaladas se combinaron o se descartaron. Los nuevos candidatos aparecerán aquí a medida que se agreguen o editen registros.",
  dupLinksMeta: "{{count}} vínculos",

  // Operation history
  histHeading: "Historial de operaciones",
  histBackToRecord: "Volver al registro",
  histEmpty: "No hay operaciones registradas para este registro.",
  histMergedInto: "Combinado con {{name}}",
  histMergedFrom: "Se combinó {{name}} con este registro",
  histSplitInto: "Dividido en {{name}}",
  histSplitFrom: "Dividido a partir de {{name}}",
  histSeparate: "Marcado como no duplicado de {{name}}",
  histDeleted: "Registro eliminado",
  histResolved: "Procedencia de creación registrada",
  histUnknownRecord: "un registro desconocido",
  histDetailMoved: "{{count}} vínculos reasignados",
  histDetailDropped: "{{count}} vínculos en conflicto registrados",
  histDetailLeft: "{{count}} vínculos se quedaron",
  dupShowing: "Se muestran {{shown}} de {{total}}",
  dupTabEntities: "Entidades",
  dupTabPlaces: "Lugares",
  histShowingLatest: "Se muestran las {{shown}} operaciones más recientes de {{total}}",

  // Lista de trabajo de descripciones vinculadas (rediseño de la página de detalle)
  wlSearchPlaceholder: "Buscar títulos y códigos…",
  wlAll: "Todas",
  wlShowing: "Mostrando {{shown}} de {{total}} descripciones vinculadas",
  wlSortAria: "Ordenar",
  wlSortDate: "Fecha (más recientes primero)",
  wlSortTitle: "Título",
  wlSortCode: "Código de referencia",
  wlSizeAria: "Resultados por página",
  wlPrev: "Anterior",
  wlNext: "Siguiente",
  wlPage: "Página {{page}} de {{pages}}",
  wlNoMatches: "Ninguna descripción vinculada coincide con los filtros actuales.",
  // Tarjeta de contexto que se despliega al hacer clic
  wlToggleCard: "Mostrar u ocultar los detalles de la descripción vinculada",
  wlCardLoading: "Cargando detalles…",
  wlCardError: "No se pudieron cargar estos detalles.",
  // Etiquetas de los grupos de filtros (ronda 3)
  wlFilterByRole: "Filtrar por rol:",
  wlFilterByRepo: "Filtrar por repositorio:",
  // Fragmento desplegable: origen, ampliación y navegación entre coincidencias
  wlSnippetScope: "Alcance y contenido",
  wlSnippetScopeHead: "(sin coincidencia del nombre; se muestra el inicio)",
  wlSnippetOcr: "Texto OCR",
  wlShowMore: "Ver más",
  wlShowLess: "Ver menos",
  wlShowAll: "Ver todo",
  // Solo aparece cuando hay más de una coincidencia, nunca "1 coincidencia".
  wlMatchCount: "{{count}} coincidencias",
  wlPrevMatch: "Coincidencia anterior",
  wlNextMatch: "Coincidencia siguiente",
  wlOcrWindowCaption:
    "Fragmento de una transcripción de {{kb}} KB; el texto completo está en la descripción.",
  wlOcrWideCaption: "Fragmento más amplio (limitado), incluido en la tarjeta.",
  wlOcrFullCaption: "Transcripción completa ({{kb}} KB), cargada al momento.",
  wlOcrLoading: "Cargando la transcripción…",
} as const;
