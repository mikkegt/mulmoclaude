// The host's answer to a custom view's `mc-view-ready` claim (#2959, #2963).
// The rule is pure so it can be pinned exhaustively here: its effects — a port
// closing, an async iframe rebuild — cannot be observed deterministically from
// a browser assertion, because the probe that orders messages within one
// document cannot order across a frame swap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideSearchChannelClaim, MAX_FRAME_RECLAIMS } from "../../../packages/plugins/collection-plugin/src/vue/searchChannelPolicy.js";

describe("decideSearchChannelClaim", () => {
  it("hands the channel to the first claim on a fresh frame", () => {
    // The bootstrap runs before the view's own scripts, so this is always the
    // view the host just installed — whatever the reclaim count.
    assert.equal(decideSearchChannelClaim(false, 0), "connect");
    assert.equal(decideSearchChannelClaim(false, MAX_FRAME_RECLAIMS), "connect");
    assert.equal(decideSearchChannelClaim(false, 1_000), "connect");
  });

  it("answers a later claim by reinstalling the view, never by handing it over", () => {
    // A second claim means the document changed underneath the host. It cannot
    // tell a self-reload from a page the view navigated to, so it rebuilds the
    // frame instead of choosing. Crucially: never "connect".
    for (let reclaims = 0; reclaims < MAX_FRAME_RECLAIMS; reclaims++) {
      assert.equal(decideSearchChannelClaim(true, reclaims), "reinstall");
    }
  });

  it("stops reconnecting once the rebuild budget is spent", () => {
    // Each rebuild mints a token, so a view reloading in a loop must not be
    // able to spend them forever.
    assert.equal(decideSearchChannelClaim(true, MAX_FRAME_RECLAIMS), "giveUp");
    assert.equal(decideSearchChannelClaim(true, MAX_FRAME_RECLAIMS + 1), "giveUp");
    assert.equal(decideSearchChannelClaim(true, Number.MAX_SAFE_INTEGER), "giveUp");
  });

  it("grants exactly MAX_FRAME_RECLAIMS rebuilds, counting from zero", () => {
    // The off-by-one that would either waste a rebuild or grant one too many.
    const granted = Array.from({ length: MAX_FRAME_RECLAIMS + 3 }, (_, reclaims) => decideSearchChannelClaim(true, reclaims)).filter(
      (action) => action === "reinstall",
    ).length;
    assert.equal(granted, MAX_FRAME_RECLAIMS);
  });

  it("never returns connect for a claim on an already-connected frame", () => {
    // The security property, stated as its own case: whatever the count, a
    // later claimant is never given the user's search text.
    const actions = Array.from({ length: 50 }, (_, reclaims) => decideSearchChannelClaim(true, reclaims));
    assert.ok(!actions.includes("connect"), "a re-claim must never be handed the channel");
  });

  it("keeps the budget at the number the authoring docs promise", () => {
    // `custom-view.md` tells view authors "at most 3". Changing the constant
    // without changing that sentence would make the contract a lie, and every
    // other test here is written against the symbol, so nothing else notices.
    assert.equal(MAX_FRAME_RECLAIMS, 3);
  });

  it("honours an injected budget, including a zero that disables reconnecting", () => {
    assert.equal(decideSearchChannelClaim(true, 0, 0), "giveUp");
    assert.equal(decideSearchChannelClaim(true, 0, 1), "reinstall");
    assert.equal(decideSearchChannelClaim(true, 1, 1), "giveUp");
    // A fresh frame still connects even when reconnecting is disabled.
    assert.equal(decideSearchChannelClaim(false, 0, 0), "connect");
  });
});
