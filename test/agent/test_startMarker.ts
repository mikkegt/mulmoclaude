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
import { platform, tmpdir } from "node:os";
import path from "node:path";
import { writeStartMarker } from "../../server/agent/mcp-start-beacon.mjs";
import { markerHolds } from "../../server/agent/backend/claude-code.js";

// Windows has no `O_NOFOLLOW`, and `symlinkSync` there needs a privilege the
// runner does not have — so the symlink cases are POSIX-only rather than
// failing for a reason that is not about this code.
const SYMLINK_SKIP = platform() === "win32" ? "symlinks need privilege on Windows, and O_NOFOLLOW does not exist there" : false;

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
  it("refuses a symlink and leaves its target untouched", { skip: SYMLINK_SKIP }, () => {
    const victim = path.join(root, "victim");
    writeFileSync(victim, "precious");
    const marker = path.join(root, "planted-link");
    symlinkSync(victim, marker);
    assert.throws(() => writeStartMarker(marker, "spawn-3"));
    assert.equal(readFileSync(victim, "utf-8"), "precious");
  });

  it("refuses a symlink even when its target does not exist yet", { skip: SYMLINK_SKIP }, () => {
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

// What the host will accept as "this broker started". The marker sits in a
// directory the sandboxed agent can write, so the read has to rule out both a
// symlink and a file merely pre-created at the path (Codex review on #2932).
//
// It is not, and cannot be, unforgeable: the marker path, the spawn id and the
// bearer token all live in the per-session MCP config inside the same mount, so
// anything that can plant the file can read what to put in it. Nothing acts on
// this signal — it labels a log line — so the bar is "not wrong by accident".
describe("markerHolds", () => {
  it("accepts a marker holding this spawn's id", () => {
    const marker = path.join(root, "accept");
    writeStartMarker(marker, "spawn-abc");
    assert.equal(markerHolds(marker, "spawn-abc"), true);
  });

  it("rejects a marker left by a different spawn", () => {
    const marker = path.join(root, "other-spawn");
    writeStartMarker(marker, "spawn-abc");
    assert.equal(markerHolds(marker, "spawn-xyz"), false);
  });

  // The scenario the content check exists for: touch the path before the broker
  // launches and the preload then refuses to write it, so an existence-only
  // check would report a broker that never ran.
  it("rejects a file pre-created at the path", () => {
    const marker = path.join(root, "pre-created");
    writeFileSync(marker, "");
    assert.equal(markerHolds(marker, "spawn-abc"), false);
  });

  it("rejects a symlink even when its target holds the right id", { skip: SYMLINK_SKIP }, () => {
    const target = path.join(root, "right-content");
    writeFileSync(target, "spawn-abc");
    const marker = path.join(root, "link-to-right-content");
    symlinkSync(target, marker);
    assert.equal(markerHolds(marker, "spawn-abc"), false);
  });

  it("rejects a missing marker", () => {
    assert.equal(markerHolds(path.join(root, "nope"), "spawn-abc"), false);
  });

  it("rejects a directory", () => {
    const marker = path.join(root, "dir-marker");
    mkdirSync(marker);
    assert.equal(markerHolds(marker, "spawn-abc"), false);
  });

  it("tolerates surrounding whitespace from the write", () => {
    const padded = path.join(root, "padded");
    writeFileSync(padded, "  spawn-abc\n");
    assert.equal(markerHolds(padded, "spawn-abc"), true);
  });

  // The cap is enforced by the READ — `readSync` into a fixed
  // `Buffer.alloc(MARKER_MAX_BYTES)` — not by slicing afterwards, which is what
  // `docs/large-file-reading.md` warns about and what Codex flagged on #2932.
  //
  // Stated plainly: that bound is NOT observable through this function's return
  // value, and these two cases do not prove it. An attempt to build a case that
  // discriminates (a sparse file past `kStringMaxLength` whose first bytes hold
  // the id) fails for an unrelated and correct reason — `ftruncate` zero-fills,
  // `trim()` does not strip NUL, so such a file is rejected either way. Every
  // oversized input SHOULD be rejected, so no input separates the two
  // implementations by result. The bound is structural; these pin the
  // behaviour around it.
  it("refuses a marker whose id sits past the byte cap", () => {
    const huge = path.join(root, "huge");
    writeFileSync(huge, `${"x".repeat(10 * 1024 * 1024)}spawn-abc`);
    assert.equal(markerHolds(huge, "spawn-abc"), false);
  });

  it("refuses a marker padded past the cap even when it starts with the id", () => {
    const padded = path.join(root, "padded-past-cap");
    writeFileSync(padded, `spawn-abc${"x".repeat(10 * 1024 * 1024)}`);
    assert.equal(markerHolds(padded, "spawn-abc"), false);
  });
});
