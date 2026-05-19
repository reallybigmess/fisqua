/**
 * English translations — workflow namespace
 *
 * This locale namespace carries the English strings for the
 * cataloguing workflow state machine — the six status labels
 * (unstarted, in progress, segmented, sent back, reviewed, approved)
 * and the action labels that drive transitions between them.
 *
 * @version v0.3.0
 */
export default {
  status: {
    unstarted: "Unstarted",
    in_progress: "In progress",
    segmented: "Segmented",
    sent_back: "Sent back",
    reviewed: "Reviewed",
    approved: "Approved",
  },
  action: {
    assign: "Assign",
    approve: "Approve",
    send_back: "Send back",
    submit_for_review: "Submit for review",
    accept_corrections: "Accept corrections",
    unassign: "Unassign",
  },
  role: {
    lead: "Lead",
    cataloguer: "Cataloguer",
    reviewer: "Reviewer",
  },
  bulk: {
    selected_one: "{{count}} volume selected",
    selected_other: "{{count}} volumes selected",
  },
  dropdown: {
    cataloguer_placeholder: "Cataloguer...",
    reviewer_placeholder: "Reviewer...",
    unassigned: "Unassigned",
  },
  dialog: {
    confirm_assign: "Assign volume",
    confirm_unassign: "Unassign volume",
    confirm_approve: "Approve volume",
    confirm_send_back: "Send back volume",
    submit_title: "Submit for review",
    submit_body: "Submit <strong>{{volumeName}}</strong> for review? You will not be able to edit until the reviewer returns it.",
    submit_confirm: "Submit for review",
    send_back_title: "Send back for revision",
    send_back_body: "Explain what needs to be corrected in <strong>{{volumeName}}</strong>:",
    send_back_placeholder: "Describe the issues that need correction...",
    send_back_min_chars: "Minimum {{min}} characters ({{current}}/{{min}})",
    send_back_confirm: "Send back",
  },
} as const;
