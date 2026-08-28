// The one renderer for a schema-authored `icon` value (collection / feed /
// shortcut), shared by the host and the collection plugin.
//
// Never inline `<span class="material-symbols-outlined">{{ icon }}</span>` for
// one of those values again. The font resolves an icon from a LIGATURE, so a
// value it has no ligature for is laid out as ordinary text — which overflows
// the fixed icon box and paints over the controls beside it (#2986). Routing
// every surface through `resolveIconGlyph` also makes emoji a supported way to
// tell shortcuts apart without adding a text label (#2960).
//
// A functional component rather than an SFC: core builds with plain Vite and
// carries no `@vitejs/plugin-vue`, and adding one to render two spans would
// cost more than it buys.

import { h, type FunctionalComponent, type VNode } from "vue";
import { resolveIconGlyph } from "../collection/core/iconGlyph.ts";

// Each prop spells out `| undefined` rather than relying on `?` alone:
// consumers build under `exactOptionalPropertyTypes`, where `icon?: string`
// rejects an explicitly-passed `undefined` — and `:icon="view.icon"` on an
// optional schema field passes exactly that.
export interface IconGlyphProps {
  /** The raw schema value. Blank / absent falls through to `fallback`. */
  icon?: string | undefined;
  /** This surface's default glyph when the collection declares none. */
  fallback?: string | undefined;
  /** Tailwind size class for the icon font (`text-base`, `text-2xl`, …). */
  sizeClass?: string | undefined;
  /** Accessible name for a literal glyph. Pass the collection / feed title
   *  only where the surrounding control has no label of its own; where it
   *  does (a button with its own `aria-label`), leave this off and the glyph
   *  is marked decorative instead of announcing the name twice. */
  ariaLabel?: string | undefined;
}

const DEFAULT_FALLBACK = "dataset";
const DEFAULT_SIZE_CLASS = "text-base";

// An emoji sits inside its own padding and reads noticeably smaller than an
// icon drawn at the same font size, so a literal glyph goes one step up the
// scale to match its neighbours optically. A size class not listed here is
// used as-is rather than guessed at.
const GLYPH_SIZE_BY_ICON_SIZE: Readonly<Record<string, string>> = {
  "text-xs": "text-sm",
  "text-sm": "text-base",
  "text-base": "text-lg",
  "text-lg": "text-xl",
  "text-xl": "text-2xl",
  "text-2xl": "text-3xl",
};

// A resolved ligature occupies EXACTLY 1em (measured: `podcasts`, `rss_feed`,
// `menu_book` and `3d_rotation` all render 16px wide at font-size 16px); an
// unresolved one falls back to laying the name out as text and takes 11× that
// (`not_a_glyph` → 176px). Capping the box at 1em therefore never touches a
// real icon and contains every miss.
//
// This is the half of the guard `resolveIconGlyph` cannot do: a plausible
// typo is usually still lowercase-with-underscores (`not_a_glyph`, `podcast`
// for `podcasts`), so it passes the name pattern and reaches the font anyway.
// Knowing which of the 3896 names exist would mean shipping the list and
// keeping it in lockstep with the font; clipping the box costs nothing and
// cannot go stale. The value still looks wrong — `error-recovery.md` tells the
// agent how to fix it — but it can no longer cover the controls beside it.
const SYMBOL_CONTAINMENT = "inline-block w-[1em] overflow-hidden";

export const IconGlyph: FunctionalComponent<IconGlyphProps> = (props): VNode => {
  const sizeClass = props.sizeClass ?? DEFAULT_SIZE_CLASS;
  const glyph = resolveIconGlyph(props.icon, props.fallback ?? DEFAULT_FALLBACK);
  if (glyph.kind === "symbol") {
    return h("span", { class: ["material-symbols-outlined", SYMBOL_CONTAINMENT, sizeClass] }, glyph.name);
  }
  const labelling = props.ariaLabel ? { role: "img", "aria-label": props.ariaLabel } : { "aria-hidden": "true" };
  return h("span", { class: ["leading-none", GLYPH_SIZE_BY_ICON_SIZE[sizeClass] ?? sizeClass], ...labelling }, glyph.text);
};

IconGlyph.displayName = "IconGlyph";
// Declared so Vue routes these through `props` rather than attribute
// fallthrough. Deliberately WITHOUT runtime `default`s: a default here would
// make each prop resolve as a required `string`, so a caller holding an
// `icon?: string` (every optional schema field) would fail to type-check. The
// defaults live in the body above, once.
IconGlyph.props = {
  icon: String,
  fallback: String,
  sizeClass: String,
  ariaLabel: String,
};
