// `.server-port` must never be readable in a half-written state (#2981).
//
// Codex raised this on the PR that made Vite's proxy follow the file: the
// original write was a plain `writeFile`, which opens with `O_TRUNC`. A reader
// arriving between the truncate and the write sees an EMPTY file and falls back
// to the port that was ASKED for — the occupied one, i.e. exactly the #2650
// mis-wiring the following was meant to end. A reader arriving mid-write can do
// worse: `3002` truncated to `300` parses as a valid port nothing is on.
//
// The property under test is therefore about what a CONCURRENT reader can
// observe, not about the final contents. It fails against a non-atomic write and
// passes against a rename.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatServerPort, publishServerPort } from "../../server/workspace/serverPort.js";
import { parsePublishedPort } from "../../scripts/lib/devServerPort.js";

let workspace: string;
let portPath: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "server-port-test-"));
  portPath = path.join(workspace, ".server-port");
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("publishServerPort", () => {
  it("writes the port the way a shell hook expects to read it", async () => {
    await publishServerPort(3002, portPath);
    assert.equal(readFileSync(portPath, "utf-8"), "3002\n");
    assert.equal(parsePublishedPort(readFileSync(portPath, "utf-8")), 3002);
  });

  it("replaces an earlier run's port rather than appending to it", async () => {
    writeFileSync(portPath, formatServerPort(3001));
    await publishServerPort(3002, portPath);
    assert.equal(parsePublishedPort(readFileSync(portPath, "utf-8")), 3002);
  });

  // The regression itself. Republish repeatedly while reading as fast as
  // possible; every observation must be a COMPLETE port, never an empty file
  // and never a prefix. `writeFile` fails this on the truncate window.
  it("is never observable half-written by a concurrent reader", async () => {
    const OLD_PORT = 3001;
    const NEW_PORT = 34567; // a different digit count, so a prefix is detectable
    const ROUNDS = 60;
    writeFileSync(portPath, formatServerPort(OLD_PORT));

    const observed = new Set<string>();
    const state = { reading: true };
    const reader = (async () => {
      while (state.reading) {
        try {
          observed.add(readFileSync(portPath, "utf-8"));
        } catch {
          // ENOENT is its own kind of half-state; record it as such.
          observed.add("<missing>");
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    for (let round = 0; round < ROUNDS; round += 1) {
      await publishServerPort(round % 2 === 0 ? NEW_PORT : OLD_PORT, portPath);
    }
    state.reading = false;
    await reader;

    const allowed = new Set([formatServerPort(OLD_PORT), formatServerPort(NEW_PORT)]);
    const bad = [...observed].filter((value) => !allowed.has(value));
    assert.deepEqual(bad, [], `a concurrent reader saw a state that is neither port: ${JSON.stringify(bad)}`);
    // And every observation resolves to a port that was really published.
    [...observed].forEach((value) => {
      assert.ok([OLD_PORT, NEW_PORT].includes(parsePublishedPort(value) ?? -1), `unusable observation ${JSON.stringify(value)}`);
    });
  });
});
