# Changelog

Newest first. Each entry corresponds to a tagged release. Written in English.

## @mulmoclaude/collection-plugin@4.3.0 — 2026-08-25

Publishes the plugin-side half of the remote-view image-budget fix (#2924, PR #2934). The change had been on `main` since 4.2.0 but was never released, so npm consumers kept the old preview caption. It surfaced during a release audit: `@mulmoclaude/collection-plugin@4.2.0` carried no git tag, so drift against the published tarball could not be measured at all. Tagging 4.2.0 retroactively revealed 9 shipped files ahead of npm — this release delivers them.

- The remote-view preview caption is localized. The image counts beside the byte figure were built from hardcoded English (`N images (M over budget)`), on the assumption that they were locale-free numerics like the byte figures next to them. That stopped being true once the caption had to name _what_ went wrong: it is a word the author reads. Both forms now go through `t()`, and `collectionsView.remoteViewPreviewImages` / `collectionsView.remoteViewPreviewImagesPlaceholders` were added to all 8 locales (de, en, es, fr, ja, ko, ptBR, zh) in lockstep.
- The caption reports "placeholders" instead of "over budget". Since #2934 an over-budget image is deferred to the next page rather than dropped, so a page returns shorter rather than with holes in it. The count now means "images this page hands back as a path" — usually unresolvable ones (missing file, undecodable source), plus the over-budget images of a first item forced through to keep paging alive. The previous wording described behaviour the engine no longer has.

The engine-side change it belongs to (ending a page when the byte budget is exhausted, instead of leaving unfitted fields as bare paths) is host code and ships through the `mulmoclaude` launcher, separately from this package.

The launcher's declared range for this package was swept to `^4.3.0` in the same commit.

📦 **npm**: [`@mulmoclaude/collection-plugin@4.3.0`](https://www.npmjs.com/package/@mulmoclaude/collection-plugin/v/4.3.0)
