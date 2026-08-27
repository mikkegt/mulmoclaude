// Does the token the PAGE will be handed belong to the backend the PROXY will
// reach? (#2975 iter-3/4)
//
// Waiting for the port is not enough, because a port does not identify who is
// on it. With an implicit `PORT` and 3001 busy, `server/index.ts` walks the NEW
// backend to 3002 while Vite keeps proxying to 3001 (#2650); both instances
// share a workspace, so the new one overwrites `.session-token` and the page
// carries a credential the instance answering on 3001 never issued. Every
// request then 401s, and nothing in the startup says why.
//
// The first version of this check guessed ownership from timing ("the port
// answered on the first probe, so it cannot be the process we just spawned").
// Codex was right that a probe count cannot establish ownership — process
// ordering has no guarantee. So nothing here guesses. Instead:
//
//   1. The backend writes its token BEFORE it listens (`server/index.ts`, one
//      linear async IIFE). So if the port answers and the token has NOT been
//      rewritten since this run began, the listener is somebody else's.
//      A genuinely fast backend is not a false positive: its own write already
//      happened, so the rewrite is observed and the check passes at once.
//   2. When the token is finally rewritten, ask the instance actually on the
//      port whether it accepts that token. Its answer is the proof — no
//      inference about who started first.
//
// `MULMOCLAUDE_AUTH_TOKEN` pins one token across instances, and the health
// answer reports that correctly as paired: the pairing is what matters, not
// which process is which.

export interface TokenSnapshot {
  exists: boolean;
  /** Meaningless when `exists` is false. */
  mtimeMs: number;
}

/**
 * Did the backend this run started write its own session token?
 *
 * mtime rather than content, because `MULMOCLAUDE_AUTH_TOKEN` makes a restart
 * write the SAME bytes — the write still happened, and it is the write that
 * marks our backend as having reached its startup.
 */
export function tokenWasRewritten(before: TokenSnapshot, after: TokenSnapshot): boolean {
  if (!after.exists) return false;
  if (!before.exists) return true;
  return after.mtimeMs !== before.mtimeMs;
}

export type Pairing = "paired" | "mismatch" | "unproven";

/**
 * What the backend on the proxy target said when handed the token the page
 * will get. `null` means it could not be asked at all (connection died,
 * malformed reply) — which proves nothing either way, so it must not be
 * reported as a mismatch.
 */
export function classifyPairing(healthStatus: number | null): Pairing {
  if (healthStatus === null) return "unproven";
  if (healthStatus === 200) return "paired";
  // The bearer guard's own answers. Anything else (500, 404 on an older
  // build, a redirect) says something is odd but not that the credential
  // was rejected, and refusing to start on "odd" would be worse than the
  // race this check exists for.
  if (healthStatus === 401 || healthStatus === 403) return "mismatch";
  return "unproven";
}
