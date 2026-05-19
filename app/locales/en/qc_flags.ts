/**
 * English translations — qc_flags namespace
 *
 * This locale namespace carries the English strings for the QC-flag
 * dialog cataloguers open from the viewer to report a problem with a
 * scanned image — the problem-type radio group (damaged, illegible,
 * misordered, out-of-scope, other) plus their explanatory subtitles.
 *
 * @version v0.4.0
 */
export default {
  dialog: {
    title: "Report a QC issue",
    subtitle: "What's wrong with this image?",
    page_label: "img {{position}}",
    problem_type_label: "Problem type",
    problem_type: {
      damaged: "Damaged",
      damaged_desc:
        "Physically unreadable: torn, stained, or faded to illegibility.",
      repeated: "Repeated",
      repeated_desc: "Duplicate of another page in the same volume.",
      out_of_order: "Out of order",
      out_of_order_desc: "Page is in the wrong position.",
      missing: "Missing",
      missing_desc: "Gap in numbering; an expected page is not there.",
      blank: "Blank",
      blank_desc: "Intentionally blank page (informational).",
      other: "Other",
      other_desc: "Something else — describe it below.",
    },
    description_label: "Details",
    description_placeholder: "Describe what you see...",
    submit: "Report",
    cancel: "Cancel",
  },
  badge: {
    open_count_one: "{{count}} open flag",
    open_count_other: "{{count}} open flags",
    no_flags: "No open flags",
    per_page_aria_one: "This image has {{count}} open QC flag",
    per_page_aria_other: "This image has {{count}} open QC flags",
    raise_button_aria: "Report a QC issue on img {{position}}",
  },
  card: {
    status: {
      open: "Open",
      resolved: "Resolved",
      wontfix: "Won't fix",
    },
    problem_type: {
      damaged: "Damaged",
      repeated: "Repeated",
      out_of_order: "Out of order",
      missing: "Missing",
      blank: "Blank",
      other: "Other",
    },
    reported_by: "Reported by {{name}}",
    resolved_by: "Resolved by {{name}}",
    resolution_action: {
      retake_requested: "Retake requested",
      reordered: "Page reordered",
      marked_duplicate: "Marked as duplicate",
      ignored: "Ignored",
      other: "Other",
    },
    resolve_button: "Resolve",
  },
  feed: {
    raised: "reported a QC issue on img {{pageLabel}}",
    resolved: "resolved a QC flag on img {{pageLabel}}",
  },
} as const;

// Version: v0.3.1 (2026-04-18) — cleanup
