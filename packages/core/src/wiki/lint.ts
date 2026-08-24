// Pure wiki lint rules.
//
// Each rule takes plain inputs (Sets, page-entry arrays, raw file
// contents) so the whole pipeline can be unit-tested without
// filesystem fixtures. The Express route at
// `server/api/routes/wiki.ts` is a thin shell that reads the disk,
// calls these rules, formats the result. A future frontend "lint
// preview before save" would call the same functions over an
// in-memory snapshot.

import type { WikiPageEntry } from "./index-parse.js";
import { WIKI_LINK_PATTERN, parseWikiLink } from "./link.js";
import { matchWikiSlug } from "./resolve.js";
import { wikiPageStem } from "./slug.js";

/** Files on disk that aren't referenced by index.md. */
export function findOrphanPages(fileSlugs: ReadonlySet<string>, indexedSlugs: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  for (const slug of fileSlugs) {
    if (!indexedSlugs.has(slug)) {
      issues.push(`- **Orphan page**: \`${slug}.md\` exists but is missing from index.md`);
    }
  }
  return issues;
}

/** Slugs referenced by index.md that have no corresponding file. */
export function findMissingFiles(pageEntries: readonly WikiPageEntry[], fileSlugs: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  for (const entry of pageEntries) {
    if (!fileSlugs.has(entry.slug)) {
      issues.push(`- **Missing file**: index.md references \`${entry.slug}\` but the file does not exist`);
    }
  }
  return issues;
}

/** One `[[…]]` body's diagnostic, or null when the link resolves.
 *
 *  Critically: this routes through `parseWikiLink` so
 *  `[[slug|display]]` is split correctly — the lint resolves the
 *  TARGET, not the full bracket body. Pre-#1297 the lint
 *  slugified the entire content (`slug|display`), which collapsed
 *  to a slug that always missed and produced ~168 false-positive
 *  "broken link" warnings. */
function brokenLinkIssue(fileName: string, body: string, fileSlugs: ReadonlySet<string>): string | null {
  const { target } = parseWikiLink(body);
  // Empty target is its own diagnostic — `[[|display]]` or `[[]]` has
  // nothing to resolve and would otherwise be flagged identically to a
  // real broken link. Keep the original raw bracket body in the report
  // so the user can grep their pages for the malformed link.
  if (target.trim().length === 0) return `- **Broken link** in \`${fileName}\`: [[${body}]] → empty target`;
  if (matchWikiSlug(target, fileSlugs) !== null) return null;
  const stem = wikiPageStem(target) ?? target.trim();
  return `- **Broken link** in \`${fileName}\`: [[${body}]] → \`${stem}.md\` not found`;
}

/** Walk a page's body for `[[…]]` links and flag any whose target
 *  doesn't resolve to a file in the set. */
export function findBrokenLinksInPage(fileName: string, content: string, fileSlugs: ReadonlySet<string>): string[] {
  return [...content.matchAll(WIKI_LINK_PATTERN)]
    .map(([, body = ""]) => brokenLinkIssue(fileName, body, fileSlugs))
    .filter((issue): issue is string => issue !== null);
}

function formatTagList(tags: readonly string[]): string {
  return `[${[...tags].sort().join(", ")}]`;
}

/** Flag any slug whose index.md tags differ from the page's own
 *  frontmatter `tags:` field. Comparison is set-based and order-
 *  insensitive; both sides are lowercased at parse time. Slugs
 *  missing from `frontmatterTagsBySlug` are ignored here — the
 *  missing file itself is already reported by `findMissingFiles`. */
export function findTagDrift(pageEntries: readonly WikiPageEntry[], frontmatterTagsBySlug: ReadonlyMap<string, readonly string[]>): string[] {
  const issues: string[] = [];
  for (const entry of pageEntries) {
    // Lowercase on lookup — the caller keys the map with
    // lowercased slugs, so a `MyPage.md` filename still matches
    // an `entry.slug` of `mypage` produced by `wikiSlugify` on the
    // wiki-link parser path.
    const pageTags = frontmatterTagsBySlug.get(entry.slug.toLowerCase());
    if (pageTags === undefined) continue;
    const pageSet = new Set(pageTags);
    const indexSet = new Set(entry.tags);
    if (pageSet.size !== indexSet.size || [...pageSet].some((tag) => !indexSet.has(tag))) {
      issues.push(`- **Tag drift**: \`${entry.slug}.md\` frontmatter has ${formatTagList(pageTags)} but index.md has ${formatTagList(entry.tags)}`);
    }
  }
  return issues;
}

/** Render the final markdown report from the accumulated issues
 *  list. Empty input yields the "wiki is healthy" sentinel so the
 *  caller can write the same file every time without branching on
 *  presence. */
export function formatLintReport(issues: readonly string[]): string {
  if (issues.length === 0) {
    return "# Wiki Lint Report\n\n✓ No issues found. Wiki is healthy.";
  }
  const noun = `issue${issues.length !== 1 ? "s" : ""}`;
  return `# Wiki Lint Report\n\n${issues.length} ${noun} found:\n\n${issues.join("\n")}`;
}
