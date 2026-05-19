/**
 * English translations — admin namespace
 *
 * This locale namespace carries the English strings for the shared
 * admin chrome — the back-office heading, the top-level user and
 * project sections, and the all/archived project pickers the admin
 * landing page uses.
 *
 * @version v0.3.0
 */
export default {
  heading: {
    admin: "Admin",
    users: "Users",
    projects: "Projects",
    all_users: "All users",
    create_user: "Create user",
    all_projects: "All projects",
    archived_projects: "Archived projects",
  },
  cataloguing_projects: {
    title: "Cataloguing projects",
  },
  cataloguing_users: {
    title: "Cataloguing users",
  },
  tab: {
    users: "Users",
    projects: "Projects",
    publish: "Publish",
    promote: "Promote",
  },
  table: {
    name: "Name",
    email: "Email",
    role: "Role",
    admin: "Admin",
    admin_status: "Admin",
    user: "User",
    last_active: "Last active",
    projects: "Projects",
    created: "Created",
    archived: "Archived",
    lead: "Lead(s)",
    members: "Members",
    project: "Project",
    actions: "Actions",
    description: "Description",
    volumes: "Volumes",
  },
  action: {
    add_user: "Add user",
    create_user: "Create user",
    new_user: "New user",
    edit_user: "Edit user",
    edit: "Edit",
    delete: "Delete",
    delete_user: "Delete user",
    cancel: "Cancel",
    change_role: "Change role",
    archive: "Archive",
    restore: "Restore",
    show_active: "Show active",
    show_archived: "Show archived",
    new_project: "New project",
    open_project: "Open project",
    manage_volumes: "Manage volumes",
  },
  empty: {
    no_users: "No users yet.",
    no_projects: "No projects yet. Create one to get started.",
    no_volumes: "No volumes yet. Open the project to add volumes.",
    no_archived: "No archived projects.",
  },
  error: {
    self_admin: "You cannot change your own admin status.",
    user_not_found: "User not found.",
    invalid_email: "Please enter a valid email address.",
    duplicate_email: "A user with this email already exists.",
    user_created: "User {{email}} created.",
    user_invited: "Invite sent to {{email}}.",
    invite_email_failed: "Failed to send invite email. Please try again.",
    admin_toggled_on: "{{email}} is now an admin.",
    admin_toggled_off: "{{email}} is no longer an admin.",
    missing_project_id: "Missing project ID.",
    project_archived: "Project archived.",
    project_restored: "Project restored.",
    project_created: "Project created.",
    project_updated: "Project updated.",
    project_deleted: "Project deleted.",
    invalid_name: "Name must be between 3 and 100 characters.",
    unknown_action: "Unknown action.",
    delete_confirm: "Permanently delete \"{{name}}\" and all its data? This cannot be undone.",
    delete_confirm_type: "Type \"{{name}}\" to confirm deletion. This cannot be undone.",
  },
  pagination: {
    showing: "Showing {{start}}-{{end}} of {{total}} users",
    previous: "Previous",
    next: "Next",
  },
  filter: {
    all: "All",
    admin: "Administrator",
    lead: "Lead",
    reviewer: "Reviewer",
    cataloguer: "Cataloguer",
  },
  confirm: {
    delete_user: "Are you sure you want to delete {{name}}? This action cannot be undone.",
  },
  placeholder: {
    email: "user@example.com",
    select_user: "Select a user\u2026",
    no_users_available: "All users already added",
  },
} as const;
