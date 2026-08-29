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
import { mathExtension, mathPlaceholder } from "@mulmoclaude/markdown-utils/markdown/mathExtension";

const SOURCE = [
  "牛丼は $100 と $200 です。US$5 too.",
  "",
  "円周率は $\\pi$ で、Einstein said $E=mc^2$.",
  "",
  "$$",
  "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
  "$$",
].join("\n");

// MathJax's `html` TeX package implements `\href`, so this is real TeX
// that produces a real `<a href>` — and the SVG is inserted after the
// markdown-level sanitiser has already run.
const XSS_SOURCE = "click $\\href{javascript:alert(document.domain)}{here}$ and $\\href{https://example.com}{there}$";

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

describe("renderMathNodes — sanitisation", () => {
  it("strips a `javascript:` href smuggled in through \\href, and keeps a safe one", async () => {
    const mathMd = new Marked();
    mathMd.use(mathExtension);
    const { sanitizeMarkdownHtml } = await import("@mulmoclaude/core/plugin-vue");
    const host = document.createElement("div");
    host.innerHTML = sanitizeMarkdownHtml(mathMd.parse(XSS_SOURCE) as string);
    document.body.appendChild(host);
    await renderMathNodes(host);

    assert.doesNotMatch(host.innerHTML, /javascript:/);
    assert.match(host.innerHTML, /https:\/\/example\.com/);
    host.remove();
  });

  it("inlines every glyph so nothing depends on a <use> the sanitiser drops", async () => {
    // `fontCache: "none"`. DOMPurify removes `<use>` elements outright,
    // so a `<defs>`-plus-`<use>` formula would survive sanitisation with
    // its geometry intact and no glyphs drawn.
    await renderMathNodes(body);
    assert.equal(body.querySelectorAll("use").length, 0);
    assert.ok(body.querySelectorAll("path").length > 0);
  });
});

describe("renderMathNodes — accessibility", () => {
  it("hides the SVG from assistive tech and exposes MathML instead", async () => {
    await renderMathNodes(body);
    // MathJax's SVG is `role="img"` with no accessible name, so on its
    // own a screen reader announces an unlabelled graphic where the
    // formula is. `AssistiveMmlHandler` marks it hidden and emits the
    // MathML counterpart beside it.
    const svgs = [...body.querySelectorAll("svg")];
    assert.ok(svgs.length > 0);
    assert.ok(svgs.every((svg) => svg.getAttribute("aria-hidden") === "true"));

    const mathml = [...body.querySelectorAll("math")];
    assert.equal(mathml.length, svgs.length);
    // Real maths markup, not a LaTeX string read out character by
    // character: `\\pi` must reach the reader as the symbol.
    assert.ok(mathml.some((node) => node.textContent?.includes("π")));
    assert.ok(mathml.every((node) => node.querySelector("mi, mo, mn, mrow") !== null));
  });

  it("keeps the MathML out of sight without removing it from the a11y tree", async () => {
    await renderMathNodes(body);
    const wrapper = body.querySelector(".math-a11y");
    assert.ok(wrapper);
    const style = wrapper.getAttribute("style") ?? "";
    // `display:none` / `visibility:hidden` would drop the node from the
    // accessibility tree, which is the entire point of keeping it.
    assert.doesNotMatch(style, /display:\s*none|visibility:\s*hidden/);
    assert.match(style, /clip-path:\s*inset\(50%\)/);
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

// The TeX `html` package also implements `\style` and `\class`, so both
// attributes are author-controlled the same way `\href` is. DOMPurify's
// defaults keep them, which is fine here — MulmoClaude renders a file
// from the user's own disk, and CSS positioning does not apply to SVG
// child elements anyway. It is NOT fine for a host that renders
// stranger-written markdown on a signed-in origin and has banned both
// attributes at the markdown level; that host passes its own extra pass,
// which runs AFTER the baseline rather than instead of it.
const STYLED_SOURCE = "$\\style{position:fixed;inset:0;background:#fff}{x}$ and $\\class{fixed inset-0}{y}$";

describe("renderMathNodes — host hardening pass", () => {
  const styledHost = async (): Promise<HTMLElement> => {
    const mathMd = new Marked();
    mathMd.use(mathExtension);
    const { sanitizeMarkdownHtml } = await import("@mulmoclaude/core/plugin-vue");
    const host = document.createElement("div");
    host.innerHTML = sanitizeMarkdownHtml(mathMd.parse(STYLED_SOURCE) as string);
    document.body.appendChild(host);
    return host;
  };

  it("keeps \\style and \\class by default — which is why the parameter exists", async () => {
    const host = await styledHost();
    await renderMathNodes(host);
    assert.match(host.innerHTML, /position:\s*fixed/);
    assert.match(host.innerHTML, /class="[^"]*inset-0/);
    host.remove();
  });

  it("still strips a `javascript:` href when the host's pass would not have", async () => {
    // THE BASELINE IS NOT A DEFAULT A CALLER CAN DECLINE (codex, #2983). The motivating host
    // writes a targeted transformer — drop `class` and `style`, keep the rest — and a
    // REPLACEMENT would have silently re-admitted the one thing `sanitizeMathSvg` exists to
    // stop. `harden` runs after it, so the identity function below is safe by construction.
    const mathMd = new Marked();
    mathMd.use(mathExtension);
    const { sanitizeMarkdownHtml } = await import("@mulmoclaude/core/plugin-vue");
    const host = document.createElement("div");
    host.innerHTML = sanitizeMarkdownHtml(mathMd.parse(XSS_SOURCE) as string);
    document.body.appendChild(host);
    await renderMathNodes(host, undefined, (markup) => markup);

    assert.doesNotMatch(host.innerHTML, /javascript:/);
    assert.match(host.innerHTML, /https:\/\/example\.com/);
    host.remove();
  });

  it("cannot have markup INJECTED by a hardener that adds instead of removing", async () => {
    // A hardener returns an arbitrary string, so nothing in its type says it only took things
    // away (coderabbit, #2983). The pass after it is what makes the contract true rather than
    // documented: this one appends a live handler, and the page never sees it.
    const host = await styledHost();
    await renderMathNodes(host, undefined, (markup) => `${markup}<img src=x onerror="alert(1)">`);

    assert.doesNotMatch(host.innerHTML, /onerror/);
    assert.ok(host.querySelectorAll("svg").length > 0);
    host.remove();
  });

  it("applies a stricter policy when one is passed, and still draws the formula", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const host = await styledHost();
    await renderMathNodes(host, undefined, (markup) => DOMPurify.sanitize(markup, { FORBID_ATTR: ["class", "style"] }));

    assert.doesNotMatch(host.innerHTML, /position:\s*fixed/);
    assert.doesNotMatch(host.innerHTML, /inset-0/);
    // Stripped of the author's attributes, not of the formula: both
    // placeholders still resolve to a drawn SVG rather than an error box.
    assert.equal(host.querySelectorAll("svg").length, 2);
    assert.equal(host.querySelectorAll(".math-error").length, 0);
    assert.ok(host.querySelectorAll("path").length > 0);
    host.remove();
  });
});

// The paths where a formula does NOT come out. The suite above pins what
// the pipeline keeps out (`javascript:`) and what it draws; these pin
// what it does when drawing fails — which is the half a host author
// meets first, because the hardener they write is what breaks it.
describe("renderMathNodes — 描けなかったとき", () => {
  const inlineHost = (tex: string): HTMLElement => {
    const host = document.createElement("div");
    host.innerHTML = mathPlaceholder(tex, { display: false, block: false });
    document.body.appendChild(host);
    return host;
  };

  it("hardener が <svg> を落としたら、ソース付きの error box に置き換える", async () => {
    // `MathHardener` の doc が「消すと壊れる」と名指ししている2つのうちの
    // 一方。ホストが自分のポリシーを書くとき最初に踏む落とし穴なので、
    // 契約が doc だけでなくテストにもある状態にする。
    const host = inlineHost("x^2");
    await renderMathNodes(host, undefined, () => "<span>svg を落とすポリシー</span>");

    const box = host.querySelector(".math-error");
    assert.ok(box, "error box に置き換わること");
    assert.equal(host.querySelectorAll("svg").length, 0);
    // どの式が壊れたか著者に見えること。
    assert.match(box.textContent ?? "", /x\^2/);
    host.remove();
  });

  it("error box は placeholder ごと置き換える — pending が残らない", async () => {
    // 残ると次の `renderMathNodes` が同じ式をもう一度組もうとする。
    const host = inlineHost("y^2");
    await renderMathNodes(host, undefined, () => "<span>no svg</span>");
    assert.equal(host.querySelectorAll("[data-math-pending]").length, 0);

    const afterFirst = host.innerHTML;
    await renderMathNodes(host, undefined, () => "<span>no svg</span>");
    assert.equal(host.innerHTML, afterFirst, "2回目は何もしない");
    host.remove();
  });

  it("壊れた TeX は error box ではなく MathJax 自身のエラー字形になる", async () => {
    // 直感に反するので固定しておく。MathJax は例外を投げず、エラーを
    // 描いた SVG を返すため `renderOne` の catch には入らない。既存の
    // テストは `.math-error` が 0 件であることしか見ておらず、この
    // 読み方はどこにも書かれていなかった。MathJax が将来投げるように
    // なれば、ここが最初に赤くなる。
    const host = inlineHost("\\frac{");
    await renderMathNodes(host);

    assert.equal(host.querySelectorAll(".math-error").length, 0);
    assert.equal(host.querySelectorAll("svg").length, 1);
    assert.match(host.textContent ?? "", /Missing close brace/);
    host.remove();
  });

  it("未定義マクロも同じ扱い", async () => {
    const host = inlineHost("\\nosuchmacro{x}");
    await renderMathNodes(host);
    assert.equal(host.querySelectorAll(".math-error").length, 0);
    assert.equal(host.querySelectorAll("svg").length, 1);
    host.remove();
  });

  it("root が無いときは何もせず返る", async () => {
    // 呼び出し側は Vue の ref を渡すので、マウント前は null になりうる。
    await assert.doesNotReject(renderMathNodes(null));
    await assert.doesNotReject(renderMathNodes(undefined));
  });
});
