// Unit tests for the accent-colour palette
// (packages/core/src/collection/core/accentColor.ts).
//
// Two things are worth pinning here beyond "does it return a string": that a
// bad colour name degrades to no-accent rather than throwing (a schema is
// user/LLM-authored), and that the palette never reaches into the warm band —
// those are the notification severities, and a shortcut that looks like an
// alert is worse than one with no accent at all.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ACCENT_COLORS, accentChipClasses, isAccentColor, type AccentColor } from "@mulmoclaude/core/collection";

describe("accentChipClasses — declared colours", () => {
  it("returns chip classes for every colour in the palette", () => {
    ACCENT_COLORS.forEach((color) => {
      const classes = accentChipClasses(color);
      assert.ok(classes, `${color} produced no classes`);
      assert.match(classes, new RegExp(`\\bbg-${color}-\\d{2,3}\\b`), color);
      assert.match(classes, new RegExp(`\\btext-${color}-\\d{2,3}\\b`), color);
    });
  });

  it("spells each class out as a complete literal Tailwind can find", () => {
    // Building `bg-${color}-50` at runtime is the failure this guards: Tailwind
    // scans for whole class names, so a composed one is never emitted.
    const source = ACCENT_COLORS.map((color) => accentChipClasses(color) ?? "").join(" ");
    source.split(/\s+/).forEach((token) => {
      assert.match(token, /^(?:bg|text)-[a-z]+-\d{2,3}$/, token);
    });
  });

  it("declares every colour exactly once", () => {
    assert.equal(new Set(ACCENT_COLORS).size, ACCENT_COLORS.length);
  });
});

describe("accentChipClasses — no accent", () => {
  it("returns null for absent, empty and blank values", () => {
    [undefined, "", "   "].forEach((value) => {
      assert.equal(accentChipClasses(value), null, JSON.stringify(value));
    });
  });

  it("returns null for a name outside the palette instead of throwing", () => {
    // A typo costs the colour, not the surface — same fail-soft as `icon`.
    ["puce", "Violet", "VIOLET", "violet-50", "bg-violet-50", "red", "1", "__proto__", "constructor", "toString"].forEach((value) => {
      assert.equal(accentChipClasses(value), null, value);
    });
  });

  it("isAccentColor rejects non-strings without throwing", () => {
    [undefined, null, 0, 1, {}, [], true].forEach((value) => {
      assert.equal(isAccentColor(value), false, JSON.stringify(value));
    });
  });

  it("isAccentColor accepts exactly the declared names", () => {
    ACCENT_COLORS.forEach((color) => assert.equal(isAccentColor(color), true, color));
  });
});

describe("accentChipClasses — palette boundaries", () => {
  it("never reaches into the warm notification band", () => {
    // red / orange / amber are `ENUM_ALERT` / `ENUM_NUDGE` in enumColors.ts.
    // An accent drawn in one of those reads as "this needs attention".
    const reserved = ["red", "orange", "amber", "yellow", "rose"];
    const declared: readonly string[] = ACCENT_COLORS;
    reserved.forEach((color) => {
      assert.equal(declared.includes(color), false, `${color} is reserved for notification severity`);
      assert.equal(accentChipClasses(color), null, color);
    });
  });

  it("offers enough colours to tell a realistic pin bar apart", () => {
    // The reported case was several look-alike podcast/RSS collections; a
    // palette smaller than that is not a fix.
    assert.ok(ACCENT_COLORS.length >= 6, `only ${ACCENT_COLORS.length} colours`);
  });

  it("gives every colour a distinct chip", () => {
    const chips = ACCENT_COLORS.map((color: AccentColor) => accentChipClasses(color));
    assert.equal(new Set(chips).size, ACCENT_COLORS.length);
  });
});
