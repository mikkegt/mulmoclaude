// Integration cover for `scripts/wait-for-backend.ts` — real sockets, a real
// child process, the real CLI (#2975).
//
// Codex asked for this on iter-4 and sharpened it on iter-5: the
// busy-implicit-default-port case is about how three moving parts line up (a
// listener on the proxy target, the `.server-port` the backend publishes, and
// the order the two dev panes start in), which no unit test of a pure rule can
// pin down. The ordering case matters most — an earlier design had a fast path
// that skipped the check whenever those writes interleaved.
//
// Every case binds port 0 and reads back the assigned port, so nothing here
// depends on 3001 being free on the runner.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "scripts", "wait-for-backend.ts");
const CLI_BUDGET_MS = 8000;
const PUBLISH_DELAY_MS = 400;

interface Fixture {
  port: number;
  workspace: string;
  portFile: string;
  close: () => Promise<void>;
}

/** Something holding the proxy target. What it is does not matter — the check
 *  never talks to it, which is the point: no credential is handed to a process
 *  this script has not identified. */
async function occupyPort(): Promise<Fixture> {
  const workspace = mkdtempSync(path.join(tmpdir(), "wait-backend-test-"));
  const server: Server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP address");
  return {
    port: address.port,
    workspace,
    portFile: path.join(workspace, ".server-port"),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(workspace, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function runCli(fixture: Fixture): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(fixture.port),
        MULMOCLAUDE_WORKSPACE_PATH: fixture.workspace,
        MULMOCLAUDE_DEV_WAIT_MS: String(CLI_BUDGET_MS),
      },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("wait-for-backend CLI — which backend holds the proxy target", () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await occupyPort();
  });
  after(async () => {
    await fixture.close();
  });

  it("refuses to start Vite when this run's backend bound a different port", async () => {
    // An earlier instance left its own number behind...
    writeFileSync(fixture.portFile, `${fixture.port}\n`);
    // ...and then the backend THIS run started publishes the port it walked to.
    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.port + 1}\n`), PUBLISH_DELAY_MS);

    const { code, out } = await runCli(fixture);
    clearTimeout(publish);

    assert.equal(code, 1, `expected a non-zero exit so \`&& vite\` does not run:\n${out}`);
    assert.match(out, /REFUSING to start Vite/);
    assert.match(out, /2650/);
  });

  it("starts Vite when this run's backend bound the port Vite targets", async () => {
    writeFileSync(fixture.portFile, `${fixture.port}\n`);
    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.port}\n`), PUBLISH_DELAY_MS);

    const { code, out } = await runCli(fixture);
    clearTimeout(publish);

    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /REFUSING/);
    assert.match(out, /backend ready on :/);
  });

  it("checks even when the publish lands before the first probe resolves (iter-5 ordering)", async () => {
    // The race Codex named: the port is already held AND a port was already
    // published, so a design that only checked the 'contested' path would sail
    // straight past. The check is unconditional, so it still fires — but the
    // file predates this process, so it warns rather than refusing.
    writeFileSync(fixture.portFile, `${fixture.port + 7}\n`);

    const { code, out } = await runCli(fixture);

    assert.equal(code, 0, out);
    assert.match(out, /WARNING: a leftover \.server-port/);
    assert.doesNotMatch(out, /backend ready on :/);
  });

  it("says so plainly when nothing published a port at all", async () => {
    rmSync(fixture.portFile, { force: true });

    const { code, out } = await runCli(fixture);

    assert.equal(code, 0, out);
    assert.match(out, /could not confirm which backend holds/);
    assert.doesNotMatch(out, /REFUSING/);
  });
});
