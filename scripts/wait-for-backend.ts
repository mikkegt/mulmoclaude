#!/usr/bin/env tsx
// `yarn dev`'s client half waits here before starting Vite (#2975).
//
// Why this exists rather than a fixed sleep: see `scripts/lib/waitForPort.ts`.
// This file is the wiring — resolve the port, probe it, report — and holds no
// policy of its own.
import net from "node:net";
import path from "node:path";
import { describeRejection, resolveServerPort } from "./lib/devServerPort.js";
import { waitForPort } from "./lib/waitForPort.js";
import { parseEnvFile } from "../server/utils/launch-env.mjs";

const POLL_INTERVAL_MS = 150;
const PROBE_TIMEOUT_MS = 1000;
const NOTICE_EVERY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;

// Long enough for a cold `tsx` boot on a Windows machine with a virus
// scanner in the path — the case this was written for. Overridable because
// "long enough" is a property of the machine, not of the code.
function resolveTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(parsed) || parsed < 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

// A bare TCP connect, not a request: `/api/health` needs the bearer token,
// which is the very thing whose absence this wait exists to prevent.
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

async function main(): Promise<void> {
  // The same resolution Vite's proxy target uses, from the same inputs. A
  // second opinion about `PORT` here would be #2650 one level down: the
  // wait would watch one port while the proxy addressed another.
  const resolution = resolveServerPort({
    processEnv: process.env,
    envFileValues: parseEnvFile(path.join(process.cwd(), ".env")).parsed,
  });

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

  if (result.ready) {
    log(`backend ready on :${port} after ${seconds(result.waitedMs)}`);
    return;
  }
  // Starting Vite anyway is deliberate: that is what shipped before this
  // wait existed, so the worst case is the old behaviour plus a line saying
  // what to expect.
  log(
    `backend still not listening on :${port} after ${seconds(result.waitedMs)} — starting Vite anyway. ` +
      `Expect "Can't reach the backend" in the UI until it comes up; reload once it does so the page picks up the auth token. ` +
      `Set MULMOCLAUDE_DEV_WAIT_MS to wait longer.`,
  );
}

// Exit 0 whatever happens — `yarn dev` chains this with `&& vite`, and a
// non-zero exit here would take the client pane down over a slow boot.
main().catch((err: unknown) => {
  log(`wait failed, starting Vite anyway: ${String(err)}`);
});
