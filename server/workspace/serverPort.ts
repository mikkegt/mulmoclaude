// Publishing the port the server actually bound (#2650 / #2981).
//
// `<workspace>/.server-port` is how everything outside this process learns where
// the server is: the PostToolUse hook dispatcher addresses it, and `yarn dev`'s
// client half reads it to point Vite's proxy at the port the server got rather
// than the one it was asked for.
//
// **Atomically**, which it did not used to be. The original write was a plain
// `writeFile` with a comment explaining that "the .tmp dance serves no purpose
// for a single-process write at boot" — true while nothing read the file during
// startup, and false the moment the dev client began reading it to decide where
// to proxy. `writeFile` opens with `O_TRUNC`, so a reader arriving between the
// truncate and the write sees an EMPTY file, and one arriving mid-write can see
// a PREFIX: `3002` truncated to `300` parses as a perfectly valid port that
// nothing is listening on. A rename cannot be observed half-done, so the reader
// sees either the old contents or the new ones and never a state in between.
import { writeFileAtomic } from "../utils/files/index.js";
import { WORKSPACE_PATHS } from "./paths.js";

/** Trailing newline so `cat .server-port` reads cleanly in a shell hook. */
export function formatServerPort(port: number): string {
  return `${port}\n`;
}

/**
 * @param portPath Injected by tests; production callers take the default.
 */
export async function publishServerPort(port: number, portPath: string = WORKSPACE_PATHS.serverPort): Promise<void> {
  await writeFileAtomic(portPath, formatServerPort(port), { mode: 0o600 });
}
