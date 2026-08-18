// The broker's start marker is written INSIDE the sandbox, into a directory the
// agent can write. A plain write there follows whatever is already at the path,
// so a symlink planted on it would be truncated — and on the reading side a
// planted entry would report a broker that never ran as having started, which
// is the one thing this signal is asked to be right about (Codex review on
// #2932).
//
// No privilege boundary is crossed either way — the broker runs as the same uid
// in the same container — but a write that follows an attacker-placed link is
// wrong regardless, and refusing costs nothing: the HTTP beacon covers the
// signal when the file cannot be created.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeStartMarker } from "../../server/agent/mcp-start-beacon.mjs";

let root = "";

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "mulmoclaude-marker-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("writeStartMarker", () => {
  it("writes the spawn id when the path is free", () => {
    const marker = path.join(root, "fresh");
    writeStartMarker(marker, "spawn-1");
    assert.equal(readFileSync(marker, "utf-8"), "spawn-1");
  });

  it("refuses a path that already holds a file, rather than overwriting it", () => {
    const marker = path.join(root, "occupied");
    writeFileSync(marker, "someone else's content");
    assert.throws(() => writeStartMarker(marker, "spawn-2"));
    assert.equal(readFileSync(marker, "utf-8"), "someone else's content");
  });

  // The case the hardening exists for: the write must not travel down a link
  // the sandboxed agent planted.
  it("refuses a symlink and leaves its target untouched", () => {
    const victim = path.join(root, "victim");
    writeFileSync(victim, "precious");
    const marker = path.join(root, "planted-link");
    symlinkSync(victim, marker);
    assert.throws(() => writeStartMarker(marker, "spawn-3"));
    assert.equal(readFileSync(victim, "utf-8"), "precious");
  });

  it("refuses a symlink even when its target does not exist yet", () => {
    const target = path.join(root, "not-there-yet");
    const marker = path.join(root, "dangling-link");
    symlinkSync(target, marker);
    assert.throws(() => writeStartMarker(marker, "spawn-4"));
    assert.equal(existsSync(target), false);
  });

  it("refuses a directory at the marker path", () => {
    const marker = path.join(root, "a-directory");
    mkdirSync(marker);
    assert.throws(() => writeStartMarker(marker, "spawn-5"));
  });
});
