// The rule that decides whether the token the PAGE will get belongs to the
// backend the PROXY will reach (#2975, raised by Codex on iter-3/4).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPairing, tokenWasRewritten } from "../../scripts/lib/backendPairing.js";

describe("tokenWasRewritten", () => {
  it("a fresh workspace writing its first token counts as rewritten", () => {
    assert.equal(tokenWasRewritten({ exists: false, mtimeMs: 0 }, { exists: true, mtimeMs: 100 }), true);
  });

  it("an untouched token means our backend has not reached startup yet", () => {
    assert.equal(tokenWasRewritten({ exists: true, mtimeMs: 100 }, { exists: true, mtimeMs: 100 }), false);
  });

  it("a new mtime on the same bytes still counts — MULMOCLAUDE_AUTH_TOKEN pins the value, not the write", () => {
    assert.equal(tokenWasRewritten({ exists: true, mtimeMs: 100 }, { exists: true, mtimeMs: 250 }), true);
  });

  it("a token that vanished is not a rewrite (graceful shutdown deletes it)", () => {
    assert.equal(tokenWasRewritten({ exists: true, mtimeMs: 100 }, { exists: false, mtimeMs: 0 }), false);
  });
});

describe("classifyPairing", () => {
  it("200 proves the instance on the port accepts this run's token", () => {
    assert.equal(classifyPairing(200), "paired");
  });

  it("401/403 proves the credential was rejected — the stale-instance case", () => {
    assert.equal(classifyPairing(401), "mismatch");
    assert.equal(classifyPairing(403), "mismatch");
  });

  it("no answer proves nothing, and must not read as a mismatch", () => {
    assert.equal(classifyPairing(null), "unproven");
  });

  it("odd-but-not-rejected answers stay unproven — refusing to start on those would be worse than the race", () => {
    [404, 500, 502, 302].forEach((status) => assert.equal(classifyPairing(status), "unproven"));
  });
});
