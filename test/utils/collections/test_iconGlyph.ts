// Unit tests for the pure icon-value classifier
// (packages/core/src/collection/core/iconGlyph.ts).
//
// The invariant that matters is structural: a value the icon font cannot
// resolve MUST come back as exactly one grapheme, because the surfaces draw
// it into a fixed square and anything longer paints over its neighbours
// (#2986).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { resolveIconGlyph } from "@mulmoclaude/core/collection";

const FALLBACK = "dataset";

/** Grapheme-cluster count — the unit the guard actually bounds. */
function graphemeCount(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

describe("resolveIconGlyph — Material Symbols names", () => {
  it("passes a plain name through to the icon font", () => {
    assert.deepEqual(resolveIconGlyph("podcasts", FALLBACK), { kind: "symbol", name: "podcasts" });
  });

  it("accepts names containing digits", () => {
    // A letters-only pattern would reject these real icon names.
    ["123", "10k", "3d_rotation", "18_up_rating", "1x_mobiledata_badge"].forEach((name) => {
      assert.deepEqual(resolveIconGlyph(name, FALLBACK), { kind: "symbol", name }, name);
    });
  });

  it("trims surrounding whitespace before classifying", () => {
    assert.deepEqual(resolveIconGlyph("  rss_feed  ", FALLBACK), { kind: "symbol", name: "rss_feed" });
  });

  it("classifies every name the shipped font list declares as a symbol", () => {
    const require_ = createRequire(import.meta.url);
    const declarations = readFileSync(require_.resolve("material-symbols/index.d.ts"), "utf8");
    const names = [...declarations.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
    assert.ok(names.length > 3000, `expected the full icon list, got ${names.length}`);
    const misclassified = names.filter((name) => resolveIconGlyph(name, FALLBACK).kind !== "symbol");
    assert.deepEqual(misclassified, []);
  });
});

describe("resolveIconGlyph — literal glyphs", () => {
  it("keeps an emoji intact rather than sending it to the icon font", () => {
    assert.deepEqual(resolveIconGlyph("🎙️", FALLBACK), { kind: "glyph", text: "🎙️" });
  });

  it("keeps multi-code-point emoji whole (variation selector, ZWJ, skin tone, flag)", () => {
    // Splitting by code point would strip the variation selector (colour
    // emoji → monochrome glyph) or cut these into fragments.
    ["🎙️", "👨‍👩‍👧", "👍🏽", "🇯🇵", "❤️"].forEach((emoji) => {
      assert.deepEqual(resolveIconGlyph(emoji, FALLBACK), { kind: "glyph", text: emoji }, emoji);
    });
  });

  it("cuts anything unrenderable down to a single grapheme", () => {
    ["not_a_glyph_at_all XYZ", "Podcasts", "menu-book", "日本語のタイトル", "🎙️📰📚", "AB"].forEach((value) => {
      const resolved = resolveIconGlyph(value, FALLBACK);
      assert.equal(resolved.kind, "glyph", value);
      assert.equal(resolved.kind === "glyph" ? graphemeCount(resolved.text) : -1, 1, value);
    });
  });

  it("treats an uppercase or hyphenated near-miss as a glyph, not a broken ligature", () => {
    // `menu-book` / `Podcasts` are the plausible typos: the font has no
    // ligature for either, so they must never reach it.
    assert.deepEqual(resolveIconGlyph("menu-book", FALLBACK), { kind: "glyph", text: "m" });
    assert.deepEqual(resolveIconGlyph("Podcasts", FALLBACK), { kind: "glyph", text: "P" });
  });
});

describe("resolveIconGlyph — fallback", () => {
  it("uses the fallback when the value is absent, empty or blank", () => {
    [undefined, "", "   ", "\t\n"].forEach((raw) => {
      assert.deepEqual(resolveIconGlyph(raw, FALLBACK), { kind: "symbol", name: FALLBACK }, JSON.stringify(raw));
    });
  });

  it("classifies the fallback by the same rule instead of trusting it", () => {
    assert.deepEqual(resolveIconGlyph(undefined, "📚"), { kind: "glyph", text: "📚" });
    assert.deepEqual(resolveIconGlyph("", "Not A Name"), { kind: "glyph", text: "N" });
  });

  it("never throws and always yields a non-empty result", () => {
    [undefined, "", " ", "🎙️", "podcasts", "𐍈"].forEach((raw) => {
      const resolved = resolveIconGlyph(raw, FALLBACK);
      const text = resolved.kind === "symbol" ? resolved.name : resolved.text;
      assert.ok(text.length > 0, JSON.stringify(raw));
    });
  });
});
