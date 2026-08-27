// The rule that decides whether the backend the PROXY will reach is the one
// this run started (#2975, raised by Codex on iter-3/4/5).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyBoundPort, wasRepublished } from "../../scripts/lib/backendPairing.js";

describe("wasRepublished", () => {
  it("a first publish counts — a fresh workspace has no port file", () => {
    assert.equal(wasRepublished({ exists: false, mtimeMs: 0 }, { exists: true, mtimeMs: 100 }), true);
  });

  it("an untouched file cannot speak for this run — `.server-port` outlives its writer", () => {
    assert.equal(wasRepublished({ exists: true, mtimeMs: 100 }, { exists: true, mtimeMs: 100 }), false);
  });

  it("a new mtime on the same bytes still counts — a restart onto the same port writes the same number", () => {
    assert.equal(wasRepublished({ exists: true, mtimeMs: 100 }, { exists: true, mtimeMs: 250 }), true);
  });

  it("a file that vanished is not a publish", () => {
    assert.equal(wasRepublished({ exists: true, mtimeMs: 100 }, { exists: false, mtimeMs: 0 }), false);
  });
});

describe("classifyBoundPort", () => {
  it("the bound port matching the proxy target is the whole invariant", () => {
    assert.equal(classifyBoundPort("3001\n", 3001), "paired");
  });

  it("a walked-forward port is a proven mismatch — the #2650 case", () => {
    assert.equal(classifyBoundPort("3002\n", 3001), "mismatch");
  });

  it("nothing readable stays unknown — refusing to start on 'cannot tell' would be worse than the race", () => {
    [null, "", "   ", "not-a-port", "0", "-1", "3001.5"].forEach((raw) => {
      assert.equal(classifyBoundPort(raw, 3001), "unknown", `expected "${String(raw)}" to be unknown`);
    });
  });
});
