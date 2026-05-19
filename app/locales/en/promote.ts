/**
 * English translations — promote namespace
 *
 * This locale namespace carries the English strings for the promote
 * surface — the volume picker and the approved-entries table that
 * lets a superadmin lift entries out of the cataloguing tree into the
 * published archival data model.
 *
 * @version v0.3.0
 */
export default {
  heading: {
    title: "Promote entries",
  },
  volume: {
    heading: "Select a volume",
    empty: "No volumes have approved entries ready for promotion.",
  },
  table: {
    selectAll: "Select all",
    deselectAll: "Deselect all",
    col: {
      title: "Title",
      pages: "Pages",
      refCode: "Reference code",
      status: "Status",
    },
    children: "{{count}} sub-entries",
  },
  refCode: {
    patternLabel: "Reference code pattern",
    prefixPlaceholder: "Prefix (e.g. d)",
    applyPattern: "Apply pattern",
  },
  status: {
    alreadyPromoted: "Already promoted",
  },
  viewer: {
    noManifest: "No manifest available for this volume.",
  },
  action: {
    review: "Review promotion",
    promote: "Promote {{count}} entries",
    back: "Back to selection",
  },
  summary: {
    heading: "Promotion summary",
    col: {
      fields: "Fields mapped",
      parent: "Parent description",
    },
  },
  toast: {
    success: "{{count}} entries promoted successfully.",
  },
  error: {
    noParent:
      "No matching parent description found for volume {{code}}. Import the volume description first.",
    generic:
      "Promotion failed. Please try again or contact an administrator.",
    noSelection: "Select at least one entry to promote.",
    duplicateRefCode: 'Reference code "{{code}}" already exists.',
  },
} as const;
