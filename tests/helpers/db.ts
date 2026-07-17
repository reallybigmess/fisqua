/**
 * Tests — db
 *
 * This helper is the hand-built test-DB harness. It mirrors the
 * production schema by
 * replaying `db.exec("CREATE TABLE ...")` statements against a fresh
 * in-Worker D1 binding so the existing 2520+ test suite can run
 * without invoking `wrangler d1 migrations apply`. Updates land
 * lock-step with each Drizzle migration.
 *
 * The `DEFAULT_TEST_TENANT_ID` export and the seed helpers
 * (`seedTenants`, `seedDisabledTenant`, `seedOperatorUser`) live
 * here so downstream test files share a single import surface for
 * tenant-aware fixtures.
 *
 * @version v0.6.0
 */
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../../app/db/schema";
import {
  NEOGRANADINA_TENANT_ID,
  PLATFORM_TENANT_ID,
  DACS_TEST_TENANT_ID,
  RAD_TEST_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
  PLATFORM_FEDERATION_ID,
} from "../../app/lib/tenant";

/**
 * Creates a Drizzle instance bound to the test D1 database.
 */
export function getTestDb() {
  return drizzle(env.DB, { schema });
}

/**
 * Applies the schema to the test D1 database.
 * Uses D1 batch API (prepare + run) for each statement.
 */
export async function applyMigrations() {
  const db = env.DB;

  // tenants table mirrors drizzle/0034_tenants_table.sql verbatim --
  // same columns, same CHECK constraints, same indexes. Declared
  // before every table that carries a tenant_id FK so the FK
  // reference resolves at harness load.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS tenants (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "slug TEXT NOT NULL UNIQUE, " +
      "name TEXT NOT NULL, " +
      "kind TEXT NOT NULL DEFAULT 'tenant' CHECK (kind IN ('tenant','platform')), " +
      "descriptive_standard TEXT, " +
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), " +
      "crowdsourcing_enabled INTEGER NOT NULL DEFAULT 0, " +
      "vocabulary_hub_enabled INTEGER NOT NULL DEFAULT 1, " +
      "publish_pipeline_enabled INTEGER NOT NULL DEFAULT 1, " +
      "multi_repository_enabled INTEGER NOT NULL DEFAULT 0, " +
      // authorities capability (migration 0058). DEFAULT 1 —
      // behaviour-neutral; komuni/sbmal launch strings-only.
      "authorities_enabled INTEGER NOT NULL DEFAULT 1, " +
      // imports capability (migration 0061). DEFAULT 0 — operator-granted.
      "imports_enabled INTEGER NOT NULL DEFAULT 0, " +
      "quota_storage_bytes INTEGER, " +
      // Nullable soft-disable timestamp.
      "disabled_at INTEGER, " +
      // federation_id (migration 0044): nullable-with-FK at the DB layer
      // (schema.ts enforces NOT NULL at the type layer). FK references
      // federations, created just below — SQLite allows a forward FK
      // reference at CREATE time (checked only at row ops).
      "federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      // SQLite CHECK only rejects on FALSE (not NULL). The second
      // branch must explicitly guard descriptive_standard IS NOT NULL
      // so that `kind='tenant', descriptive_standard=NULL` does not
      // slip through (NULL IN (...) is NULL, not FALSE).
      "CHECK ((kind = 'platform' AND descriptive_standard IS NULL) OR (kind = 'tenant' AND descriptive_standard IS NOT NULL AND descriptive_standard IN ('isadg','dacs','rad'))), " +
      "CHECK (slug GLOB '[a-z][a-z0-9-]*[a-z0-9]' OR slug GLOB '[a-z]')" +
    ")",
  );
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_slug_idx ON tenants(slug)");
  await db.exec("CREATE INDEX IF NOT EXISTS tenants_kind_idx ON tenants(kind)");
  await db.exec("CREATE INDEX IF NOT EXISTS tenants_federation_idx ON tenants(federation_id)");

  // federations table (migration 0044) mirrors drizzle/0044_federations.sql.
  // Declared right after tenants so its lead_tenant_id FK resolves; the
  // tenants.federation_id FK above forward-references this table (legal
  // at CREATE — SQLite checks FKs only at row ops). tenants <-> federations
  // is a circular FK pair, so seeding (seedTenants then seedFederations)
  // and teardown (NULL tenants.federation_id, drop federations, drop
  // tenants) sequence around it — D1 has no DEFERRED FK support.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS federations (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "slug TEXT NOT NULL UNIQUE, " +
      "name TEXT NOT NULL, " +
      "lead_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')), " +
      "multi_member_enabled INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS federations_slug_idx ON federations(slug)");
  await db.exec("CREATE INDEX IF NOT EXISTS federations_lead_tenant_idx ON federations(lead_tenant_id)");

  // users carries tenant_id NOT NULL FK to tenants(id) ON DELETE
  // RESTRICT, immediately after id (mirrors drizzle/0035 column
  // order).
  await db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, email TEXT NOT NULL UNIQUE, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, is_super_admin INTEGER NOT NULL DEFAULT 0, is_collab_admin INTEGER NOT NULL DEFAULT 0, is_archive_user INTEGER NOT NULL DEFAULT 0, is_user_manager INTEGER NOT NULL DEFAULT 0, is_cataloguer INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, github_id TEXT UNIQUE)");

  // federation_memberships (migration 0049): the grant join table.
  // Declared after users + federations so both FKs resolve. Both FKs are
  // ON DELETE CASCADE; UNIQUE(user_id, federation_id) is the composite
  // index the schema declares by name (fed_memberships_user_federation_idx).
  await db.exec(
    "CREATE TABLE IF NOT EXISTS federation_memberships (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
      "federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE CASCADE, " +
      "role TEXT NOT NULL CHECK (role IN ('steward','staff')), " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS fed_memberships_user_federation_idx ON federation_memberships(user_id, federation_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS fed_memberships_federation_idx ON federation_memberships(federation_id)");

  // audit_log table mirrors drizzle/0037 verbatim — same 12 columns,
  // mixed FK delete behaviours (actor_user_id ON DELETE SET NULL
  // paired with denormalised actor_user_id_text NOT NULL for
  // forensic continuity; actor_tenant_id and target_tenant_id ON
  // DELETE RESTRICT), bounded action CHECK enum, 3 indexes with
  // created_at DESC ordering, and 2 BEFORE UPDATE / BEFORE DELETE
  // immutability triggers using the bare RAISE form (a
  // workers-sdk #4326 trigger-parser quirk avoidance).
  await db.exec(
    "CREATE TABLE IF NOT EXISTS audit_log (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "created_at INTEGER NOT NULL, " +
      "actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, " +
      "actor_user_id_text TEXT NOT NULL, " +
      "actor_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "action TEXT NOT NULL CHECK (action IN (" +
        "'create_tenant','soft_disable_tenant','reset_superadmin','login_as'," +
        "'edit_on_behalf','set_capability','set_quota'" +
      ")), " +
      "target_tenant_id TEXT REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "target_object_kind TEXT, " +
      "target_object_id TEXT, " +
      "impersonation_session_id TEXT, " +
      "details TEXT" +
    ")",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS audit_log_target_tenant_idx ON audit_log(target_tenant_id, created_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS audit_log_actor_user_idx ON audit_log(actor_user_id, created_at DESC)");
  await db.exec("CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC)");
  // Immutability triggers — bare RAISE form to dodge the
  // workers-sdk #4326 trigger-parser quirk. The append-only trigger
  // has a WHEN clause that allows the single FK-cascade transition
  // (actor_user_id going from non-null to NULL when the referenced
  // user is deleted). Every other UPDATE path still hits the trigger.
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log " +
      "WHEN NOT (" +
        "OLD.actor_user_id IS NOT NULL " +
        "AND NEW.actor_user_id IS NULL " +
        "AND OLD.id IS NEW.id " +
        "AND OLD.created_at IS NEW.created_at " +
        "AND OLD.actor_user_id_text IS NEW.actor_user_id_text " +
        "AND OLD.actor_tenant_id IS NEW.actor_tenant_id " +
        "AND OLD.action IS NEW.action " +
        "AND OLD.target_tenant_id IS NEW.target_tenant_id " +
        "AND OLD.target_object_kind IS NEW.target_object_kind " +
        "AND OLD.target_object_id IS NEW.target_object_id " +
        "AND OLD.impersonation_session_id IS NEW.impersonation_session_id " +
        "AND OLD.details IS NEW.details" +
      ") " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END",
  );

  await db.exec("CREATE TABLE IF NOT EXISTS magic_links (id TEXT PRIMARY KEY NOT NULL, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_token_idx ON magic_links(token)");
  await db.exec("CREATE INDEX IF NOT EXISTS magic_links_expires_idx ON magic_links(expires_at)");

  // oauth_handoffs is the ephemeral, single-use rendezvous between
  // the apex GitHub OAuth callback and a tenant subdomain. No FKs
  // (rows are ephemeral; email + slug are re-validated at consume
  // time). 30s TTL bound is enforced by the helper, not the schema.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS oauth_handoffs (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "email TEXT NOT NULL, " +
      "github_id TEXT NOT NULL, " +
      "github_login TEXT NOT NULL, " +
      "return_to_slug TEXT NOT NULL, " +
      "expires_at INTEGER NOT NULL, " +
      "consumed INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );

  // impersonation_handoffs mirrors the single-use shape but is a
  // separate table (clean role-based columns; clean target for
  // audit_log.impersonation_session_id). FK delete behaviour:
  // actor_user_id and target_tenant_id both ON DELETE RESTRICT
  // (forensic continuity > orphan cleanup; rows are short-lived).
  // target_role CHECK enforces the six role-flag literal names
  // exactly.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS impersonation_handoffs (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
      "target_tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, " +
      "target_role TEXT NOT NULL CHECK (target_role IN ('isAdmin','isSuperAdmin','isCollabAdmin','isArchiveUser','isUserManager','isCataloguer')), " +
      "reason TEXT, " +
      "expires_at INTEGER NOT NULL, " +
      "consumed INTEGER NOT NULL DEFAULT 0, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS impersonation_handoffs_expires_idx ON impersonation_handoffs(expires_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS impersonation_handoffs_actor_idx ON impersonation_handoffs(actor_user_id, created_at)");

  // tenant_id NOT NULL DEFAULT (migration 0042) on the seven
  // crowdsourcing tables. ADD COLUMN in the migration; declared inline
  // here so the harness matches the post-0042 shape.
  await db.exec("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', name TEXT NOT NULL, description TEXT, conventions TEXT, settings TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_members (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('lead', 'cataloguer', 'reviewer')), created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_idx ON project_members(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_user_idx ON project_members(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS pm_project_user_idx ON project_members(project_id, user_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS project_invites (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), email TEXT NOT NULL, roles TEXT NOT NULL, invited_by TEXT NOT NULL REFERENCES users(id), token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, accepted_at INTEGER, created_at INTEGER NOT NULL)");

  await db.exec("CREATE TABLE IF NOT EXISTS volumes (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, reference_code TEXT NOT NULL, manifest_url TEXT NOT NULL, page_count INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unstarted' CHECK(status IN ('unstarted', 'in_progress', 'segmented', 'sent_back', 'reviewed', 'approved')), assigned_to TEXT REFERENCES users(id), assigned_reviewer TEXT REFERENCES users(id), review_comment TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_project_idx ON volumes(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vol_status_idx ON volumes(project_id, status)");

  await db.exec("CREATE TABLE IF NOT EXISTS volume_pages (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, position INTEGER NOT NULL, image_url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, label TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_idx ON volume_pages(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS vp_volume_pos_idx ON volume_pages(volume_id, position)");

  await db.exec("DROP TABLE IF EXISTS entries");
  // post-Wave-2 (migration 0032): `test_images` joins the
  // EntryType CHECK and a new nullable `subtype` column carries the
  // per-entry document subtype label (only meaningful for type='item').
  await db.exec("CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id), parent_id TEXT, position INTEGER NOT NULL, start_page INTEGER NOT NULL, start_y REAL NOT NULL DEFAULT 0, end_page INTEGER, end_y REAL, type TEXT CHECK(type IN ('item', 'blank', 'front_matter', 'back_matter', 'test_images')), subtype TEXT, title TEXT, modified_by TEXT REFERENCES users(id), description_status TEXT DEFAULT 'unassigned' CHECK(description_status IN ('unassigned', 'assigned', 'in_progress', 'described', 'reviewed', 'approved', 'sent_back', 'promoted')), assigned_describer TEXT REFERENCES users(id), assigned_description_reviewer TEXT REFERENCES users(id), translated_title TEXT, resource_type TEXT CHECK(resource_type IN ('texto', 'imagen', 'cartografico', 'mixto')), date_expression TEXT, date_start TEXT, date_end TEXT, extent TEXT, scope_content TEXT, language TEXT, description_notes TEXT, internal_notes TEXT, description_level TEXT DEFAULT 'item', promoted_description_id TEXT REFERENCES descriptions(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_promoted_idx ON entries(promoted_description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_volume_idx ON entries(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_parent_idx ON entries(parent_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entry_volume_pos_idx ON entries(volume_id, position)");

  await db.exec("DROP TABLE IF EXISTS comments");
  await db.exec("DROP TABLE IF EXISTS qc_flags");

  // qc_flags -- page-scoped QC signals with a resolution workflow.
  // Declared before comments because adds a FK from comments.qc_flag_id.
  //
  // region_comment_id is a legacy/deprecated column from the (reverted)
  // "Vincular a región" follow-up. The column
  // still exists in D1 (migration 0031 is NOT rolled back) and the test
  // helper preserves it so schema assertions match real DB state, but no
  // application code reads or writes it after the 2026-04-18 cleanup.
  await db.exec("CREATE TABLE qc_flags (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, page_id TEXT NOT NULL REFERENCES volume_pages(id) ON DELETE CASCADE, reported_by TEXT NOT NULL REFERENCES users(id), problem_type TEXT NOT NULL CHECK(problem_type IN ('damaged','repeated','out_of_order','missing','blank','other')), description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','wontfix')), resolution_action TEXT CHECK(resolution_action IS NULL OR resolution_action IN ('retake_requested','reordered','marked_duplicate','ignored','other')), resolver_note TEXT, resolved_by TEXT REFERENCES users(id), resolved_at INTEGER, region_comment_id TEXT, created_at INTEGER NOT NULL, CHECK ((status = 'open' AND resolution_action IS NULL AND resolved_by IS NULL AND resolved_at IS NULL) OR (status IN ('resolved','wontfix') AND resolution_action IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)), CHECK (problem_type != 'other' OR length(description) > 0), CHECK (resolution_action != 'other' OR length(COALESCE(resolver_note, '')) > 0))");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_volume_status_idx ON qc_flags(volume_id, status)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_page_idx ON qc_flags(page_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_reporter_idx ON qc_flags(reported_by)");
  await db.exec("CREATE INDEX IF NOT EXISTS qc_flags_region_comment_idx ON qc_flags(region_comment_id)");

  // comments target exactly one of entry_id, page_id, or
  // qc_flag_id (three-way XOR CHECK). Nullable region_x/y/w/h REAL columns
  // carry optional image-region coordinates on page-targeted comments.
  // task 13 (migration 0033): five additional nullable columns
  // for soft-delete + resolve + last-edit tracking. All nullable, no
  // backfill, no new CHECK constraints.
  await db.exec("CREATE TABLE comments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE, page_id TEXT REFERENCES volume_pages(id) ON DELETE CASCADE, qc_flag_id TEXT REFERENCES qc_flags(id) ON DELETE CASCADE, region_x REAL, region_y REAL, region_w REAL, region_h REAL, parent_id TEXT, author_id TEXT NOT NULL REFERENCES users(id), author_role TEXT NOT NULL CHECK(author_role IN ('cataloguer', 'reviewer', 'lead')), text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT REFERENCES users(id), resolved_at INTEGER, resolved_by TEXT REFERENCES users(id), edited_at INTEGER, CHECK ((entry_id IS NOT NULL AND page_id IS NULL AND qc_flag_id IS NULL) OR (entry_id IS NULL AND page_id IS NOT NULL AND qc_flag_id IS NULL) OR (entry_id IS NULL AND page_id IS NULL AND qc_flag_id IS NOT NULL)))");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_volume_idx ON comments(volume_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_entry_idx ON comments(entry_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_page_idx ON comments(page_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_qc_flag_idx ON comments(qc_flag_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS comment_parent_idx ON comments(parent_id)");

  await db.exec("DROP TABLE IF EXISTS resegmentation_flags");
  await db.exec("CREATE TABLE resegmentation_flags (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', volume_id TEXT NOT NULL REFERENCES volumes(id), reported_by TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id), problem_type TEXT NOT NULL CHECK(problem_type IN ('incorrect_boundaries', 'merged_documents', 'split_document', 'missing_pages', 'other')), affected_entry_ids TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')), resolved_by TEXT REFERENCES users(id), resolved_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS reseg_volume_idx ON resegmentation_flags(volume_id)");

  await db.exec("CREATE TABLE IF NOT EXISTS activity_log (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES projects(id), volume_id TEXT REFERENCES volumes(id), event TEXT NOT NULL CHECK(event IN ('login', 'volume_opened', 'status_changed', 'review_submitted', 'assignment_changed', 'description_status_changed', 'description_assignment_changed', 'resegmentation_flagged', 'comment_added', 'comment_region_moved', 'comment_edited', 'comment_deleted', 'comment_resolved', 'comment_unresolved', 'qc_flag_raised', 'qc_flag_resolved')), detail TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_user_idx ON activity_log(user_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_project_idx ON activity_log(project_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS al_created_idx ON activity_log(created_at)");

  // Archival management tables. repositories carries tenant_id NOT
  // NULL FK after id.
  await db.exec("CREATE TABLE IF NOT EXISTS repositories (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, code TEXT NOT NULL, name TEXT NOT NULL, short_name TEXT, country_code TEXT DEFAULT 'COL', country TEXT, city TEXT, address TEXT, website TEXT, notes TEXT, rights_text TEXT, display_title TEXT, subtitle TEXT, hero_image_url TEXT, enabled INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS repo_code_idx ON repositories(tenant_id, code)");

  // descriptions carries the union-schema column set: 9 dead
  // columns dropped (related_materials), 6 new + 3 legacy_ids JSON
  // columns added (publication_title, legacy_ids), DACS/RAD
  // additions (admin_biog_history, preferred_citation,
  // acquisition_info, system_of_arrangement,
  // physical_characteristics), local_identifier nullable.
  await db.exec("CREATE TABLE IF NOT EXISTS descriptions (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, repository_id TEXT NOT NULL REFERENCES repositories(id), parent_id TEXT, position INTEGER DEFAULT 0 NOT NULL, root_description_id TEXT, depth INTEGER DEFAULT 0 NOT NULL, child_count INTEGER DEFAULT 0 NOT NULL, path_cache TEXT DEFAULT '', description_level TEXT NOT NULL, resource_type TEXT, genre TEXT DEFAULT '[]', reference_code TEXT NOT NULL, local_identifier TEXT, title TEXT NOT NULL, translated_title TEXT, uniform_title TEXT, date_expression TEXT, date_start TEXT, date_end TEXT, date_certainty TEXT, extent TEXT, dimensions TEXT, medium TEXT, imprint TEXT, edition_statement TEXT, series_statement TEXT, volume_number TEXT, issue_number TEXT, pages TEXT, publication_title TEXT, provenance TEXT, scope_content TEXT, ocr_text TEXT DEFAULT '', arrangement TEXT, access_conditions TEXT, reproduction_conditions TEXT, language TEXT, location_of_originals TEXT, location_of_copies TEXT, finding_aids TEXT, section_title TEXT, notes TEXT, internal_notes TEXT, creator_display TEXT, place_display TEXT, iiif_manifest_url TEXT, has_digital INTEGER DEFAULT 0, is_published INTEGER DEFAULT 0, last_exported_at INTEGER, admin_biog_history TEXT, preferred_citation TEXT, acquisition_info TEXT, system_of_arrangement TEXT, physical_characteristics TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', created_by TEXT REFERENCES users(id), updated_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_parent_pos_idx ON descriptions(parent_id, position)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_root_idx ON descriptions(root_description_id)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS desc_ref_code_idx ON descriptions(tenant_id, reference_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_repo_idx ON descriptions(repository_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS desc_local_id_idx ON descriptions(local_identifier)");

  // vocabulary_terms carries federation_id NOT NULL FK (migration 0045):
  // authorities are federation-scoped. The harness builds a fresh table
  // so it can declare the FK inline (production went through ADD COLUMN +
  // backfill because the rebuild pattern is prohibited).
  await db.exec("CREATE TABLE IF NOT EXISTS vocabulary_terms (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, canonical TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'approved', merged_into TEXT, entity_count INTEGER NOT NULL DEFAULT 0, proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL, reviewed_at INTEGER, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_canonical_idx ON vocabulary_terms(canonical)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_category_idx ON vocabulary_terms(category)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_status_idx ON vocabulary_terms(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS vt_federation_idx ON vocabulary_terms(federation_id)");

  // entities carries federation_id NOT NULL FK (migrations 0045-0048):
  // authorities are federation-scoped, and the code index is unique per
  // federation. tenant_id was dropped by 0048.
  await db.exec("CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, entity_code TEXT, display_name TEXT NOT NULL, sort_name TEXT NOT NULL, surname TEXT, given_name TEXT, entity_type TEXT NOT NULL, honorific TEXT, primary_function TEXT, primary_function_id TEXT REFERENCES vocabulary_terms(id) ON DELETE SET NULL, name_variants TEXT DEFAULT '[]', dates_of_existence TEXT, date_start TEXT, date_end TEXT, history TEXT, functions TEXT, sources TEXT, merged_into TEXT, wikidata_id TEXT, viaf_id TEXT, dbe_id TEXT, legacy_ids TEXT NOT NULL DEFAULT '[]', notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS entity_code_idx ON entities(federation_id, entity_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_sort_name_idx ON entities(sort_name)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_wikidata_idx ON entities(wikidata_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS entity_pf_id_idx ON entities(primary_function_id)");

  // entities_fts mirrors drizzle/0015 (columns) with the 0041 trigger
  // shape, for the same reasons as places_fts below: unicode61 folds
  // diacritics (the entities list's accent-insensitive search
  // contract), and AD/AU must use direct row deletion — the
  // external-content "delete command" idiom raises `SQL logic error`
  // on regular FTS5 tables under D1's trusted-schema mode.
  await db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(display_name, sort_name, name_variants, tokenize='unicode61')",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN " +
      "INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants) " +
      "VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN " +
      "DELETE FROM entities_fts WHERE rowid = old.rowid; END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN " +
      "DELETE FROM entities_fts WHERE rowid = old.rowid; " +
      "INSERT INTO entities_fts(rowid, display_name, sort_name, name_variants) " +
      "VALUES (new.rowid, new.display_name, new.sort_name, new.name_variants); END",
  );

  await db.exec("CREATE TABLE IF NOT EXISTS entity_functions (id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, honorific TEXT, function TEXT NOT NULL, date_start TEXT, date_end TEXT, date_note TEXT, certainty TEXT DEFAULT 'probable', source TEXT, notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS ef_entity_idx ON entity_functions(entity_id)");

  // places loses 7 dead columns (historical_gobernacion,
  // historical_partido, historical_region, country_code,
  // admin_level_1, admin_level_2, wikidata_id — all 0% populated)
  // and gains fclass (5-value GeoNames feature class with CHECK
  // enforcement at the DB layer) + legacy_ids JSON.
  await db.exec("CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY NOT NULL, federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, place_code TEXT, label TEXT NOT NULL, display_name TEXT NOT NULL, place_type TEXT, name_variants TEXT DEFAULT '[]', parent_id TEXT, latitude REAL, longitude REAL, coordinate_precision TEXT, merged_into TEXT, tgn_id TEXT, hgis_id TEXT, whg_id TEXT, fclass TEXT CHECK (fclass IS NULL OR fclass IN ('P','H','A','T','S')), legacy_ids TEXT NOT NULL DEFAULT '[]', notes TEXT, internal_notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS place_code_idx ON places(federation_id, place_code)");
  await db.exec("CREATE INDEX IF NOT EXISTS place_label_idx ON places(label)");
  await db.exec("CREATE INDEX IF NOT EXISTS place_tgn_idx ON places(tgn_id)");
  // places_fts mirrors drizzle/0015 (columns) with the 0041 trigger
  // shape: the unicode61 tokenizer folds diacritics, which is the
  // accent-insensitive search contract the places list loader relies
  // on (`bogota` matches `Bogotá`). AD/AU use direct row deletion —
  // the external-content "delete command" idiom (0015/0036) raises
  // `SQL logic error` on regular FTS5 tables under D1's defensive
  // trusted-schema mode (the 0041 lesson; miniflare enforces the same
  // mode). cleanDatabase's DELETE FROM places flows through the AD
  // trigger, keeping the index in lockstep.
  await db.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS places_fts USING fts5(label, display_name, name_variants, tokenize='unicode61')",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS places_fts_ai AFTER INSERT ON places BEGIN " +
      "INSERT INTO places_fts(rowid, label, display_name, name_variants) " +
      "VALUES (new.rowid, new.label, new.display_name, new.name_variants); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS places_fts_ad AFTER DELETE ON places BEGIN " +
      "DELETE FROM places_fts WHERE rowid = old.rowid; END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS places_fts_au AFTER UPDATE ON places BEGIN " +
      "DELETE FROM places_fts WHERE rowid = old.rowid; " +
      "INSERT INTO places_fts(rowid, label, display_name, name_variants) " +
      "VALUES (new.rowid, new.label, new.display_name, new.name_variants); END",
  );

  await db.exec("CREATE TABLE IF NOT EXISTS description_entities (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, role_raw TEXT, sequence INTEGER DEFAULT 0 NOT NULL, honorific TEXT, function TEXT, name_as_recorded TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS de_desc_idx ON description_entities(description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS de_entity_role_idx ON description_entities(entity_id, role)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS de_unique_idx ON description_entities(description_id, entity_id, role)");

  await db.exec("CREATE TABLE IF NOT EXISTS description_places (id TEXT PRIMARY KEY NOT NULL, description_id TEXT NOT NULL REFERENCES descriptions(id) ON DELETE CASCADE, place_id TEXT NOT NULL REFERENCES places(id) ON DELETE RESTRICT, role TEXT NOT NULL, role_note TEXT, role_raw TEXT, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS dp_desc_idx ON description_places(description_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS dp_place_role_idx ON description_places(place_id, role)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS dp_unique_idx ON description_places(description_id, place_id, role)");

  await db.exec("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'c50bfa92-1223-4f00-ba15-d50c39ae3c0b', record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  // Per-tenant unique draft index (migration 0050): two tenants may each
  // hold a draft on the same federation-shared record.
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS drafts_record_idx ON drafts(tenant_id, record_id, record_type)");
  await db.exec("CREATE INDEX IF NOT EXISTS drafts_user_idx ON drafts(user_id)");

  // changelog carries the stewardship-journal columns (migration 0063:
  // run_id + kind) and is append-only at the DB level — the harness
  // installs the same RAISE(ABORT) triggers as production so journal
  // immutability is testable.
  await db.exec("CREATE TABLE IF NOT EXISTS changelog (id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL, record_type TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), note TEXT, diff TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL DEFAULT 'update' CHECK (kind IN ('create','update','delete','link','unlink')), created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS changelog_record_idx ON changelog(record_id, record_type, created_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS changelog_run_idx ON changelog(run_id)");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS changelog_no_update BEFORE UPDATE ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'changelog is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS changelog_no_delete BEFORE DELETE ON changelog " +
      "BEGIN SELECT RAISE(ABORT, 'changelog is immutable'); END",
  );

  // stewardship_runs (migration 0062): the commit envelope for bulk
  // operations (import/revert). Lifecycle columns mirror export_runs;
  // revert linkage and profile pointers carry no FK by design.
  await db.exec("CREATE TABLE IF NOT EXISTS stewardship_runs (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, federation_id TEXT REFERENCES federations(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK (kind IN ('import','revert')), message TEXT NOT NULL CHECK (length(trim(message)) > 0), justification TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','error')), reverts_run_id TEXT, reverted_by_run_id TEXT, profile_id TEXT, profile_version INTEGER, source_artifact TEXT, report_artifact TEXT, record_counts TEXT, accepted_findings TEXT, workflow_instance_id TEXT, current_step TEXT, steps_completed INTEGER NOT NULL DEFAULT 0, total_steps INTEGER NOT NULL DEFAULT 0, current_step_started_at INTEGER, current_step_completed_at INTEGER, last_heartbeat_at INTEGER, error_message TEXT, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS stewardship_runs_tenant_idx ON stewardship_runs(tenant_id, created_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS stewardship_runs_status_idx ON stewardship_runs(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS stewardship_runs_reverts_idx ON stewardship_runs(reverts_run_id)");

  // import_profiles (migration 0064): named, per-tenant, versioned
  // mapping profiles; bindings is opaque Zod-validated JSON.
  await db.exec("CREATE TABLE IF NOT EXISTS import_profiles (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, name TEXT NOT NULL CHECK (length(trim(name)) > 0), version INTEGER NOT NULL DEFAULT 1, bindings TEXT NOT NULL, starter_key TEXT, shared_with_federation INTEGER NOT NULL DEFAULT 0 CHECK (shared_with_federation IN (0, 1)), created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, updated_by TEXT REFERENCES users(id) ON DELETE RESTRICT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS import_profiles_tenant_name_unq ON import_profiles(tenant_id, name)");
  await db.exec("CREATE INDEX IF NOT EXISTS import_profiles_tenant_idx ON import_profiles(tenant_id, updated_at)");

  // import_uploads (migration 0065): the metadata row behind every
  // staged CSV upload; run_id FK is safe (runs are never deleted),
  // profile_id is FK-free by design.
  await db.exec("CREATE TABLE IF NOT EXISTS import_uploads (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, filename TEXT NOT NULL, artifact_key TEXT NOT NULL, byte_size INTEGER NOT NULL, row_count INTEGER, headers TEXT, profile_id TEXT, profile_version INTEGER, report_artifact TEXT, check_findings TEXT, check_decisions TEXT, status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','committed','discarded')), run_id TEXT REFERENCES stewardship_runs(id) ON DELETE RESTRICT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS import_uploads_tenant_idx ON import_uploads(tenant_id, created_at)");
  await db.exec("CREATE INDEX IF NOT EXISTS import_uploads_status_idx ON import_uploads(status)");

  // export_runs carries four Cloudflare Workflows tracking columns
  // added in drizzle/0019_export_workflow.sql plus federation_id
  // (migration 0055: nullable-with-FK federation attribution for
  // aggregated publish runs); this harness mirrors them so the test
  // pool stays in sync with app/db/schema.ts.
  await db.exec("CREATE TABLE IF NOT EXISTS export_runs (id TEXT PRIMARY KEY NOT NULL, triggered_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', selected_fonds TEXT NOT NULL, selected_types TEXT NOT NULL, federation_id TEXT REFERENCES federations(id), current_step TEXT, steps_completed INTEGER NOT NULL DEFAULT 0, total_steps INTEGER NOT NULL DEFAULT 0, record_counts TEXT, workflow_instance_id TEXT, current_step_started_at INTEGER, current_step_completed_at INTEGER, last_heartbeat_at INTEGER, error_message TEXT, started_at INTEGER, completed_at INTEGER, created_at INTEGER NOT NULL)");
  await db.exec("CREATE INDEX IF NOT EXISTS export_runs_status_idx ON export_runs(status)");
  await db.exec("CREATE INDEX IF NOT EXISTS export_runs_created_idx ON export_runs(created_at)");

  // authority_operations (migration 0057): the append-only ledger of
  // authority merge/split/delete, plus the resolve/separate values
  // reserved for the pipeline provenance backfill (spec §10). FKs to
  // federations + users (both RESTRICT); source_id/target_id carry no FK
  // by design. Two BEFORE UPDATE / BEFORE DELETE immutability triggers
  // use the bare RAISE form (workers-sdk #4326 quirk avoidance),
  // mirroring audit_log — so cleanDatabase() drops them, deletes, and
  // re-creates them.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS authority_operations (" +
      "id TEXT PRIMARY KEY NOT NULL, " +
      "federation_id TEXT NOT NULL REFERENCES federations(id) ON DELETE RESTRICT, " +
      "record_type TEXT NOT NULL CHECK (record_type IN ('entity','place','vocabulary_term')), " +
      "operation TEXT NOT NULL CHECK (operation IN ('merge','split','delete','resolve','separate')), " +
      "source_id TEXT NOT NULL, " +
      "target_id TEXT, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
      "detail TEXT, " +
      "created_at INTEGER NOT NULL" +
    ")",
  );
  await db.exec("CREATE INDEX IF NOT EXISTS authority_operations_federation_idx ON authority_operations(federation_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS authority_operations_source_idx ON authority_operations(source_id)");
  await db.exec("CREATE INDEX IF NOT EXISTS authority_operations_target_idx ON authority_operations(target_id)");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_update BEFORE UPDATE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_delete BEFORE DELETE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is immutable'); END",
  );

  // The 5 domain tables carry a NOT NULL FK to tenants(id). Seed
  // the two locked tenants here so any suite that calls
  // applyMigrations() but doesn't manage tenant rows itself can
  // still INSERT into users/repositories/etc. Tests that need a
  // tenants-empty state DELETE FROM tenants explicitly after
  // applyMigrations(); cleanDatabase() also re-seeds these rows
  // after wiping every domain table.
  await seedTenants();
  // Federations (migration 0044) — seeded AFTER tenants because each
  // federation's lead_tenant_id FK points at a tenant row, and each
  // tenant's federation_id is UPDATE-set to its federation here.
  await seedFederations();
}

/**
 * Cleans all data from tables (order matters due to foreign keys)
 * and re-seeds the two tenant rows so the NOT NULL FKs on
 * users/repositories/descriptions/entities/places resolve
 * immediately.
 *
 * Re-seeding here (rather than asking every test to call
 * seedTenants() in its own beforeEach) keeps the harness backwards-
 * compatible with the 2520+ existing pre-v0.4 tests; they were
 * written against a schema where tenants did not exist, and adding
 * a manual seed call to each one is mechanical churn that adds no
 * signal. Tests that genuinely need a tenants-empty state call
 * seedTenants() themselves; tests that need additional tenants
 * (cross-tenant scenarios) insert them on top of the two seeded
 * rows.
 */
export async function cleanDatabase() {
  const db = env.DB;

  // audit_log immutability triggers prevent DELETE — DROP
  // both, DELETE the rows, then re-CREATE the triggers. This keeps
  // test isolation while honouring the schema-level append-only
  // invariant in production. audit_log is wiped first because its FK
  // to users(id) ON DELETE SET NULL would otherwise quietly clear
  // actor_user_id during the users delete, leaving stale rows.
  await db.exec("DROP TRIGGER IF EXISTS audit_log_no_update");
  await db.exec("DROP TRIGGER IF EXISTS audit_log_no_delete");
  await db.exec("DELETE FROM audit_log");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log " +
      "WHEN NOT (" +
        "OLD.actor_user_id IS NOT NULL " +
        "AND NEW.actor_user_id IS NULL " +
        "AND OLD.id IS NEW.id " +
        "AND OLD.created_at IS NEW.created_at " +
        "AND OLD.actor_user_id_text IS NEW.actor_user_id_text " +
        "AND OLD.actor_tenant_id IS NEW.actor_tenant_id " +
        "AND OLD.action IS NEW.action " +
        "AND OLD.target_tenant_id IS NEW.target_tenant_id " +
        "AND OLD.target_object_kind IS NEW.target_object_kind " +
        "AND OLD.target_object_id IS NEW.target_object_id " +
        "AND OLD.impersonation_session_id IS NEW.impersonation_session_id " +
        "AND OLD.details IS NEW.details" +
      ") " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log " +
      "BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END",
  );

  // authority_operations immutability triggers prevent DELETE — same
  // DROP / DELETE / re-CREATE dance as audit_log, and wiped here (before
  // the tables loop below) because its FKs to users + federations
  // (ON DELETE RESTRICT) would otherwise block those deletes.
  await db.exec("DROP TRIGGER IF EXISTS authority_operations_no_update");
  await db.exec("DROP TRIGGER IF EXISTS authority_operations_no_delete");
  await db.exec("DELETE FROM authority_operations");
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_update BEFORE UPDATE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is append-only'); END",
  );
  await db.exec(
    "CREATE TRIGGER IF NOT EXISTS authority_operations_no_delete BEFORE DELETE ON authority_operations " +
      "BEGIN SELECT RAISE(ABORT, 'authority_operations is immutable'); END",
  );

  // Break the tenants <-> federations circular FK before deleting either:
  // clear tenants.federation_id so federations has no incoming refs, then
  // the loop can DELETE federations before tenants (D1 enforces FK RESTRICT
  // per-statement with no DEFERRED support, so an un-NULLed federation_id
  // would block both deletes).
  await db.exec("UPDATE tenants SET federation_id = NULL");

  const tables = [
    "export_runs",
    "changelog",
    "drafts",
    "description_places",
    "description_entities",
    "entity_functions",
    "activity_log",
    "comments",
    "qc_flags",
    "resegmentation_flags",
    "entries",
    "volume_pages",
    "volumes",
    "project_invites",
    "project_members",
    "descriptions",
    "places",
    "entities",
    "vocabulary_terms",
    "repositories",
    "projects",
    "magic_links",
    "oauth_handoffs",
    // impersonation_handoffs has FKs to users + tenants ON DELETE
    // RESTRICT, so it MUST be wiped before users and tenants below.
    "impersonation_handoffs",
    // federation_memberships FKs users + federations (CASCADE), wiped
    // before both.
    "federation_memberships",
    "users",
    // federations before tenants: federations.lead_tenant_id references
    // tenants (RESTRICT), and tenants.federation_id was NULLed above, so
    // federations now has no incoming refs and drops cleanly here.
    "federations",
    // tenants last -- every child row must already be gone before
    // tenants can drop with the NOT NULL FKs in place.
    "tenants",
  ];

  for (const table of tables) {
    await db.exec(`DELETE FROM ${table}`);
  }

  // Re-seed the two locked tenant rows so subsequent helper inserts
  // against the 5 domain tables satisfy the tenant_id FK without
  // every existing test having to opt in. Tests that want to verify
  // tenants-empty behaviour must DELETE FROM tenants explicitly after
  // cleanDatabase(). Federations re-seeded after tenants (lead FK +
  // federation_id backfill).
  await seedTenants();
  await seedFederations();
}

/**
 * Locked test tenant id — equal to the seeded `neogranadina` row.
 * Use as the `tenant_id` value on every domain-table insert in
 * tests; the 5 domain tables carry a NOT NULL FK to tenants(id).
 */
export const DEFAULT_TEST_TENANT_ID: string = NEOGRANADINA_TENANT_ID;

/**
 * Locked test federation id — the Neogranadina federation, whose lead is
 * the DEFAULT_TEST_TENANT_ID tenant. Use as the `federation_id` value on
 * authority-table inserts (entities/places/vocabulary_terms) in tests
 * after migrations 0045-0048 lifted those tables to federation scope.
 */
export const DEFAULT_TEST_FEDERATION_ID: string = NEOGRANADINA_FEDERATION_ID;

/**
 * Second tenant id used by cross-tenant negative tests.
 * Deterministic literal so test fixtures are stable across runs and
 * across files; kept distinct from the production-locked PLATFORM
 * and NEOGRANADINA UUIDs. The seed in `seedTenants()` deliberately
 * gives this tenant a mixed capability profile
 * (`crowdsourcing_enabled=0`, `vocabulary_hub_enabled=1`,
 * `publish_pipeline_enabled=0`, `multi_repository_enabled=0`) so
 * capability-off paths can be exercised without flipping the
 * Neogranadina seed row.
 */
export const SECOND_TEST_TENANT_ID = "22222222-2222-4222-8222-222222222222" as const;

/**
 * Seed the two tenant rows (platform + neogranadina) into the test
 * `tenants` table created by `applyMigrations()`. Mirrors the seed
 * INSERTs in drizzle/0034_tenants_table.sql byte-for-byte on UUIDs,
 * kind, descriptive_standard, and capability flags. Uses the current
 * wall clock for created_at/updated_at instead of the migration's
 * fixed timestamp because tests can run repeatedly against a stable
 * harness; the migration's fixed timestamp is for production journal
 * determinism, not for harness behaviour.
 */
export async function seedTenants(): Promise<void> {
  const now = Date.now();
  // Platform tenant -- operator-gate target. All capabilities OFF;
  // descriptive_standard NULL (enforced by the conditional CHECK).
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      PLATFORM_TENANT_ID, "platform", "Platform", "platform", null, "active",
      0, 0, 0, 0,
      null, now, now,
    )
    .run();
  // Neogranadina tenant -- the initial production tenant. All
  // capabilities ON; descriptive_standard='isadg'.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      NEOGRANADINA_TENANT_ID, "neogranadina", "Neogranadina", "tenant", "isadg", "active",
      1, 1, 1, 1,
      null, now, now,
    )
    .run();
  // Second test tenant -- cross-tenant fixture. Mixed
  // capabilities (crowdsourcing OFF, vocabulary_hub ON, publish OFF,
  // multi_repository OFF) so capability-off code paths can be
  // exercised without mutating the Neogranadina row.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      SECOND_TEST_TENANT_ID, "second-tenant", "Second Test Tenant", "tenant", "isadg", "active",
      0, 1, 0, 0,
      null, now, now,
    )
    .run();
  // DACS test tenant -- standard-toggle integration tests. All
  // four capability flags ON; descriptive_standard 'dacs'.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      DACS_TEST_TENANT_ID, "dacs-test", "DACS Test Tenant", "tenant", "dacs", "active",
      1, 1, 1, 1,
      null, now, now,
    )
    .run();
  // RAD test tenant -- standard-toggle integration tests. Same
  // shape as DACS test tenant; descriptive_standard 'rad'.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      RAD_TEST_TENANT_ID, "rad-test", "RAD Test Tenant", "tenant", "rad", "active",
      1, 1, 1, 1,
      null, now, now,
    )
    .run();
}

/**
 * Federation ids for the fixture tenants that are federations-of-one
 * (second-tenant, dacs-test, rad-test). The neogranadina and platform
 * fixtures reuse the production federation ids
 * (NEOGRANADINA_FEDERATION_ID / PLATFORM_FEDERATION_ID). Deterministic
 * literals, distinct from the tenant fixture UUIDs (leading 'f' =
 * federation) so query logs stay debuggable.
 */
export const SECOND_TEST_FEDERATION_ID = "f2222222-2222-4222-8222-222222222222" as const;
export const DACS_TEST_FEDERATION_ID = "f6666666-6666-4666-8666-666666666666" as const;
export const RAD_TEST_FEDERATION_ID = "f7777777-7777-4777-8777-777777777777" as const;
export const DISABLED_TEST_FEDERATION_ID = "f3333333-3333-4333-8333-333333333333" as const;

/**
 * Seed one federation per seeded fixture tenant (federation spec §2 —
 * every tenant belongs to exactly one federation; a standalone tenant is
 * a federation of one). MUST run after seedTenants(): each federation's
 * lead_tenant_id points at a tenant row, and each tenant's federation_id
 * is UPDATE-set here. neogranadina + AMPL-style leads carry
 * multi_member_enabled=1; the rest are federations-of-one (0).
 */
export async function seedFederations(): Promise<void> {
  const now = Date.now();
  // [federationId, slug, name, leadTenantId, multiMemberEnabled]
  const feds: Array<[string, string, string, string, number]> = [
    [NEOGRANADINA_FEDERATION_ID, "neogranadina", "Neogranadina", NEOGRANADINA_TENANT_ID, 1],
    [PLATFORM_FEDERATION_ID, "platform", "Platform", PLATFORM_TENANT_ID, 0],
    [SECOND_TEST_FEDERATION_ID, "second-tenant", "Second Test Federation", SECOND_TEST_TENANT_ID, 0],
    [DACS_TEST_FEDERATION_ID, "dacs-test", "DACS Test Federation", DACS_TEST_TENANT_ID, 0],
    [RAD_TEST_FEDERATION_ID, "rad-test", "RAD Test Federation", RAD_TEST_TENANT_ID, 0],
  ];
  for (const [id, slug, name, leadTenantId, multiMember] of feds) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO federations (id, slug, name, lead_tenant_id, status, multi_member_enabled, created_at) " +
        "VALUES (?,?,?,?,?,?,?)",
    )
      .bind(id, slug, name, leadTenantId, "active", multiMember, now)
      .run();
    await env.DB.prepare("UPDATE tenants SET federation_id = ? WHERE id = ?")
      .bind(id, leadTenantId)
      .run();
  }
}

// Re-export DACS/RAD test tenant ids for convenience so test files
// that already import from `tests/helpers/db` get the new fixtures
// without hopping through `app/lib/tenant`.
export { DACS_TEST_TENANT_ID, RAD_TEST_TENANT_ID } from "../../app/lib/tenant";

/**
 * Disabled-tenant fixture: a tenant row with `disabled_at` set.
 * Opt-in via explicit `await seedDisabledTenant()` so the
 * five-tenant count assertion in `seedTenants()` is preserved
 * (this helper only inserts when called explicitly).
 *
 * Use this fixture from tests that exercise the
 * `getTenantFromRequest` disabled-tenant 404 branch, the
 * `/operator/*` carve-out, or the tenant-detail re-enable path.
 */
export const DISABLED_TEST_TENANT_ID = "33333333-3333-4333-8333-333333333333" as const;
export const DISABLED_TEST_TENANT_SLUG = "disabled-tenant" as const;

export async function seedDisabledTenant(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, disabled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      DISABLED_TEST_TENANT_ID,
      DISABLED_TEST_TENANT_SLUG,
      "Disabled Test Tenant",
      "tenant",
      "isadg",
      "active",
      0, 1, 1, 0,
      null,
      now - 1000, // disabled 1 second ago
      now,
      now,
    )
    .run();
  // Federation-of-one for the disabled tenant (every tenant has a
  // federation). Insert the federation (lead = the disabled tenant, which
  // exists by now) then point the tenant's federation_id at it.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO federations (id, slug, name, lead_tenant_id, status, multi_member_enabled, created_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      DISABLED_TEST_FEDERATION_ID,
      DISABLED_TEST_TENANT_SLUG,
      "Disabled Test Federation",
      DISABLED_TEST_TENANT_ID,
      "active",
      0,
      now,
    )
    .run();
  await env.DB.prepare("UPDATE tenants SET federation_id = ? WHERE id = ?")
    .bind(DISABLED_TEST_FEDERATION_ID, DISABLED_TEST_TENANT_ID)
    .run();
}

/**
 * Operator-user fixture: a user living in the platform tenant.
 * Mirrors the shape the login-as flow writes for production
 * operator accounts: tenantId=PLATFORM_TENANT_ID,
 * isSuperAdmin=true, isUserManager=true. The fixture is opt-in via
 * explicit `await seedOperatorUser()` so user-count assertions in
 * tests that don't care about operators stay green.
 */
export const OPERATOR_TEST_USER_ID = "44444444-4444-4444-8444-444444444444" as const;
export const OPERATOR_TEST_EMAIL = "operator@example.test" as const;

export async function seedOperatorUser(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, tenant_id, email, name, is_admin, is_super_admin, " +
      "is_collab_admin, is_archive_user, is_user_manager, is_cataloguer, " +
      "last_active_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      OPERATOR_TEST_USER_ID,
      PLATFORM_TENANT_ID,
      OPERATOR_TEST_EMAIL,
      "Test Operator",
      1, 1, 0, 0, 1, 0,
      null, now, now,
    )
    .run();
}
