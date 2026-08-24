// The one rule for "does this `[[link]]` target name an existing page?".
// Shared by the page resolver, the lint, and the graph so the three
// cannot disagree on which files a target can reach.
//
// Pure string + lookup work; safe to import from browser bundles.

import { wikiSlugify } from "./slug.js";

/** Anything that can answer "do you hold this slug?" — the page index
 *  (`Map<slug, filename>`) and the lint's `Set<slug>` both qualify. */
export interface SlugLookup {
  has: (slug: string) => boolean;
}

/** Match a raw link target against known page slugs, returning the
 *  matched slug or null.
 *
 *  Literal first: page slugs ARE filename stems, so a non-ASCII page
 *  only ever matches its own untouched name — `wikiSlugify` strips
 *  every non-ASCII character and would reduce `不耕起栽培-カバークロップ4年計画`
 *  to `-4` (#2940). The slugified form still runs second so
 *  `[[Sakura Internet]]` keeps resolving to `sakura-internet.md`. */
export function matchWikiSlug(target: string, known: SlugLookup): string | null {
  const literal = target.trim();
  if (literal.length === 0) return null;
  if (known.has(literal)) return literal;
  const slug = wikiSlugify(literal);
  if (slug.length > 0 && known.has(slug)) return slug;
  return null;
}
