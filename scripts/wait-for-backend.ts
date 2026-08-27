#!/usr/bin/env tsx
// `yarn dev`'s client half waits here before starting Vite (#2975).
//
// Why this exists rather than a fixed sleep: see `scripts/lib/waitForPort.ts`.
// Why waiting for the port is not on its own enough: see
// `scripts/lib/backendPairing.ts`. This file is the wiring — resolve the port,
// probe it, establish the pairing, report — and holds no policy of its own.
import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { classifyBoundPort, wasRepublished, type FileSnapshot, type Pairing } from "./lib/backendPairing.js";
import { describeRejection, resolveServerPort } from "./lib/devServerPort.js";
import { waitForPort } from "./lib/waitForPort.js";
import { parseEnvFile } from "../server/utils/launch-env.mjs";

const POLL_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 1000;
const NOTICE_EVERY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;
// How long to keep looking for this startup's own `.server-port` once the proxy
// target turns out to be held by someone. Boot-to-publish measured ~3.7s here,
// so this leaves headroom for a cold Windows boot; past it we say we could not
// confirm rather than stalling the dev server or guessing. Only reachable when
// `--reset` did not run (a waiter invoked on its own) — under `yarn dev` the
// marker settles it without waiting.
const PAIRING_SETTLE_MS = 10_000;
// A `--reset` marker older than this cannot be describing the startup happening
// now — generous enough for the slowest cold boot, short enough that a marker
// orphaned by a crashed run does not mislead tomorrow's.
const RESET_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

// Long enough for a cold `tsx` boot on a Windows machine with a virus
// scanner in the path — the case this was written for. Overridable because
// "long enough" is a property of the machine, not of the code.
function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

// Mirrors `WORKSPACE_PATHS.serverPort`, resolved the way `vite.config.ts`
// resolves the workspace — the backend writes the port it actually bound there
// right after `app.listen`.
//
// An EMPTY value counts as unset, at both sources. The server reads this with
// `||`, and `vite.config.ts`'s regex needs `(.+)`, so neither of them can end
// up with `""` — and `path.join("", ".server-port")` would silently point this
// check at the current directory instead of the workspace, where it would find
// nothing and report every startup as unattributable (CodeRabbit, iter-5).
const nonEmpty = (value: string | undefined): value is string => value !== undefined && value.length > 0;

function resolveServerPortPath(envFileValues: Record<string, string>): string {
  const fromProcess = process.env.MULMOCLAUDE_WORKSPACE_PATH;
  const fromFile = envFileValues.MULMOCLAUDE_WORKSPACE_PATH;
  const workspace = nonEmpty(fromProcess) ? fromProcess : nonEmpty(fromFile) ? fromFile : path.join(os.homedir(), "mulmoclaude");
  return path.join(workspace, ".server-port");
}

function snapshotFile(filePath: string): FileSnapshot {
  try {
    return { exists: true, mtimeMs: fs.statSync(filePath).mtimeMs };
  } catch {
    return { exists: false, mtimeMs: 0 };
  }
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// A bare TCP connect, not a request: readiness must not depend on the bearer
// token, whose absence is half of what this wait exists to prevent.
function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
  });
}

const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

function log(msg: string): void {
  console.log(`[wait-for-backend] ${msg}`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Poll until our backend has published the port it bound, or the budget runs out. */
async function awaitRepublish(portFile: string, before: FileSnapshot, deadlineAt: number): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    if (wasRepublished(before, snapshotFile(portFile))) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function reportMismatch(proxyTarget: number, boundPort: string): void {
  log(
    `REFUSING to start Vite: the backend started here bound port ${boundPort.trim()}, but Vite proxies to :${proxyTarget}. ` +
      `:${proxyTarget} was busy, so the backend walked forward (see its own "Port ${proxyTarget} busy" line) while the dev client stayed pointed here. ` +
      `The page would be served this run's session token and then 401 on every request against whatever else holds :${proxyTarget}, with nothing saying why (#2650). ` +
      `Stop the other instance, or set PORT to run a second one.`,
  );
  process.exitCode = 1;
}

/**
 * Compare the port the backend actually bound against the one Vite will target.
 *
 * Every ready result comes through here — there is no fast path that skips it.
 * Codex's iter-5 finding was precisely that a fast path can pair this run's
 * token with an older listener whenever the two writes interleave, so the check
 * has to be unconditional rather than reserved for the suspicious case.
 */
async function verifyProxyTarget(proxyTarget: number, portFile: string, before: FileSnapshot, deadlineAt: number, attributable: boolean): Promise<void> {
  // `attributable` means `--reset` cleared the file before either pane started,
  // so whatever is there now was written by this startup — even if it landed
  // before the snapshot. Without it, a backend that wins the process-start race
  // and publishes the CORRECT port early would be waited out for the whole
  // settle window and then reported unconfirmed: a ~10s delay on a healthy
  // start, which is the opposite of what a readiness check is for (Codex,
  // iter-8).
  //
  // Only when the file is ALREADY there, though: in the ordinary case `--reset`
  // has just removed it, and the publish is still seconds away — shortcutting
  // then would read an absent file and call the startup unreadable.
  const alreadyPublished = attributable && snapshotFile(portFile).exists;
  const republished = alreadyPublished || (await awaitRepublish(portFile, before, deadlineAt));
  const raw = readTextOrNull(portFile);
  const pairing: Pairing = classifyBoundPort(raw, proxyTarget);

  // A readable disagreement is refused whether or not this run wrote the file.
  //
  // Both reviewers arrived at this independently on iter-6, and the reason is
  // that `wasRepublished` cannot see a publish that PRECEDES the snapshot: the
  // two dev panes start concurrently with no ordering guarantee, so a slow
  // client pane can snapshot a `.server-port` this very run already wrote. That
  // is not a leftover — it is the mismatch — and warning about it started Vite
  // into the broken session anyway.
  //
  // Refusing on an unattributed mismatch cannot misfire on a healthy startup,
  // because reaching here means something already holds the proxy target: if it
  // is our own backend, its port write follows `app.listen` by milliseconds and
  // the poll above sees it (paired); if it is not, our backend must have walked
  // elsewhere, which is exactly the case being refused.
  if (pairing === "mismatch" && raw !== null) {
    reportMismatch(proxyTarget, raw);
    return;
  }

  // A MATCHING value proves nothing on its own (Codex, iter-7): an older
  // backend holding :3001 leaves `.server-port` reading 3001, and this run's
  // backend writes its new session token before it ever reaches `app.listen`.
  // Accepting the match there would hand Vite the new token pointed at the old
  // listener — the same 401 by the opposite route.
  //
  // Under `yarn dev` this branch is unreachable, because `--reset` clears the
  // file before either pane starts, so any file at all is this run's. It stays
  // for a waiter invoked on its own, where that guarantee does not hold.
  if (!republished) {
    log(`could not confirm which backend holds :${proxyTarget} — this startup published no port within ${seconds(PAIRING_SETTLE_MS)}. Starting Vite anyway.`);
    return;
  }
  if (pairing === "paired") {
    log(`backend ready on :${proxyTarget}`);
    return;
  }
  log(`backend is up but did not publish a readable port — starting Vite against :${proxyTarget}.`);
}

/**
 * `--reset`: clear `.server-port` BEFORE either dev pane starts.
 *
 * This is what makes the rest of the check decidable, and it is why the loop of
 * "is this file from our run?" special cases ended here. `.server-port` is not
 * deleted on shutdown, and the two dev panes start concurrently with no ordering
 * guarantee — so a file already on disk when the waiter snapshots it might be a
 * leftover from a dead run OR this run's own publish, and those two demand
 * opposite verdicts. No amount of mtime reasoning separates them.
 *
 * Clearing it first removes the ambiguity at the source: afterwards, a
 * `.server-port` that exists was written by this startup, full stop.
 *
 * Safe to delete: it only ever addresses a live server, so it is meaningless
 * once that server is gone. An instance still running in this same workspace
 * would lose its hook's address — but two instances sharing a workspace already
 * overwrite each other's `.session-token`, which is the very breakage being
 * detected here. Instances in different workspaces have different files.
 */
function reset(portFile: string): void {
  try {
    fs.rmSync(portFile, { force: true });
    fs.writeFileSync(resetMarkerPath(portFile), String(Date.now()));
  } catch (err) {
    log(`could not clear ${portFile}: ${String(err)} — the readiness check may report an older run's port.`);
  }
}

// The reset happens in its own process, before either pane exists, so the fact
// that it happened has to survive to the waiter somehow. A marker in the temp
// dir rather than the workspace: this is coordination between two processes of
// one `yarn dev`, not user data, and it keeps `.server-port`'s own contract (a
// live server's address, read by the wiki-write hook) untouched. Keyed by the
// port file so two workspaces cannot borrow each other's.
function resetMarkerPath(portFile: string): string {
  const digest = createHash("sha256").update(portFile).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `mulmoclaude-dev-reset-${digest}`);
}

/**
 * Read and remove the marker: did THIS startup clear the port file?
 *
 * Consumed rather than merely read, so a marker left behind by a `yarn dev`
 * that died between the reset and the waiter cannot make some later standalone
 * invocation trust a stale file. The age check is the second half of that —
 * a marker older than a startup could plausibly take never speaks for now.
 */
function consumeResetMarker(portFile: string): boolean {
  const marker = resetMarkerPath(portFile);
  const raw = readTextOrNull(marker);
  fs.rmSync(marker, { force: true });
  if (raw === null) return false;
  const stampedAt = Number(raw.trim());
  if (!Number.isFinite(stampedAt)) return false;
  const age = Date.now() - stampedAt;
  return age >= 0 && age <= RESET_MARKER_MAX_AGE_MS;
}

async function main(): Promise<void> {
  // The same resolution Vite's proxy target uses, from the same inputs. A
  // second opinion about `PORT` here would be #2650 one level down: the
  // wait would watch one port while the proxy addressed another.
  const envFileValues = parseEnvFile(path.join(process.cwd(), ".env")).parsed;
  const resolution = resolveServerPort({ processEnv: process.env, envFileValues });

  if (process.argv.includes("--reset")) {
    reset(resolveServerPortPath(envFileValues ?? {}));
    return;
  }

  // `PORT=0` leaves the backend on an OS-assigned port that nothing here can
  // name. Vite's own `assertProxyablePort` refuses to start for it with the
  // reason spelled out — waiting first would just delay that message by a
  // minute of silence.
  const unknowable = resolution.problems.find((problem) => problem.reason === "ephemeral");
  if (unknowable) {
    log(`not waiting — ${unknowable.source}="${unknowable.raw}": ${describeRejection(unknowable.reason)}`);
    return;
  }

  const { port } = resolution;
  const timeoutMs = resolveTimeoutMs(process.env.MULMOCLAUDE_DEV_WAIT_MS);
  const startedAt = Date.now();
  const portFile = resolveServerPortPath(envFileValues ?? {});
  const attributable = consumeResetMarker(portFile);
  const before = snapshotFile(portFile);

  const result = await waitForPort({
    port,
    timeoutMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    probe: probeTcp,
    now: () => Date.now(),
    sleep,
    noticeEveryMs: NOTICE_EVERY_MS,
    onWaiting: (elapsedMs) => log(`still waiting for the backend on :${port} (${seconds(elapsedMs)})`),
  });

  if (!result.ready) {
    // Starting Vite anyway is deliberate: that is what shipped before this
    // wait existed, so the worst case is the old behaviour plus a line saying
    // what to expect.
    log(
      `backend still not listening on :${port} after ${seconds(result.waitedMs)} — starting Vite anyway. ` +
        `Expect "Can't reach the backend" in the UI until it comes up; reload once it does so the page picks up the auth token. ` +
        `Set MULMOCLAUDE_DEV_WAIT_MS to wait longer.`,
    );
    return;
  }

  // The port answering says something is there; it does not say it is ours.
  // `.server-port` — which the backend writes with the port it ACTUALLY bound,
  // right after listening — is what settles that.
  await verifyProxyTarget(port, portFile, before, Math.min(startedAt + timeoutMs, Date.now() + PAIRING_SETTLE_MS), attributable);
}

// Exit 0 on anything unexpected — `yarn dev` chains this with `&& vite`, and a
// non-zero exit over a wait bug would take the client pane down. The one
// deliberate non-zero is `reportMismatch`, where starting Vite is known to
// produce a broken session.
main().catch((err: unknown) => {
  log(`wait failed, starting Vite anyway: ${String(err)}`);
});
