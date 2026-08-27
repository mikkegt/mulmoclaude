import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { marked, Marked } from "marked";
import { mathExtension, findMathStart, findMathBlockStart, isPlausibleInlineMath, mathPlaceholder } from "../src/markdown/mathExtension.js";

// A private instance — `marked.use()` is global, and the mermaid tests
// (and the host) share the module-level singleton.
const mathMd = new Marked();
mathMd.use(mathExtension);
const render = (src: string): string => mathMd.parse(src) as string;

const PENDING = /data-math-pending="1"/;

describe("inline `$…$` — strict delimiter rules", () => {
  it("renders a formula surrounded by whitespace", () => {
    const html = render("Einstein said $E=mc^2$ loudly.");
    assert.match(html, PENDING);
    assert.match(html, /data-math-display="0"/);
    assert.match(html, />E=mc\^2</);
  });

  it("renders a formula hugged by Japanese text (no ASCII word boundary)", () => {
    const html = render("円周率は$\\pi$です。");
    assert.match(html, PENDING);
  });

  it("leaves two prices in one sentence as prose", () => {
    // The classic false positive: without the "no whitespace before the
    // closing `$`" rule this swallows ` と ` into a formula.
    const html = render("牛丼は $100 と $200 です。");
    assert.doesNotMatch(html, PENDING);
    assert.match(html, /\$100 と \$200/);
  });

  it("leaves a currency prefixed by letters alone", () => {
    assert.doesNotMatch(render("US$5 and US$10 today."), PENDING);
  });

  it("leaves a price range alone (digit follows the closing `$`)", () => {
    assert.doesNotMatch(render("Cost: $5-$10 range."), PENDING);
  });

  it("leaves a purely numeric body alone", () => {
    assert.doesNotMatch(render("total $1,000$ only"), PENDING);
  });

  it("leaves whitespace-hugged delimiters alone", () => {
    assert.doesNotMatch(render("bad $ x $ math"), PENDING);
  });

  it("does not span a line break", () => {
    assert.doesNotMatch(render("open $foo\nbar$ close"), PENDING);
  });

  it("treats `\\$` as a literal dollar", () => {
    const html = render("Literal \\$5 and \\$9 here.");
    assert.doesNotMatch(html, PENDING);
  });

  it("escapes html in the TeX source", () => {
    const html = render("$<img src=x onerror=alert(1)>$");
    assert.match(html, PENDING);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });

  it("does not touch math inside a code span or a fence", () => {
    assert.doesNotMatch(render("`$x$` stays code"), PENDING);
    assert.doesNotMatch(render("```\n$y$\n```"), PENDING);
  });

  it("renders inside list items and table cells", () => {
    assert.match(render("- item $a_1$ here"), PENDING);
    assert.match(render("| a |\n|---|\n| $x^2$ |"), PENDING);
  });
});

describe("display math", () => {
  it("renders a fenced `$$` block as a block-level placeholder", () => {
    const html = render("Before\n\n$$\n\\int_0^1 x^2\\,dx\n$$\n\nAfter");
    assert.match(html, /<div class="math-block" data-math-pending="1" data-math-display="1">/);
    assert.match(html, /<p>Before<\/p>/);
    assert.match(html, /<p>After<\/p>/);
  });

  it("renders a single-line `$$…$$` paragraph as a block", () => {
    assert.match(render("$$a^2+b^2=c^2$$"), /<div class="math-block"/);
  });

  it("keeps mid-sentence `$$…$$` inline — a <div> inside a <p> is invalid nesting", () => {
    const html = render("See $$a^2$$ inline.");
    assert.match(html, /<span class="math-inline" data-math-pending="1" data-math-display="1">/);
    assert.doesNotMatch(html, /<div/);
    assert.match(html, /<p>See .* inline\.<\/p>/);
  });

  it("ignores an empty `$$ $$`", () => {
    assert.doesNotMatch(render("$$\n\n$$"), PENDING);
  });
});

describe("findMathStart", () => {
  it("skips a `$` preceded by an ASCII alphanumeric", () => {
    assert.equal(findMathStart("US$5 then $x$"), 10);
  });

  it("skips an escaped `\\$`", () => {
    assert.equal(findMathStart("a \\$5 then $x$"), 11);
  });

  it("returns undefined when there is no candidate", () => {
    assert.equal(findMathStart("no dollars here"), undefined);
    assert.equal(findMathStart("US$5 only"), undefined);
  });

  it("accepts a `$` at index 0", () => {
    assert.equal(findMathStart("$x$"), 0);
  });
});

describe("findMathBlockStart", () => {
  it("points at a line-leading `$$`", () => {
    assert.equal(findMathBlockStart("text\n$$\nx\n$$"), 5);
    assert.equal(findMathBlockStart("$$\nx\n$$"), 0);
  });

  it("allows up to three leading spaces", () => {
    assert.equal(findMathBlockStart("text\n   $$\nx\n$$"), 8);
  });

  it("ignores a mid-sentence `$$` so the paragraph is not split", () => {
    assert.equal(findMathBlockStart("See $$a^2$$ inline."), undefined);
  });
});

describe("isPlausibleInlineMath", () => {
  it("rejects an empty or whitespace-hugged body", () => {
    assert.equal(isPlausibleInlineMath("", ""), false);
    assert.equal(isPlausibleInlineMath(" x", ""), false);
    assert.equal(isPlausibleInlineMath("x ", ""), false);
  });

  it("rejects a body ending in a backslash (the closing `$` was escaped)", () => {
    assert.equal(isPlausibleInlineMath("x\\", ""), false);
  });

  it("rejects when a digit follows the closing delimiter", () => {
    assert.equal(isPlausibleInlineMath("x", "1"), false);
    assert.equal(isPlausibleInlineMath("x", "t"), true);
  });

  it("accepts ordinary TeX", () => {
    assert.equal(isPlausibleInlineMath("\\frac{1}{2}", " "), true);
  });
});

describe("mathPlaceholder", () => {
  it("picks the wrapper element from `block`, not from `display`", () => {
    assert.match(mathPlaceholder("x", { display: true, block: false }), /^<span class="math-inline" .*data-math-display="1"/);
    assert.match(mathPlaceholder("x", { display: true, block: true }), /^<div class="math-block" /);
  });
});

describe("the shared `marked` singleton", () => {
  it("is untouched by importing this module", () => {
    assert.doesNotMatch(marked.parse("$x$") as string, PENDING);
  });
});
