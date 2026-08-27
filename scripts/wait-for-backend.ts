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
import { classifyBoundPort, decideReadiness, wasRepublished, type FileSnapshot } from "./lib/backendPairing.js";
import { describeRejection, resolveServerPort } from "./lib/devServerPort.js";
import { waitForPort } from "./lib/waitForPort.js";
import { parseEnvFile } from "../server/utils/launch-env.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

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
 * Gather the evidence about who holds the proxy target.
 *
 * `attributable` means `--reset` cleared the file before either pane started,
 * so whatever is there now was written by this startup even if it landed before
 * the snapshot. Without it, a backend that wins the process-start race and
 * publishes the CORRECT port early would be waited out for the whole settle
 * window and then reported unconfirmed — a ~10s delay on a healthy start, which
 * is the opposite of what a readiness check is for (Codex, iter-8).
 *
 * The shortcut applies only when the file is ALREADY there: in the ordinary
 * case `--reset` has just removed it and the publish is still seconds away, so
 * shortcutting then would read an absent file and call the startup unreadable.
 */
async function attributedPort(
  portFile: string,
  before: FileSnapshot,
  deadlineAt: number,
  attributable: boolean,
): Promise<{ raw: string | null; attributed: boolean }> {
  const alreadyPublished = attributable && snapshotFile(portFile).exists;
  const attributed = alreadyPublished || (await awaitRepublish(portFile, before, deadlineAt));
  return { raw: readTextOrNull(portFile), attributed };
}

/** Compare the port the backend actually bound against the one Vite will target. */
async function verifyProxyTarget(proxyTarget: number, portFile: string, before: FileSnapshot, deadlineAt: number, attributable: boolean): Promise<void> {
  const { raw, attributed } = await attributedPort(portFile, before, deadlineAt, attributable);
  switch (decideReadiness(classifyBoundPort(raw, proxyTarget), attributed)) {
    case "refuse":
      reportMismatch(proxyTarget, raw ?? "");
      return;
    case "ready":
      log(`backend ready on :${proxyTarget}`);
      return;
    case "unconfirmed":
      log(`could not confirm which backend holds :${proxyTarget} — this startup published no port within ${seconds(PAIRING_SETTLE_MS)}. Starting Vite anyway.`);
      return;
    default:
      log(`backend is up but did not publish a readable port — starting Vite against :${proxyTarget}.`);
  }
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
    const marker = resetMarkerPath(portFile);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, String(Date.now()));
  } catch (err) {
    log(`could not clear ${portFile}: ${String(err)} — the readiness check may report an older run's port.`);
  }
}

// The reset happens in its own process, before either pane exists, so the fact
// that it happened has to survive to the waiter somehow.
//
// Under `node_modules/.cache`, NOT the temp dir. The path is derived from the
// workspace, so it is fully predictable — and a predictable name in a
// world-writable directory is a symlink waiting to happen: anyone with an
// account on the machine can pre-create `/tmp/<that name>` pointing at a file
// of yours, and this write would follow it and clobber that file (CodeRabbit,
// iter-9; /tmp's sticky bit stops deletions, not plants). A directory only you
// can write removes the opening rather than racing it.
//
// Not the workspace either: this is coordination between two processes of one
// `yarn dev`, not user data, and `.server-port`'s own contract (a live server's
// address, read by the wiki-write hook) stays untouched. Keyed by the port file
// so two workspaces driven from one checkout cannot borrow each other's.
function resetMarkerPath(portFile: string): string {
  const digest = createHash("sha256").update(portFile).digest("hex").slice(0, 16);
  return path.join(REPO_ROOT, "node_modules", ".cache", "mulmoclaude", `dev-reset-${digest}`);
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

/** Block until something accepts on `port`, narrating a slow boot. */
function awaitListener(port: number, timeoutMs: number): Promise<{ ready: boolean; waitedMs: number; probes: number }> {
  return waitForPort({
    port,
    timeoutMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    probe: probeTcp,
    now: () => Date.now(),
    sleep,
    noticeEveryMs: NOTICE_EVERY_MS,
    onWaiting: (elapsedMs) => log(`still waiting for the backend on :${port} (${seconds(elapsedMs)})`),
  });
}

/**
 * Starting Vite after the wait times out is deliberate: that is what shipped
 * before this wait existed, so the worst case is the old behaviour plus a line
 * saying what to expect.
 */
function reportTimeout(port: number, waitedMs: number): void {
  log(
    `backend still not listening on :${port} after ${seconds(waitedMs)} — starting Vite anyway. ` +
      `Expect "Can't reach the backend" in the UI until it comes up; reload once it does so the page picks up the auth token. ` +
      `Set MULMOCLAUDE_DEV_WAIT_MS to wait longer.`,
  );
}

/**
 * `PORT=0` leaves the backend on an OS-assigned port that nothing here can
 * name. Vite's own `assertProxyablePort` refuses to start for it with the
 * reason spelled out — waiting first would just delay that message by a minute
 * of silence.
 */
function refuseUnknowablePort(resolution: ReturnType<typeof resolveServerPort>): boolean {
  const unknowable = resolution.problems.find((problem) => problem.reason === "ephemeral");
  if (!unknowable) return false;
  log(`not waiting — ${unknowable.source}="${unknowable.raw}": ${describeRejection(unknowable.reason)}`);
  return true;
}

async function main(): Promise<void> {
  // The same resolution Vite's proxy target uses, from the same inputs. A
  // second opinion about `PORT` here would be #2650 one level down: the
  // wait would watch one port while the proxy addressed another.
  const envFileValues = parseEnvFile(path.join(process.cwd(), ".env")).parsed;
  const portFile = resolveServerPortPath(envFileValues ?? {});

  if (process.argv.includes("--reset")) {
    reset(portFile);
    return;
  }

  const resolution = resolveServerPort({ processEnv: process.env, envFileValues });
  if (refuseUnknowablePort(resolution)) return;

  const { port } = resolution;
  const timeoutMs = resolveTimeoutMs(process.env.MULMOCLAUDE_DEV_WAIT_MS);
  const startedAt = Date.now();
  const attributable = consumeResetMarker(portFile);
  const before = snapshotFile(portFile);

  const result = await awaitListener(port, timeoutMs);
  if (!result.ready) {
    reportTimeout(port, result.waitedMs);
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
