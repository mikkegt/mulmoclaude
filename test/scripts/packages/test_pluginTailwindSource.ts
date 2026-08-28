// The gate exists because a plugin's Tailwind build scans only its own package,
// so 43 of the 76 classes the shared enum palette spells out in core were absent
// from `collection-plugin/dist/style.css` while the host app rendered them fine
// (#2989). What these tests pin is not "the plugins are currently wired" — the
// gate itself checks that — but the four judgements that would silently disarm
// it: which strings are palette classes, what a file exports, what a plugin
// scans, and when a scan actually covers a file.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { colorClassesIn, exportedNamesIn, findGaps, sourceCovers, sourceTargetsIn } from "../../../scripts/packages/check-plugin-tailwind-source.mjs";

describe("colorClassesIn", () => {
  it("takes the coloured utilities a palette spells out, variants included", () => {
    const found = colorClassesIn('card: "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100"');
    assert.deepEqual([...found].sort(), ["bg-indigo-50", "border-indigo-200", "hover:bg-indigo-100", "text-indigo-600"]);
  });

  it("ignores utilities that carry no colour, which every package emits for itself", () => {
    assert.equal(colorClassesIn('class="flex grow rounded-full p-2 text-sm"').size, 0);
  });

  it("does not read a bare word as a class — that is what makes a directory scan noisy", () => {
    assert.equal(colorClassesIn("const contents = ring(shrink);").size, 0);
  });
});

describe("exportedNamesIn", () => {
  it("names every exported declaration kind", () => {
    const source = [
      "export interface EnumColorClasses { card: string }",
      "export const ENUM_ALERT: EnumColorClasses = { card: 'x' };",
      "export function resolveEnumColor() {}",
      "export type Palette = readonly string[];",
    ].join("\n");
    assert.deepEqual(exportedNamesIn(source), ["EnumColorClasses", "ENUM_ALERT", "resolveEnumColor", "Palette"]);
  });

  it("ignores a re-export and a local declaration — neither names a symbol THIS file owns", () => {
    assert.deepEqual(exportedNamesIn('export * from "./core/enumColors";\nconst PALETTE = [];'), []);
  });
});

describe("sourceTargetsIn", () => {
  it("reads every @source target in order", () => {
    const css = '@import "tailwindcss";\n@source "../a.ts";\n@source "../../b";\n';
    assert.deepEqual(sourceTargetsIn(css), ["../a.ts", "../../b"]);
  });

  it("finds nothing in a plain entry — the state that produced the bug", () => {
    assert.deepEqual(sourceTargetsIn('@import "tailwindcss";\n'), []);
  });
});

describe("sourceCovers", () => {
  const file = path.join("/repo", "packages", "core", "src", "collection", "enumColors.ts");

  it("covers the file named directly", () => {
    assert.equal(sourceCovers(file, file), true);
  });

  it("covers a file under a directory target", () => {
    assert.equal(sourceCovers(path.join("/repo", "packages", "core", "src"), file), true);
  });

  it("does not let a sibling with a shared prefix pass as a parent", () => {
    // `/repo/packages/core/src-old` is not above `/repo/packages/core/src/…`,
    // and a plain startsWith would say it is.
    assert.equal(sourceCovers(path.join("/repo", "packages", "core", "src-old"), file), false);
  });
});

describe("findGaps", () => {
  const coreFile = path.join("/repo", "packages", "core", "src", "enumColors.ts");
  const palette = { file: coreFile, classes: new Set(["bg-lime-50"]), exports: ["resolveEnumColor"] };
  const plugin = (targets: string[], usedExports: string[]) => ({
    name: "collection-plugin",
    cssPath: "/repo/packages/plugins/collection-plugin/src/style.css",
    targets,
    usedExports,
  });

  it("flags a plugin that renders the palette and scans nothing", () => {
    const gaps = findGaps([palette], [plugin([], ["resolveEnumColor"])]);
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0]?.symbols, ["resolveEnumColor"]);
  });

  it("passes when the file is named directly, and when a directory above it is", () => {
    assert.deepEqual(findGaps([palette], [plugin([coreFile], ["resolveEnumColor"])]), []);
    assert.deepEqual(findGaps([palette], [plugin([path.dirname(coreFile)], ["resolveEnumColor"])]), []);
  });

  it("ignores a plugin that imports nothing from the file", () => {
    assert.deepEqual(findGaps([palette], [plugin([], ["fieldVisible"])]), []);
  });

  it("ignores a core file that declares no classes — most of core", () => {
    const plain = { file: coreFile, classes: new Set<string>(), exports: ["resolveEnumColor"] };
    assert.deepEqual(findGaps([plain], [plugin([], ["resolveEnumColor"])]), []);
  });
});
