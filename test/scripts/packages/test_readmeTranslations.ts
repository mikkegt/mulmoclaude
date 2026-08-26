// `npm pack --json` changed shape between npm 11 and npm 12: an ARRAY of packed
// packages became an OBJECT keyed by package name. The check read `parsed[0]`,
// which is `undefined` on the object — so it saw an empty file list for every
// package and reported each translation as missing. `@mulmobridge/slack` had
// been failing this gate on a tarball that shipped `README.ja.md` all along
// (verified against `npm pack --dry-run`, which listed the file). A gate that is
// permanently red is a gate everyone learns to ignore, so the shapes are pinned.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { packEntry, TRANSLATION_RE, type PackedFile } from "../../../scripts/packages/check-readme-translations.mjs";

const files: PackedFile[] = [{ path: "README.md" }, { path: "README.ja.md" }, { path: "dist/index.js" }];

describe("packEntry — whichever shape npm used", () => {
  it("reads the array shape (npm <= 11)", () => {
    assert.deepEqual(packEntry([{ name: "@scope/pkg", files }])?.files, files);
  });

  it("reads the object-keyed-by-name shape (npm 12)", () => {
    assert.deepEqual(packEntry({ "@scope/pkg": { name: "@scope/pkg", files } })?.files, files);
  });

  // The bug, stated as a test: the object shape used to yield no files at all.
  it("does not lose the file list on the object shape", () => {
    const entry = packEntry({ "@mulmobridge/slack": { files } });
    assert.ok(entry, "an object-shaped result must still resolve to an entry");
    assert.ok(entry.files.map((file) => file.path).includes("README.ja.md"), "a translation present in the tarball must not read as missing");
  });

  // An unrecognised shape must be distinguishable from "packed nothing" — the
  // caller rejects on null rather than reporting every translation missing.
  it("answers null for a shape it cannot read", () => {
    [null, undefined, 42, "text", [], {}, [{ name: "no-files" }], { pkg: { name: "no-files" } }].forEach((input) => {
      assert.equal(packEntry(input), null, `${JSON.stringify(input)} must not be read as a pack entry`);
    });
  });
});

describe("TRANSLATION_RE", () => {
  it("matches a language suffix, with or without a region", () => {
    ["README.ja.md", "README.fr.md", "README.pt-BR.md", "README.zh-CN.md"].forEach((name) => assert.ok(TRANSLATION_RE.test(name), name));
  });

  it("does not match the canonical README or unrelated files", () => {
    ["README.md", "README.txt", "READMEja.md", "README..md", "CHANGELOG.ja.md", "README.JA.md", "README.pt-br.md"].forEach((name) =>
      assert.ok(!TRANSLATION_RE.test(name), name),
    );
  });
});
