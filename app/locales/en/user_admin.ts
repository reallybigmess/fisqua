/**
 * English translations — user_admin namespace
 *
 * This locale namespace carries the English strings for the
 * `/admin/users/*` surface — the system-users breadcrumb, the
 * role-flag labels (super admin, user manager, cataloguing admin,
 * cataloguer, records admin, archive user), and the per-row project
 * count column.
 *
 * @version v0.3.0
 */
export default {
  breadcrumb_system_users: "System users",
  col_projects: "Projects",
  no_roles: "No roles",
  role_super_admin: "Super admin",
  role_user_manager: "User manager",
  role_cataloguing_admin: "Cataloguing admin",
  role_cataloguer: "Cataloguer",
  role_records_admin: "Records admin",
  role_archive_user: "Archive user",
  section_system: "System",
  section_cataloguing: "Cataloguing",
  section_records_management: "Records management",
  section_project_memberships: "Project memberships",
  super_admin_description:
    "Full access to all areas, including user management and system settings",
  user_manager_description:
    "Invite users, edit profiles, and assign them to projects",
  cataloguing_admin_description:
    "Manage projects, team members, and promote entries to descriptions",
  cataloguer_description:
    "Can be assigned to cataloguing projects and access the cataloguing area",
  records_admin_description:
    "Manage descriptions, entities, places, repositories, and vocabularies",
  archive_user_description: "Read-only access to archival records",
  self_warning:
    "This is your own account. Role changes are disabled to prevent accidental self-demotion.",
  non_superadmin_notice:
    "You can manage this user's profile and project assignments. Role changes require super admin access.",
  self_role_badge_tooltip: "You cannot change your own roles",
  name_label: "Name",
  email_label: "Email",
  last_login_label: "Last login",
  created_label: "Created",
  never: "Never",
  save_profile: "Save profile",
  save_roles: "Save roles",
  assign_to_project: "+ Assign to project",
  cancel: "Cancel",
  project_label: "Project",
  role_label: "Role",
  select_project: "Select project...",
  select_role: "Select role...",
  role_lead: "Lead",
  role_reviewer: "Reviewer",
  assign: "Assign",
  remove: "Remove",
  remove_confirm: "Remove from {{project}}?",
  no_memberships: "Not a member of any project",
  error_email_required: "Email is required",
  error_email_duplicate: "Another user already has this email",
  error_invalid_request: "Invalid request",
  error_only_superadmin_roles: "Only super admins can change roles",
  error_cannot_change_own_roles: "You cannot change your own roles",
  error_already_member: "Already a member of this project",
  error_forbidden: "Forbidden",
  success_profile_updated: "Profile updated",
  success_roles_updated: "Roles updated",
  success_assigned: "Assigned to project",
  success_role_updated: "Role updated",
  success_removed: "Removed from project",
} as const;
