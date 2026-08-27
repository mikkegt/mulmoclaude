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
import { classifyBoundPort, wasRepublished, type FileSnapshot, type Pairing } from "./lib/backendPairing.js";
import { describeRejection, resolveServerPort } from "./lib/devServerPort.js";
import { waitForPort } from "./lib/waitForPort.js";
import { parseEnvFile } from "../server/utils/launch-env.mjs";

const POLL_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 1000;
const NOTICE_EVERY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;
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
async function verifyProxyTarget(proxyTarget: number, portFile: string, before: FileSnapshot, deadlineAt: number): Promise<void> {
  const republished = await awaitRepublish(portFile, before, deadlineAt);
  const raw = readTextOrNull(portFile);
  const pairing: Pairing = classifyBoundPort(raw, proxyTarget);

  if (!republished) {
    // The file exists but this run did not write it, so it cannot speak for
    // this run. Its number is still worth reporting when it disagrees — as a
    // warning, never as grounds to refuse.
    if (pairing === "mismatch") {
      log(
        `WARNING: a leftover .server-port says :${raw?.trim()} while Vite proxies to :${proxyTarget}, and this run published no port of its own. If the UI 401s on every request, another instance is holding :${proxyTarget} (#2650).`,
      );
      return;
    }
    log(`could not confirm which backend holds :${proxyTarget} — this run published no port within ${seconds(PAIRING_SETTLE_MS)}. Starting Vite anyway.`);
    return;
  }

  if (pairing === "mismatch" && raw !== null) {
    reportMismatch(proxyTarget, raw);
    return;
  }
  if (pairing === "paired") {
    log(`backend ready on :${proxyTarget}`);
    return;
  }
  log(`backend is up but did not publish a readable port — starting Vite against :${proxyTarget}.`);
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
  const portFile = resolveServerPortPath(envFileValues ?? {});
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
  await verifyProxyTarget(port, portFile, before, Math.min(startedAt + timeoutMs, Date.now() + PAIRING_SETTLE_MS));
}

// Exit 0 on anything unexpected — `yarn dev` chains this with `&& vite`, and a
// non-zero exit over a wait bug would take the client pane down. The one
// deliberate non-zero is `reportMismatch`, where starting Vite is known to
// produce a broken session.
main().catch((err: unknown) => {
  log(`wait failed, starting Vite anyway: ${String(err)}`);
});
