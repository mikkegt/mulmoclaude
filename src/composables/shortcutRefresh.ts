// Pure refresh rule for one pinned shortcut against the authoritative index
// row an index page just fetched. Split out of `useShortcuts.reconcile` so the
// rule can be tested without the composable's module state, API calls and
// mutation queue — the bug it was extracted for was invisible in every test
// that went through those.
//
// The shape is deliberately "rebuild from identity + fresh values", never
// "patch the old entry": a spread of the existing shortcut carries fields the
// live row has since DROPPED, so a removed accent colour survived forever and
// re-triggered drift on every reconcile, rewriting the file each time (#2987).

import type { Shortcut } from "../types/shortcuts";

/** The authoritative fields an index row supplies for a pinned shortcut. */
export interface ShortcutRefreshSource {
  title: string;
  icon: string;
  color?: string | undefined;
}

/** `{ color }` when there is one, `{}` when there is not — so a shortcut whose
 *  collection dropped its colour loses the key rather than persisting a null
 *  (`JSON.stringify` writes an explicit `undefined` member as `null`). */
function withColor(color: string | undefined): { color?: string } {
  return color === undefined ? {} : { color };
}

/** True when the live row disagrees with what is persisted, in any field the
 *  index owns. Drives whether reconcile writes the file at all. */
export function hasShortcutDrifted(entry: Shortcut, fresh: ShortcutRefreshSource): boolean {
  return fresh.title !== entry.title || fresh.icon !== entry.icon || fresh.color !== entry.color;
}

/** The shortcut as the index says it should be: the pin's own identity
 *  (`kind`, `slug`) plus every index-owned field taken from `fresh`.
 *
 *  Built key by key rather than spread over `entry`, so a field the live row no
 *  longer carries is genuinely gone from the result. `hasShortcutDrifted` is
 *  then false on the next pass, which is what stops the rewrite loop. */
export function refreshShortcut(entry: Shortcut, fresh: ShortcutRefreshSource): Shortcut {
  return {
    kind: entry.kind,
    slug: entry.slug,
    title: fresh.title,
    icon: fresh.icon,
    ...withColor(fresh.color),
  };
}
