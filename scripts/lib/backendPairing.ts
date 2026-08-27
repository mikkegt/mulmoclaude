// Does the backend the PROXY will reach match the backend this run started?
// (#2975, raised by Codex on iter-3/4/5)
//
// Waiting for the port is not enough, because a port does not identify who is
// on it. With an implicit `PORT` and 3001 busy, `server/index.ts` walks the NEW
// backend to 3002 while Vite keeps proxying to 3001 (#2650); both instances
// share a workspace, so the new one overwrites `.session-token` and the page
// carries a credential the instance answering on 3001 never issued. Every
// request then 401s, and nothing in the startup says why.
//
// Two earlier attempts at this check were wrong in instructive ways:
//
//   1. Inferring ownership from timing ("the port answered on the first probe,
//      so it cannot be the process we just spawned"). Codex was right that
//      process ordering carries no guarantee.
//   2. Asking the listener to validate the session token. That establishes the
//      pairing, but it hands a live bearer credential to a process we have not
//      identified — on a shared machine, another user can bind the port first.
//
// Neither is needed, because the backend ALREADY publishes the port it actually
// bound: `server/index.ts` writes `<workspace>/.server-port` right after
// `app.listen` precisely because "the requested PORT may have walked forward off
// a busy default". Comparing that number against the port Vite will proxy to is
// the invariant itself — no inference about who started first, and no secret
// leaves this process.
//
// `.server-port` is NOT removed on shutdown, so a stale one outlives its writer.
// That is what `wasRepublished` is for: only a file this run rewrote can speak
// for this run.

export interface FileSnapshot {
  exists: boolean;
  /** Meaningless when `exists` is false. */
  mtimeMs: number;
}

/** Did the backend this run started publish its port, rather than us reading
 *  one left behind by an earlier instance? mtime rather than content, because
 *  a restart that lands on the same port writes the same bytes — the write is
 *  what marks the file as speaking for this run. */
export function wasRepublished(before: FileSnapshot, after: FileSnapshot): boolean {
  if (!after.exists) return false;
  if (!before.exists) return true;
  return after.mtimeMs !== before.mtimeMs;
}

export type Pairing = "paired" | "mismatch" | "unknown";

/**
 * Compare the port the backend actually bound against the one Vite will target.
 *
 * `unknown` for anything unreadable — an empty file, a partial write, a build
 * too old to publish the port at all. Refusing to start on "cannot tell" would
 * be worse than the race this exists for, so only a number that plainly
 * disagrees counts as a mismatch.
 */
export function classifyBoundPort(raw: string | null, proxyTarget: number): Pairing {
  if (raw === null) return "unknown";
  const bound = Number(raw.trim());
  if (!Number.isInteger(bound) || bound <= 0) return "unknown";
  return bound === proxyTarget ? "paired" : "mismatch";
}
