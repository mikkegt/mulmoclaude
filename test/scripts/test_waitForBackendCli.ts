// Integration cover for `scripts/wait-for-backend.ts` — real sockets, a real
// child process, the real CLI (#2981).
//
// The wait FOLLOWS the port the backend published rather than the one `PORT`
// asked for, so what has to be pinned here is the order: learn the port, then
// wait on it. Watching the `PORT`-derived port first is the bug this replaced —
// those two agree only when the request could be honoured, and #2650 is the case
// where it could not.
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
/** A port nothing is listening on, used as the `PORT` the run asked for. */
const UNSERVED_PORT = 3999;

interface Fixture {
  /** The port the fake backend actually bound. */
  boundPort: number;
  workspace: string;
  portFile: string;
  close: () => Promise<void>;
}

async function startFakeBackend(): Promise<Fixture> {
  const workspace = mkdtempSync(path.join(tmpdir(), "wait-backend-test-"));
  const server: Server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP address");
  return {
    boundPort: address.port,
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

function runCli(fixture: Fixture, opts: { port: number; args?: string[] } = { port: UNSERVED_PORT }): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...(opts.args ?? [])], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(opts.port),
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

describe("wait-for-backend CLI — follows the port the backend published", () => {
  let fixture: Fixture;

  before(async () => {
    fixture = await startFakeBackend();
  });
  after(async () => {
    await fixture.close();
  });

  it("waits on the WALKED-TO port, not the one PORT asked for", async () => {
    // The #2650 shape: `PORT` names a port the backend could not take, so it
    // bound another and published that. Nothing is listening on UNSERVED_PORT,
    // so a wait that watched it would time out; following the publish succeeds.
    rmSync(fixture.portFile, { force: true });
    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.boundPort}\n`), PUBLISH_DELAY_MS);

    const { code, out } = await runCli(fixture);
    clearTimeout(publish);

    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`backend ready on :${fixture.boundPort}`));
    assert.match(out, /published by this backend/);
    assert.doesNotMatch(out, new RegExp(`ready on :${UNSERVED_PORT}`));
  });

  it("does not follow a leftover file from a dead run", async () => {
    // Present before the wait begins and never rewritten, so it cannot speak for
    // this startup. Falling back to `PORT` is right: at least that is what Vite
    // will fall back to as well, so the two still agree.
    writeFileSync(fixture.portFile, `${fixture.boundPort}\n`);

    const { code, out } = await runCli(fixture);

    assert.equal(code, 0, out);
    assert.match(out, /assumed from PORT|still not listening/);
    assert.doesNotMatch(out, /published by this backend/);
  });

  it("--reset makes a later publish attributable", async () => {
    writeFileSync(fixture.portFile, "1\n");
    const reset = await runCli(fixture, { port: UNSERVED_PORT, args: ["--reset"] });
    assert.equal(reset.code, 0);
    assert.equal(existsSync(fixture.portFile), false, "--reset must remove the stale port file");

    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.boundPort}\n`), PUBLISH_DELAY_MS);
    const { code, out } = await runCli(fixture);
    clearTimeout(publish);

    assert.equal(code, 0, out);
    assert.match(out, /published by this backend/);
  });

  it("PORT=0 is usable now — the published port is the answer config time could not compute", async () => {
    // `assertProxyablePort` refused this outright before, because an
    // OS-assigned port was unknowable when Vite evaluated its config. It is
    // knowable now: the backend binds it and says so.
    rmSync(fixture.portFile, { force: true });
    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.boundPort}\n`), PUBLISH_DELAY_MS);

    const { code, out } = await runCli(fixture, { port: 0 });
    clearTimeout(publish);

    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`backend ready on :${fixture.boundPort}`));
  });

  it("never refuses to start Vite — following removes the mismatch it used to guard", async () => {
    // The previous design exited 1 when the published port disagreed with the
    // proxy target. Vite follows now, so disagreement is not a state that
    // exists; nothing here should ever stop the client pane.
    rmSync(fixture.portFile, { force: true });
    const publish = setTimeout(() => writeFileSync(fixture.portFile, `${fixture.boundPort}\n`), PUBLISH_DELAY_MS);

    const { code, out } = await runCli(fixture);
    clearTimeout(publish);

    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /REFUS/i);
  });
});
