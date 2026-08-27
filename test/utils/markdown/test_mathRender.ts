// End-to-end guard for the math pipeline's ONE fragile seam: the
// placeholders `mathExtension` writes have to survive
// `sanitizeMarkdownHtml` intact, because everything after that point
// runs on what DOMPurify left behind.
//
// This is not a hypothetical concern. KaTeX's MathML output, the
// obvious alternative, loses `<semantics>`/`<annotation>` to DOMPurify
// while KEEPING the annotation's text — the raw LaTeX source then
// renders as visible garbage beside the formula. The two-step
// placeholder + MathJax-SVG design exists to avoid that, and this test
// is what pins it.
//
// Runs the real `mathjax-full`, so it is slower than the pure
// `packages/markdown-utils/test/test_mathExtension.ts` unit tests —
// those cover the delimiter rules; this covers the hand-offs.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Marked } from "marked";
import { mathExtension } from "@mulmoclaude/markdown-utils/markdown/mathExtension";

const SOURCE = [
  "牛丼は $100 と $200 です。US$5 too.",
  "",
  "円周率は $\\pi$ で、Einstein said $E=mc^2$.",
  "",
  "$$",
  "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
  "$$",
].join("\n");

let body: HTMLElement;
let renderMathNodes: typeof import("@mulmoclaude/markdown-utils/markdown/mathRender").renderMathNodes;

before(async () => {
  // DOMPurify and `adoptSvg` both read ambient browser globals at
  // import time, so the window has to be installed before either module
  // is loaded — hence the dynamic imports below.
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const globals = globalThis as unknown as Record<string, unknown>;
  const win = dom.window as unknown as Record<string, unknown>;
  globals.window = dom.window;
  // `Node` / `Element` / `HTMLElement` are what DOMPurify's own
  // environment probe looks for; `DOMParser` is what `adoptSvg` uses.
  for (const name of ["document", "DOMParser", "Node", "Element", "HTMLElement"]) {
    globals[name] = win[name];
  }

  ({ renderMathNodes } = await import("@mulmoclaude/markdown-utils/markdown/mathRender"));
  const { sanitizeMarkdownHtml } = await import("@mulmoclaude/core/plugin-vue");

  const mathMd = new Marked();
  mathMd.use(mathExtension);
  ({ body } = dom.window.document);
  body.innerHTML = sanitizeMarkdownHtml(mathMd.parse(SOURCE) as string);
});

describe("math placeholders through sanitizeMarkdownHtml", () => {
  it("survives DOMPurify with the pending flag and display mode intact", () => {
    const pending = body.querySelectorAll("[data-math-pending]");
    assert.equal(pending.length, 3);
    assert.equal(body.querySelectorAll('[data-math-display="1"]').length, 1);
    assert.equal(body.querySelectorAll("div.math-block").length, 1);
  });

  it("keeps the TeX source readable as text content", () => {
    const block = body.querySelector("div.math-block");
    assert.equal(block?.textContent, "\\int_0^1 x^2\\,dx = \\frac{1}{3}");
  });

  it("leaves prices as prose", () => {
    assert.match(body.textContent ?? "", /牛丼は \$100 と \$200 です。US\$5 too\./);
  });
});

describe("renderMathNodes", () => {
  it("replaces every placeholder with a self-contained SVG", async () => {
    await renderMathNodes(body);
    assert.equal(body.querySelectorAll("svg").length, 3);
    assert.equal(body.querySelectorAll("[data-math-pending]").length, 0);
    assert.equal(body.querySelectorAll(".math-error").length, 0);
    // `currentColor` is what makes the formula follow the surrounding
    // theme without a stylesheet.
    assert.match(body.innerHTML, /currentColor/);
  });

  it("is idempotent — a second pass finds nothing to do", async () => {
    const first = body.innerHTML;
    await renderMathNodes(body);
    assert.equal(body.innerHTML, first);
  });
});
