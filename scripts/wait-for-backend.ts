#!/usr/bin/env tsx
// `yarn dev`'s client half waits here before starting Vite (#2975).
//
// Why this exists rather than a fixed sleep: see `scripts/lib/waitForPort.ts`.
// Why waiting for the port is not on its own enough: see
// `scripts/lib/backendPairing.ts`. This file is the wiring — resolve the port,
// probe it, establish the pairing, report — and holds no policy of its own.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { classifyPairing, tokenWasRewritten, type Pairing, type TokenSnapshot } from "./lib/backendPairing.js";
import { describeRejection, resolveServerPort } from "./lib/devServerPort.js";
import { waitForPort } from "./lib/waitForPort.js";
import { parseEnvFile } from "../server/utils/launch-env.mjs";

const POLL_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 1000;
const NOTICE_EVERY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 3000;
// How long to keep looking for OUR backend's token write once the port turns
// out to be held by someone else. Timing cannot establish ownership — that is
// what the health answer is for — but something temporal has to bound the
// search, because "our backend has not written yet" and "our backend already
// wrote, before this process started" are indistinguishable from the file
// alone. Boot-to-token measured 3.5s here, so this leaves headroom for a cold
// Windows boot; past it we say we could not attribute the listener rather than
// stalling the dev server or guessing.
const PAIRING_SETTLE_MS = 10_000;

// Long enough for a cold `tsx` boot on a Windows machine with a virus
// scanner in the path — the case this was written for. Overridable because
// "long enough" is a property of the machine, not of the code.
function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

// Mirrors `WORKSPACE_PATHS.sessionToken`, resolved the way `vite.config.ts`
// resolves it — the file whose contents the dev token plugin injects into
// index.html is exactly the one this check has to reason about.
function resolveTokenPath(envFileValues: Record<string, string>): string {
  const fromProcess = process.env.MULMOCLAUDE_WORKSPACE_PATH;
  const fromFile = envFileValues.MULMOCLAUDE_WORKSPACE_PATH;
  const workspace = fromProcess && fromProcess.length > 0 ? fromProcess : (fromFile ?? path.join(os.homedir(), "mulmoclaude"));
  return path.join(workspace, ".session-token");
}

function snapshotToken(tokenPath: string): TokenSnapshot {
  try {
    return { exists: true, mtimeMs: fs.statSync(tokenPath).mtimeMs };
  } catch {
    return { exists: false, mtimeMs: 0 };
  }
}

function readToken(tokenPath: string): string {
  try {
    return fs.readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return "";
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

/** Ask whoever is on the port whether they accept this token. `null` when they
 *  could not be asked, which proves nothing — see `classifyPairing`. */
async function probeHealth(port: number, token: string): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return null;
  }
}

const sleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

function log(msg: string): void {
  console.log(`[wait-for-backend] ${msg}`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Poll until our backend has written its token, or the budget runs out. */
async function awaitTokenRewrite(tokenPath: string, before: TokenSnapshot, deadlineAt: number): Promise<boolean> {
  while (Date.now() < deadlineAt) {
    if (tokenWasRewritten(before, snapshotToken(tokenPath))) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

function reportMismatch(port: number): void {
  log(
    `REFUSING to start Vite: the backend answering on :${port} rejects the session token this run just wrote. ` +
      `That means :${port} belongs to an EARLIER instance — the backend started here found the port busy and walked to another one ` +
      `(see its own "Port ${port} busy" line), while Vite would keep proxying to :${port}. The page would load and then 401 on every ` +
      `request, with nothing saying why (#2650). Stop the other instance, or set PORT to run a second one.`,
  );
  process.exitCode = 1;
}

/** The port answered but our own backend had not written its token yet, so the
 *  listener is someone else's. Wait for our token, then let the instance on the
 *  port rule on it. */
async function resolveContestedPort(port: number, tokenPath: string, before: TokenSnapshot, deadlineAt: number): Promise<void> {
  log(`:${port} is already answering, but the backend started here has not written its session token yet — checking which instance the page would reach...`);
  if (!(await awaitTokenRewrite(tokenPath, before, deadlineAt))) {
    log(
      `could not attribute the listener on :${port} — no session token was written within ${seconds(PAIRING_SETTLE_MS)}, ` +
        `so either this backend is unusually slow or the port belongs to a run this one did not start. Starting Vite anyway; ` +
        `if the UI 401s on every request, another instance is holding the port (#2650).`,
    );
    return;
  }
  const pairing: Pairing = classifyPairing(await probeHealth(port, readToken(tokenPath)));
  if (pairing === "mismatch") {
    reportMismatch(port);
    return;
  }
  if (pairing === "paired") {
    log(`backend on :${port} accepts this run's session token — starting Vite.`);
    return;
  }
  log(`backend on :${port} could not be asked about the session token — starting Vite anyway.`);
}

async function main(): Promise<void> {
  // The same resolution Vite's proxy target uses, from the same inputs. A
  // second opinion about `PORT` here would be #2650 one level down: the
  // wait would watch one port while the proxy addressed another.
  const envFileValues = parseEnvFile(path.join(process.cwd(), ".env")).parsed;
  const resolution = resolveServerPort({ processEnv: process.env, envFileValues });

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
  const tokenPath = resolveTokenPath(envFileValues ?? {});
  const before = snapshotToken(tokenPath);

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

  // Our backend writes its token before it listens, so a port that answers
  // while the token is still untouched is not our backend's port.
  if (tokenWasRewritten(before, snapshotToken(tokenPath))) {
    log(`backend ready on :${port} after ${seconds(result.waitedMs)}`);
    return;
  }
  await resolveContestedPort(port, tokenPath, before, Math.min(startedAt + timeoutMs, Date.now() + PAIRING_SETTLE_MS));
}

// Exit 0 on anything unexpected — `yarn dev` chains this with `&& vite`, and a
// non-zero exit over a wait bug would take the client pane down. The one
// deliberate non-zero is `reportMismatch`, where starting Vite is known to
// produce a broken session.
main().catch((err: unknown) => {
  log(`wait failed, starting Vite anyway: ${String(err)}`);
});
