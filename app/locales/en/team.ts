/**
 * English translations — team namespace
 *
 * This locale namespace carries the English strings for the
 * collaborative-cataloguing team page — the cross-project member
 * table, the project-assignment dialog, and the load indicators that
 * surface active volumes and entries per cataloguer.
 *
 * @version v0.3.0
 */
export default {
  title: "Team",
  name: "Name",
  email: "Email",
  projects: "Projects",
  active_volumes: "Active volumes",
  active_entries: "Active entries",
  idle: "No active assignments",
  assign_to_project: "Assign to project",
  select_project: "Select project",
  select_role: "Select role",
  assign: "Assign",
  cancel: "Cancel",
  role_lead: "Lead",
  role_cataloguer: "Cataloguer",
  role_reviewer: "Reviewer",
  roles_legend: "Project roles",
  role_lead_description: "Manages the project and team",
  role_cataloguer_description: "Describes records",
  role_reviewer_description: "Reviews and approves work",
  remove_from_project: "Remove",
  confirm_remove: "Remove {{name}} from {{project}}?",
  error_user_not_found: "User not found",
  error_project_not_found: "Project not found",
  error_already_member: "User is already a member of this project",
  error_membership_not_found: "Membership not found",
  success_assigned: "User assigned to project",
  success_removed: "User removed from project",
} as const;
