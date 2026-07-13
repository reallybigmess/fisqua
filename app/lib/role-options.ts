/**
 * Role picker options
 *
 * This module deals with turning the canonical role vocabulary
 * (`ENTITY_ROLE_GROUPS` / `PLACE_ROLES` in `validation/enums`) into the
 * localised, structured option models the EntityLinker and PlaceLinker
 * role `<select>`s render. Both linkers build their options from here so
 * the picker can only ever offer vocabulary values — never free text —
 * and every option carries a translated label rather than a raw enum
 * code.
 *
 * The entity picker is grouped (one `<optgroup>` per zasqua-backend role
 * group); the place picker is flat (seven values). The `translate`
 * argument is the caller's i18next `t` bound to the namespace that holds
 * the `role_<value>` and `role_group_<key>` keys (the linkers use
 * `descriptions_admin`); an identity function is enough to exercise the
 * wiring in tests. `tests/lib/role-vocabulary.test.ts` pins that the
 * emitted values equal the vocabulary exactly.
 *
 * @version v0.4.3
 */
import { ENTITY_ROLE_GROUPS, PLACE_ROLES } from "./validation/enums";

export interface RoleOption {
  value: string;
  label: string;
}

export interface RoleOptionGroup {
  key: string;
  label: string;
  options: RoleOption[];
}

type Translate = (key: string) => string;

/**
 * Grouped, localised entity-role options — one group per
 * `ENTITY_ROLE_GROUPS` entry, rendered as an `<optgroup>`.
 */
export function entityRoleOptionGroups(translate: Translate): RoleOptionGroup[] {
  return ENTITY_ROLE_GROUPS.map((group) => ({
    key: group.key,
    label: translate(`role_group_${group.key}`),
    options: group.roles.map((role) => ({
      value: role,
      label: translate(`role_${role}`),
    })),
  }));
}

/**
 * Flat, localised place-role options — the seven `PLACE_ROLES` values.
 */
export function placeRoleOptions(translate: Translate): RoleOption[] {
  return PLACE_ROLES.map((role) => ({
    value: role,
    label: translate(`role_${role}`),
  }));
}
