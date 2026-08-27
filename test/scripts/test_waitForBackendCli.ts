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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function runCli(fixture: Fixture, args: string[] = []): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
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

  it("refuses when this run published before the waiter could snapshot (iter-6 ordering)", async () => {
    // Both reviewers landed on this one independently. The dev panes start
    // concurrently with no ordering guarantee, so a slow client pane snapshots
    // a `.server-port` THIS run already wrote. `wasRepublished` cannot see a
    // publish that precedes the snapshot, and the earlier version merely warned
    // here — starting Vite into the broken session it had just diagnosed.
    writeFileSync(fixture.portFile, `${fixture.port + 7}\n`);

    const { code, out } = await runCli(fixture);

    assert.equal(code, 1, `a readable disagreement must stop \`&& vite\` even unattributed:\n${out}`);
    assert.match(out, /REFUSING to start Vite/);
    assert.doesNotMatch(out, /backend ready on :/);
  });

  it("does not accept a pre-existing MATCHING port as proof (iter-7)", async () => {
    // Codex's reciprocal case. An older backend holding the proxy target leaves
    // `.server-port` reading that very port, while this run's backend writes its
    // new session token before it ever reaches `app.listen`. Calling that
    // "ready" hands Vite the new token pointed at the old listener — the same
    // 401, by the opposite route. Nothing this run wrote, so nothing is proven.
    writeFileSync(fixture.portFile, `${fixture.port}\n`);

    const { code, out } = await runCli(fixture);

    assert.equal(code, 0, out);
    assert.match(out, /could not confirm which backend holds/);
    assert.doesNotMatch(out, /backend ready on :/);
  });

  it("--reset clears the file, so a later publish is attributable to this startup", async () => {
    // The rule that ends the ambiguity: `yarn dev` clears `.server-port` before
    // either pane starts, so anything found afterwards belongs to this run.
    writeFileSync(fixture.portFile, `${fixture.port}\n`);
    const { code } = await runCli(fixture, ["--reset"]);

    assert.equal(code, 0);
    assert.equal(existsSync(fixture.portFile), false, "--reset must remove the stale port file");

    // With the file cleared, the same walked-forward publish is now provable.
    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.port + 1}\n`), PUBLISH_DELAY_MS);
    const run = await runCli(fixture);
    clearTimeout(publish);

    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /REFUSING to start Vite/);
  });

  it("says so plainly when nothing published a port at all", async () => {
    rmSync(fixture.portFile, { force: true });

    const { code, out } = await runCli(fixture);

    assert.equal(code, 0, out);
    assert.match(out, /could not confirm which backend holds/);
    assert.doesNotMatch(out, /REFUSING/);
  });
});
