// What the host does when a sandboxed custom view claims the search channel
// (`mc-view-ready`). Pure so the rule is testable without a browser: the DOM
// side of it — port lifetimes, an async iframe rebuild — cannot be observed
// deterministically from a Playwright assertion, but the decision can.
//
// The host cannot identify the document occupying the frame. Anything injected
// into a view can be forwarded by that view to the page it navigates to, so no
// secret proves who is asking. The rule sidesteps identification entirely:
//
//   - The bootstrap runs before any of the view's own scripts, so the FIRST
//     claim on a freshly built frame is always the view the host installed.
//   - A LATER claim means the document changed underneath the host — a view
//     that reloaded itself, or a page it navigated to. Rather than choosing
//     whether to trust it, the host reinstalls the view it controls. Both
//     cases end with the real view in the frame.
//   - Each reinstall mints a token, so a view that reloads in a loop would
//     spend tokens forever. Past the budget the host stops reconnecting; the
//     view keeps rendering and reading data, only the search channel is gone.

/** Frame rebuilds granted between one user-initiated view change and the next. */
export const MAX_FRAME_RECLAIMS = 3;

export type SearchChannelAction =
  /** Hand this claim the channel — it is the view the host just installed. */
  | "connect"
  /** Drop the channel and rebuild the frame, replacing whoever is in it. */
  | "reinstall"
  /** Budget spent: leave the frame alone and stop relaying the search text. */
  | "giveUp";

/** Decide what a `mc-view-ready` claim earns.
 *
 *  `connected` is whether the host currently holds a port for this frame, and
 *  `reclaims` how many rebuilds it has already granted since the user last
 *  switched view or collection. */
export function decideSearchChannelClaim(connected: boolean, reclaims: number, max: number = MAX_FRAME_RECLAIMS): SearchChannelAction {
  if (!connected) return "connect";
  return reclaims < max ? "reinstall" : "giveUp";
}
