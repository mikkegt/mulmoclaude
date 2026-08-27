// Integration cover for `scripts/wait-for-backend.ts` — real sockets, a real
// child process, the real CLI (#2975).
//
// Codex asked for this on iter-4, and it is the right shape for the finding:
// the busy-implicit-default-port case is about how three moving parts line up
// (a listener on the proxy target, a token file, and the order the two dev
// panes start in), which no unit test of a pure rule can pin down.
//
// Every case binds port 0 and reads back the assigned port, so nothing here
// depends on 3001 being free on the runner.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "scripts", "wait-for-backend.ts");
const CLI_BUDGET_MS = 8000;

interface Fixture {
  port: number;
  workspace: string;
  tokenPath: string;
  close: () => Promise<void>;
}

/** A stand-in backend that accepts exactly one bearer token on /api/health. */
async function startFakeBackend(acceptedToken: string): Promise<Fixture> {
  const workspace = mkdtempSync(path.join(tmpdir(), "wait-backend-test-"));
  const server = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${acceptedToken}`;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { status: "OK" } : { error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP address");
  return {
    port: address.port,
    workspace,
    tokenPath: path.join(workspace, ".session-token"),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(workspace, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function runCli(fixture: Fixture, waitMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(fixture.port),
        MULMOCLAUDE_WORKSPACE_PATH: fixture.workspace,
        MULMOCLAUDE_DEV_WAIT_MS: String(waitMs),
      },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("wait-for-backend CLI — which instance is on the port", () => {
  let stale: Fixture;

  before(async () => {
    // The stale instance accepts only its OWN token — exactly what an earlier
    // `yarn dev` leaves behind on the proxy target.
    stale = await startFakeBackend("stale-instance-token");
  });
  after(async () => {
    await stale.close();
  });

  it("refuses to start Vite when the listener rejects this run's token", async () => {
    // The stale backend's own token is on disk when the wait begins...
    writeFileSync(stale.tokenPath, "stale-instance-token");
    // ...and then the backend THIS run started writes its own, the way it does
    // just before binding the port it walked to.
    const rewrite = setTimeout(() => writeFileSync(stale.tokenPath, "fresh-instance-token"), 400);

    const { code, out } = await runCli(stale, CLI_BUDGET_MS);
    clearTimeout(rewrite);

    assert.equal(code, 1, `expected a non-zero exit so \`&& vite\` does not run:\n${out}`);
    assert.match(out, /REFUSING to start Vite/);
    assert.match(out, /2650/);
  });

  it("starts Vite when the listener accepts this run's token", async () => {
    writeFileSync(stale.tokenPath, "stale-instance-token");
    // A pinned MULMOCLAUDE_AUTH_TOKEN rewrites the same bytes: the write
    // happened, and the instance on the port still accepts it.
    const rewrite = setTimeout(() => writeFileSync(stale.tokenPath, "stale-instance-token"), 400);

    const { code, out } = await runCli(stale, CLI_BUDGET_MS);
    clearTimeout(rewrite);

    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /REFUSING/);
    assert.match(out, /accepts this run's session token/);
  });

  it("does not false-alarm when our own backend wrote its token before this process started", async () => {
    // The ordering Codex raised: the backend is hot and already listening when
    // the waiter takes its first probe. Its token write precedes its listen, so
    // the rewrite is already visible and there is no false 'other instance'
    // alarm — no probe-count guess is involved.
    rmSync(stale.tokenPath, { force: true });
    const ours = await startFakeBackend("ours");
    writeFileSync(ours.tokenPath, "ours");

    const { code, out } = await runCli(ours, CLI_BUDGET_MS);
    await ours.close();

    // The honest outcome: no rewrite is observable (the write happened before
    // this process could snapshot the file), so the wait says it cannot
    // attribute the listener rather than inventing a verdict — and crucially
    // does NOT refuse, which is what a probe-count guess would have done here.
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /REFUSING/);
    assert.match(out, /could not attribute the listener/);
  });
});
