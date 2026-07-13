/**
 * English translations — authorities namespace
 *
 * Shared chrome for the authorities module's full-page workbenches
 * (merge and split), the ledger-derived status band, and the entity/
 * place list bulk-merge toolbar. Kept in one namespace (rather than
 * duplicated across `entities` and `places`) because every string here
 * is record-type agnostic; the record-type-specific field labels come
 * from the caller's own namespace.
 *
 * @version v0.4.3
 */
export default {
  // Merge workbench — page head
  mergeEyebrowEntities: "Authorities · Entities",
  mergeEyebrowPlaces: "Authorities · Places",
  mergeHeading: "Merge authority record",
  mergeIntro:
    "Combine a duplicate record into a surviving record. Linked descriptions move to the survivor; the merged-away record keeps a redirect.",

  // Merge — record pair
  mergeThisRecord: "This record · will be merged away",
  mergeSurvivor: "Survivor · will be kept",
  mergeSwapDirection: "swap direction",
  mergeSelectSurvivor: "Select a surviving record to compare",

  // Merge — survivor typeahead
  mergeSearchPlaceholder: "Search for the surviving record…",
  mergeSearchLinks: "{{count}} links",

  // Merge — comparison table
  mergeColField: "Field",
  mergeColThis: "This record",
  mergeColSurvivor: "Survivor",

  // Merge — linked descriptions
  mergeLinksHeading: "Linked descriptions",
  mergeLinksShowing:
    "Showing {{shown}} of {{total}} · all move to survivor unless unchecked",
  mergeLinksWarning:
    "{{count}} descriptions will stay on a merged-away record. They keep the old redirect and will not appear under the survivor.",
  mergeDestSurvivor: "Survivor",
  mergeDestStays: "Stays",
  mergeLoadMore: "Load {{count}} more descriptions",

  // Linked-description context cards (both merge sides + split)
  ctxSurvivorHeading: "Survivor's linked descriptions",
  ctxSurvivorKept: "These stay on the survivor.",
  ctxMergedHeading: "This record's linked descriptions",
  ctxShowing: "Showing {{shown}} of {{cards}} · {{links}} links",
  ctxAndMore: "… and {{count}} more",
  ctxNoLinks: "No linked descriptions.",
  ctxAsRecorded: "as recorded:",
  ctxSourceOcr: "OCR text",

  // Merge — fold names
  mergeFoldNames: "Add this record's name(s) to the survivor's name variants",
  mergeFoldNamesHelper:
    "Off by default. When on, the merged-away record's preferred name and variants are added to the survivor.",

  // Merge — bottom bar
  reasonLabel: "Reason",
  reasonRequired: "· required",
  reasonPlaceholder: "Why is this being done? (recorded in the ledger)",
  mergeSummary: "{{moved}} links move · {{stay}} stay",
  mergeConfirm: "Merge into {{name}}",
  mergeConfirmGeneric: "Merge record",

  // Merge — conflict state
  conflictTitle: "This record changed since you opened it",
  conflictBody:
    "It was edited on {{time}}. Reload to see the current version, or merge anyway to proceed with what you have.",
  conflictReload: "Reload",
  conflictProceed: "Merge anyway",
  conflictProceedSplit: "Split anyway",

  // Split workbench — page head
  splitHeading: "Split authority record",
  splitIntro:
    "Divide one conflated record into the original and a new record. Assign each field, then divide the linked descriptions.",

  // Split — record banner
  splitBeingSplit: "Splitting this record",
  splitLinkedCount: "{{count}} linked descriptions",

  // Split — assignment table
  splitColField: "Field",
  splitColGoesTo: "Goes to — Original · Both · New record",
  splitOriginal: "Original",
  splitBoth: "Both",
  splitNew: "New record",
  splitUnassigned: "Unassigned",
  splitNameOriginal: "Original record name",
  splitNameNew: "New record name",
  splitNamesIdentical:
    "Both names are identical — the new record needs a distinct name.",

  // Split — divide descriptions
  splitDivideHeading: "Divide linked descriptions",
  splitDivideNote: "Checked descriptions move to the new record",
  splitDestNew: "New record",
  splitDestOriginal: "Original",

  // Split — bottom bar
  splitConfirm: "Split record",
  splitSummaryOriginal: "Original keeps {{summary}}",
  splitSummaryNew: "New record gets {{summary}}",
  splitBlockerUnassigned: "{{count}} field rows are unassigned.",
  splitBlockerNames: "The new record needs a name distinct from the original.",
  splitBlockerReason: "Add a reason to enable confirm.",
  splitDescriptionsUnit: "{{count}} descriptions",

  // Status band
  bandMerged: "Merged into {{survivor}} on {{date}} by {{user}}",
  bandSplit: "Split into {{records}} on {{date}} by {{user}}",
  bandSplitFrom: "Split from {{parent}} on {{date}} by {{user}}",
  bandViewSurvivor: "View survivor",
  bandViewRecords: "View records",
  bandOpenLedger: "Open ledger entry",
  bandRedirectedCount: "0 (redirected)",
  bandUnknownUser: "an unknown user",

  // Bulk-merge toolbar (list surfaces)
  bulkSelected: "{{count}} selected",
  bulkClear: "Clear",
  bulkMerge: "Merge…",
  bulkHintPickTwo: "Select exactly two records to merge.",

  // Show-merged toggle + merged row indicator
  showMerged: "Show merged",
  mergedPill: "merged",
  mergedArrow: "→ {{survivor}}",

  // Generic errors
  errorReasonRequired: "A reason is required.",
  errorSurvivorRequired: "Select a surviving record.",
  errorNamesIdentical: "The two records need distinct names.",
  errorUnassigned: "Every field must be assigned before splitting.",
  errorGeneric: "Something went wrong. Try again.",
  // Possible-duplicates worklist
  dupHeading: "Possible duplicates",
  dupIntro:
    "Work through candidate duplicate pairs: merge true duplicates, or dismiss false matches with a reason recorded in the ledger.",
  dupCountLine: "candidate pairs · sorted by match strength",
  dupSignalName: "normalized name",
  dupSignalDates: "overlapping dates",
  dupSignalWikidata: "shared Wikidata",
  dupSignalTgn: "shared Getty TGN",
  dupNotDuplicate: "Not a duplicate",
  dupCompareMerge: "Compare & merge",
  dupModalTitle: "Mark as not a duplicate",
  dupModalBody:
    "Record that {{a}} and {{b}} are not the same. The pair will not resurface in this list.",
  dupModalCancel: "Cancel",
  dupDismissedBanner:
    "Pair marked 'not a duplicate' — recorded in the ledger. It will not resurface unless the records change.",
  dupEmptyHeading: "No duplicate candidates",
  dupEmptyBody:
    "Every flagged pair has been merged or dismissed. New candidates appear here as records are added or edited.",
  dupLinksMeta: "{{count}} links",

  // Operation history
  histHeading: "Operation history",
  histBackToRecord: "Back to record",
  histEmpty: "No operations recorded for this record.",
  histMergedInto: "Merged into {{name}}",
  histMergedFrom: "Merged from {{name}}",
  histSplitInto: "Split into {{name}}",
  histSplitFrom: "Split from {{name}}",
  histSeparate: "Marked not a duplicate of {{name}}",
  histDeleted: "Record deleted",
  histResolved: "Creation provenance recorded",
  histUnknownRecord: "an unknown record",
  histDetailMoved: "{{count}} links moved",
  histDetailDropped: "{{count}} conflicting links captured",
  histDetailLeft: "{{count}} links left behind",
  dupShowing: "Showing {{shown}} of {{total}}",
  dupTabEntities: "Entities",
  dupTabPlaces: "Places",
  histShowingLatest: "Showing the latest {{shown}} of {{total}} operations",

  // Linked-descriptions worklist (detail-page redesign)
  wlSearchPlaceholder: "Search titles and codes…",
  wlAll: "All",
  wlShowing: "Showing {{shown}} of {{total}} linked descriptions",
  wlSortAria: "Sort",
  wlSortDate: "Date (newest first)",
  wlSortTitle: "Title",
  wlSortCode: "Reference code",
  wlSizeAria: "Results per page",
  wlPrev: "Previous",
  wlNext: "Next",
  wlPage: "Page {{page}} of {{pages}}",
  wlNoMatches: "No linked descriptions match the current filters.",
  // Click-to-unfold context card
  wlToggleCard: "Show or hide linked description details",
  wlCardLoading: "Loading details…",
  wlCardError: "These details could not be loaded.",
  // Filter pill group labels (round 3)
  wlFilterByRole: "Filter by role:",
  wlFilterByRepo: "Filter by repository:",
  // Unfold snippet — source tiers, expansion, and multi-match steppers
  wlSnippetScope: "Scope and content",
  wlSnippetScopeHead: "(no name match — showing the opening)",
  wlSnippetOcr: "OCR text",
  wlShowMore: "Show more",
  wlShowLess: "Show less",
  wlShowAll: "Show all",
  // Only rendered when there is more than one match, so never "1 match".
  wlMatchCount: "{{count}} matches",
  wlPrevMatch: "Previous match",
  wlNextMatch: "Next match",
  wlOcrWindowCaption:
    "Window from a {{kb}} KB transcript — full text on the description.",
  wlOcrWideCaption: "Wider window (capped) — shipped with the card.",
  wlOcrFullCaption: "Full transcript ({{kb}} KB) — fetched on demand.",
  wlOcrLoading: "Loading transcript…",
} as const;
