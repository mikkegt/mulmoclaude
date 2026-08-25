# Plan: relay the standard table's search box into custom views (#2959)

Give a sandboxed custom collection view read access to what the user typed in
the **standard table view's search box**, so a collection with a custom search
view needs only **one** search box on screen.

Issue: https://github.com/receptron/mulmoclaude/issues/2959

---

## 1. Today's behaviour (the gap)

The search box and the custom view are on screen **at the same time** but share
nothing:

- The query lives in a single ref, `CollectionView.vue:534` (`searchQuery`),
  and drives only `filteredItems` → the table / calendar / kanban bodies.
- `CollectionToolbar` renders while a custom view is active
  (`CollectionView.vue:47` — the `v-if` includes `hasCustomViews`), so the box
  is visible and typing into it does nothing the user can see.
- The iframe is `sandbox="allow-scripts …"` with **no** `allow-same-origin`, so
  it cannot read the parent at all. `window.__MC_VIEW` exposes `slug`, `token`,
  `dataUrl`, `origin`, `onChange`, `openItem`, `startChat`, `t` — no query.

What already exists and is the right rail to build on: the **host → iframe
postMessage relay** for live updates. `CollectionCustomView.vue:159`
(`relayChange`) posts `{ type: "mc-collection-changed", slug }`; the injected
bootstrap (`src/utils/html/customViewSrcdoc.ts:52`) validates
`e.source === window.parent` + `d.slug === v.slug`, debounces, and fires
`onChange` callbacks.

## 2. Decisions

**D1 — one direction only (host → view).** The host's box stays visible while a
custom view renders, so relaying downward fully solves the report. The reverse
(view writes the host's box) would need echo-loop guards, can fight a fast
typist's cursor across an async hop, and adds a new class of message: today's
`mc-open-item` / `mc-start-chat` are *user-gesture proposals*, not silent
mutations of host UI state. A view that wants its own input keeps it local.

**D2 — the initial value travels by postMessage, never in the srcdoc.** The
srcdoc is built only inside `load()` (`CollectionCustomView.vue`), which
re-mints a scoped token and reloads the iframe. Baking `searchQuery` into the
boot JSON would mean a token mint + full iframe reload **per keystroke**. So the
boot JSON always carries `searchQuery: ""` and the host pushes the live value.

**D3 — push once on iframe `load`, then on every change.** A message posted
before the bootstrap has parsed is lost, so the relay hooks the iframe's `load`
event as well as the watcher. The load-time push is skipped for an empty query
(nothing to say), which also keeps a freshly-opened view from taking a spurious
callback.

**D4 — `v.searchQuery` updates immediately; callbacks are debounced (150 ms).**
Same contract as `onChange` ("already debounced — don't add your own throttle"),
but a view that re-reads `v.searchQuery` during its own render always sees the
newest value. The callback also *receives* the query as its argument, so the
common case is a one-liner.

**D5 — hide the toolbar's match count while a custom view is active.**
`CollectionToolbar.vue:214` shows `shown / total` computed from
`itemMatchesQuery` (`packages/core/src/collection/core/textSearch.ts:17`), a
substring match over an item's **scalar** fields only — object/array fields are
skipped. A custom search view typically matches more (show notes, keyword
arrays, nested records), so once the two boxes are linked the host's count and
the view's visible hit count disagree in front of the user. Today nobody expects
them to relate; syncing makes the mismatch read as a bug. The count is also
already meaningless for a custom view (the iframe fetches its own unfiltered
data), so hiding it loses nothing.

**D6 — desktop custom views only; mobile/remote views are out of scope.**
`CollectionRemoteViewPreview` must mirror the phone's capabilities *exactly*
("preview capability must equal phone capability", plans/done/feat-remote-custom-view.md
decision 5), and the phone parent has no search box. Adding the channel to the
preview alone would break that invariant.

## 3. Changes

| File | Change |
| --- | --- |
| `src/utils/html/customViewSrcdoc.ts` | boot JSON gains `searchQuery: ""`; bootstrap gains an `mc-search-query` listener + `v.onSearchQueryChange(cb)` |
| `packages/plugins/collection-plugin/src/vue/components/CollectionCustomView.vue` | new `searchQuery` prop; relay on change (deduped) and on iframe `load` |
| `packages/plugins/collection-plugin/src/vue/components/CollectionView.vue` | pass `:search-query="searchQuery"` to `CollectionCustomView` |
| `packages/plugins/collection-plugin/src/vue/components/CollectionToolbar.vue` | hide the `shown / total` count when a `custom:` view is active (D5) |
| `packages/core/assets/helps/custom-view.md` | document the contract + a worked example |
| `test/utils/html/test_customViewSrcdoc.ts` | shape assertions + behavioural tests that run the bootstrap in `node:vm` |

## 4. Scoping — it closes per collection, for free

`searchQuery` is a single ref reset to `""` on collection load
(`CollectionView.vue:744`) and on slug clear (`:1570`), and is **not**
persisted to localStorage (unlike view mode / sort / flag filters). So the
relayed value is per-collection and per-session by construction; nothing new to
reset. `refreshItemsInPlace` deliberately *keeps* it (`:798`) so a pub/sub
update doesn't wipe what the user is typing — and it doesn't remount the
iframe, so the relay must survive a live data refresh (postMessage does).

The iframe-side handler validates `d.slug === v.slug` exactly like
`mc-collection-changed`, so a message in flight across a collection switch
cannot land in the next view.

## 5. Verification

- `yarn format` → `yarn lint` → `yarn typecheck` → `yarn build` → `yarn test`.
- Bootstrap behaviour is unit-tested by evaluating the injected script in
  `node:vm` against a fake `window`/`document` — foreign slug ignored,
  non-parent source ignored, debounce collapses a burst, unsubscribe works,
  `v.searchQuery` tracks immediately.
- Manual: a collection with a custom view — type in the standard box, confirm
  the view reacts; switch collections and confirm the query clears.
