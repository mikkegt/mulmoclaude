// Pure helpers that look up role metadata from a list of roles.
// Taking the role list as a parameter (instead of reading a Vue ref)
// keeps these dependency-free and unit-testable.

import type { Role } from "../../config/roles";

// Material Icon names are lowercase letters, DIGITS and underscores.
//
// Verified against the shipped list rather than assumed: all 2122 names in
// `material-icons/index.d.ts` use exactly the charset `[0-9_a-z]`, and this
// pattern rejects none of them. A letters-only pattern rejected 151 real icons
// — every numeric one (`123`, `360`, `10k`, `3d_rotation`, `18_up_rating`) —
// and the role silently fell back to the robot glyph instead.
//
// `collection/core/iconGlyph.ts` asks the same question of Material SYMBOLS
// and is deliberately a separate copy: it is a different icon set with its own
// name list, so each is pinned by a sweep over ITS OWN shipped names. Sharing
// one pattern would only hide the day the two sets diverge.
//
// Custom roles may have stored an emoji or other freeform value in the icon
// field; fall back to a generic icon in that case so we don't render the
// literal text inside a Material Icons span.
const MATERIAL_ICON_RE = /^[a-z0-9_]+$/;

// `smart_toy` (robot glyph) is used for both fallback cases —
// "role not found" and "role icon isn't a valid Material Icon name".
// Reserved specifically to avoid collision with `star`, which is the
// PinToggle glyph for collection shortcuts; using `star` here would
// make an unknown role look identical to a pinned collection (#1684).
const FALLBACK_ICON = "smart_toy";

export function roleIcon(roles: Role[], roleId: string): string {
  const icon = roles.find((role) => role.id === roleId)?.icon ?? FALLBACK_ICON;
  return MATERIAL_ICON_RE.test(icon) ? icon : FALLBACK_ICON;
}

export function roleName(roles: Role[], roleId: string): string {
  return roles.find((role) => role.id === roleId)?.name ?? roleId;
}
