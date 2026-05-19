/**
 * Scripts — role mapping
 *
 * This module deals with the role normalisation that the junction row
 * builders rely on. Production catalogue data carries
 * description_entities.role / description_places.role as a mix of
 * normalised English values (the canonical Fisqua enum: mentioned,
 * creator, sender, subject, defendant, recipient, plaintiff, witness,
 * scribe, ...) AND original Spanish historical roles (Fiador, Apoderado,
 * Albacea, Reo, Heredero, Testigo, Heredera, Autor) that don't survive
 * the schema-level CHECK enum.
 *
 * Direct insertion would violate the CHECK constraint. The dual-track
 * mitigation: junction row builders call `mapRoleEntityToCanonical` /
 * `mapRolePlaceToCanonical` and write BOTH the mapped English value to
 * `role` (CHECK-enforced) AND the verbatim original string to
 * `role_raw` (nullable, no CHECK; landed by
 * `drizzle/0040_role_raw.sql`).
 *
 * Initial mapping entries derive from two sources of truth:
 *   - `app/locales/es/descriptions.ts` role_* labels — every Spanish
 *     label maps back to its English ENTITY_ROLES / PLACE_ROLES key
 *   - eight historical Spanish roles that appear in the Django dump
 *     but are not in the locales file
 *
 * Unmapped values return `{ mapped: null, raw }`. The junction row
 * builder treats `mapped === null` as a soft-skip and records
 * `validationMessages: ["role: unmapped value '<x>'; add to
 * scripts/lib/role-map.ts"]`. Operators reading import-failures.json
 * see exactly which Spanish strings need a mapping decision; the next
 * round adds them and the rows import cleanly.
 *
 * `Fiador` and `Apoderado` are both kept as Spanish ENTITY_ROLES
 * values (consistent with the existing `albacea` precedent for
 * richly-historical legal roles that lack clean English equivalents).
 * Locale labels:
 *
 *   - `fiador` — ES "Fiador", EN "Surety"
 *   - `apoderado` — ES "Apoderado", EN "Attorney-in-Fact"
 *
 * @version v0.4.0
 */
import { ENTITY_ROLES, PLACE_ROLES } from "../../app/lib/validation/enums";

/**
 * Spanish→English mapping for entity roles. `null` value = explicit
 * soft-skip on first encounter; the operator inspects the failure
 * report and either adds a mapping decision in the next round or
 * extends the ENTITY_ROLES enum.
 */
export const ENTITY_ROLE_MAP: Record<string, string | null> = {
  // Already-English passthroughs (audit lists these as the normalised set)
  mentioned: "mentioned",
  creator: "creator",
  sender: "sender",
  subject: "subject",
  defendant: "defendant",
  recipient: "recipient",
  plaintiff: "plaintiff",
  witness: "witness",
  scribe: "scribe",
  fiador: "fiador",
  apoderado: "apoderado",
  // Spanish historical roles from the audit, mapped via the locales
  // role_* labels and ENTITY_ROLES.
  Testigo: "witness", // role_witness
  Albacea: "albacea", // role_albacea
  Reo: "defendant", // role_defendant — closest semantic match
  Heredero: "heir", // role_heir
  Heredera: "heir", // role_heir (gender-collapsed)
  Autor: "author", // role_author
  Fiador: "fiador", // role_fiador
  Apoderado: "apoderado", // role_apoderado
  // Spanish-only role labels from app/locales/es/descriptions.ts.
  Creador: "creator",
  Editor: "editor",
  Remitente: "sender",
  Destinatario: "recipient",
  Mencionado: "mentioned",
  Tema: "subject",
  Escribano: "scribe",
  Notario: "notary",
  Demandante: "plaintiff",
  Demandado: "defendant",
  Peticionario: "petitioner",
  Juez: "judge",
  Apelante: "appellant",
  Funcionario: "official",
  Cónyuge: "spouse",
  Víctima: "victim",
  Otorgante: "grantor",
  Donante: "donor",
  Vendedor: "seller",
  Comprador: "buyer",
  Acreedor: "creditor",
  Deudor: "debtor",
  Fotógrafo: "photographer",
  Artista: "artist",
};

/**
 * Spanish→English mapping for place roles. The PLACE_ROLES enum is
 * smaller (7 values), so the map is correspondingly small.
 */
export const PLACE_ROLE_MAP: Record<string, string | null> = {
  // English passthroughs
  created: "created",
  subject: "subject",
  mentioned: "mentioned",
  sent_from: "sent_from",
  sent_to: "sent_to",
  published: "published",
  venue: "venue",
  // Spanish from app/locales/es/descriptions.ts
  Creado: "created",
  Tema: "subject",
  Mencionado: "mentioned",
  "Enviado desde": "sent_from",
  "Recibido en": "sent_to",
  Publicado: "published",
  Lugar: "venue",
};

/**
 * Resolve a raw entity-role string to a canonical ENTITY_ROLES value
 * plus the verbatim source string for `role_raw`. Order of resolution:
 *
 *   1. Explicit map hit (Spanish or English keys above)
 *   2. Passthrough: raw is already an ENTITY_ROLES value
 *   3. Fail: returns `{ mapped: null, raw }` for soft-skip
 */
export function mapRoleEntityToCanonical(
  raw: string,
): { mapped: string | null; raw: string } {
  const explicit = ENTITY_ROLE_MAP[raw];
  if (explicit !== undefined) return { mapped: explicit, raw };
  if ((ENTITY_ROLES as readonly string[]).includes(raw))
    return { mapped: raw, raw };
  return { mapped: null, raw };
}

/**
 * Resolve a raw place-role string to a canonical PLACE_ROLES value
 * plus the verbatim source string for `role_raw`. Same shape as
 * `mapRoleEntityToCanonical`.
 */
export function mapRolePlaceToCanonical(
  raw: string,
): { mapped: string | null; raw: string } {
  const explicit = PLACE_ROLE_MAP[raw];
  if (explicit !== undefined) return { mapped: explicit, raw };
  if ((PLACE_ROLES as readonly string[]).includes(raw))
    return { mapped: raw, raw };
  return { mapped: null, raw };
}

// Version: v0.4.0
