// Unit tests for the pure shortcut refresh rule
// (src/composables/shortcutRefresh.ts).
//
// The case that matters is REMOVAL. Patching the persisted entry (`{...entry,
// ...fresh}`) keeps a field the live row has dropped, so a removed accent
// colour survived the refresh, stayed on disk, and made `hasShortcutDrifted`
// true again on the very next reconcile — rewriting the file on every index
// visit, forever (#2987). Every "does it update" assertion passed throughout.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { hasShortcutDrifted, refreshShortcut, type ShortcutRefreshSource } from "../../src/composables/shortcutRefresh";
import type { Shortcut } from "../../src/types/shortcuts";

const pinned: Shortcut = { kind: "collection", slug: "podcasts", title: "Podcasts", icon: "podcasts", color: "violet" };

describe("refreshShortcut", () => {
  it("keeps the pin's own identity and takes every index-owned field from the row", () => {
    const fresh: ShortcutRefreshSource = { title: "Renamed", icon: "rss_feed", color: "sky" };
    assert.deepEqual(refreshShortcut(pinned, fresh), { kind: "collection", slug: "podcasts", title: "Renamed", icon: "rss_feed", color: "sky" });
  });

  it("DROPS a colour the live row no longer carries", () => {
    const fresh: ShortcutRefreshSource = { title: "Podcasts", icon: "podcasts" };
    const refreshed = refreshShortcut(pinned, fresh);
    assert.equal("color" in refreshed, false);
    assert.equal(JSON.stringify(refreshed).includes("color"), false);
  });

  it("settles after one refresh — the rewrite loop closes", () => {
    // The actual defect: refresh, then ask whether it still disagrees. A patch
    // that carries the stale colour answers "yes" forever.
    const fresh: ShortcutRefreshSource = { title: "Podcasts", icon: "podcasts" };
    const refreshed = refreshShortcut(pinned, fresh);
    assert.equal(hasShortcutDrifted(refreshed, fresh), false);
  });

  it("settles for every kind of change, not just removal", () => {
    const rows: ShortcutRefreshSource[] = [
      { title: "Podcasts", icon: "podcasts", color: "violet" },
      { title: "Renamed", icon: "podcasts", color: "violet" },
      { title: "Podcasts", icon: "rss_feed", color: "violet" },
      { title: "Podcasts", icon: "podcasts", color: "teal" },
      { title: "Podcasts", icon: "podcasts" },
      { title: "New", icon: "inbox" },
    ];
    rows.forEach((fresh) => {
      assert.equal(hasShortcutDrifted(refreshShortcut(pinned, fresh), fresh), false, JSON.stringify(fresh));
    });
  });

  it("adds a colour to a shortcut that had none", () => {
    const plain: Shortcut = { kind: "feed", slug: "news", title: "News", icon: "rss_feed" };
    assert.deepEqual(refreshShortcut(plain, { title: "News", icon: "rss_feed", color: "lime" }), {
      kind: "feed",
      slug: "news",
      title: "News",
      icon: "rss_feed",
      color: "lime",
    });
  });
});

describe("hasShortcutDrifted", () => {
  it("is false when the row agrees with what is pinned", () => {
    assert.equal(hasShortcutDrifted(pinned, { title: "Podcasts", icon: "podcasts", color: "violet" }), false);
  });

  it("notices a removed colour", () => {
    assert.equal(hasShortcutDrifted(pinned, { title: "Podcasts", icon: "podcasts" }), true);
  });

  it("notices an added colour", () => {
    const plain: Shortcut = { kind: "feed", slug: "news", title: "News", icon: "rss_feed" };
    assert.equal(hasShortcutDrifted(plain, { title: "News", icon: "rss_feed", color: "lime" }), true);
  });

  it("notices a changed title, icon or colour", () => {
    assert.equal(hasShortcutDrifted(pinned, { title: "Other", icon: "podcasts", color: "violet" }), true);
    assert.equal(hasShortcutDrifted(pinned, { title: "Podcasts", icon: "inbox", color: "violet" }), true);
    assert.equal(hasShortcutDrifted(pinned, { title: "Podcasts", icon: "podcasts", color: "teal" }), true);
  });
});
