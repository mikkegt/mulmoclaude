// Runtime side of the math pipeline: scans the DOM for the
// `[data-math-pending]` placeholders written by `mathExtension.ts`,
// lazy-loads MathJax on the first hit, typesets each formula to SVG,
// and swaps the placeholder in place with the resulting `<svg>`.
//
// Mirrors `mermaidRender.ts` deliberately — same lazy-load-and-memoise
// shape, same "replace the node so a second pass finds nothing"
// idempotence, same localised error box carrying the source that broke.
//
// Lazy-load: `mathjax-full`'s TeX→SVG pipeline is heavy (~1 MB). The
// dynamic import keeps it out of the initial bundle for the documents —
// most of them — that contain no math at all.
//
// SVG, not CommonHTML: the output is a self-contained `<svg>` drawn in
// `currentColor`, so it needs no stylesheet and no webfont files in the
// published tarball, and it inherits the surrounding theme's text
// colour for free. `fontCache: "local"` keeps each formula's glyph
// `<defs>` inside its own `<svg>` rather than in one shared element at
// the end of the page — a formula stays correct if it is later moved,
// copied, or exported to PDF on its own.

import { adoptSvg } from "../dom/adoptSvg.js";

/** Localised strings the render pipeline surfaces when it fails.
 *  Callers (composables) resolve the keys at component-setup time and
 *  hand the formatter down. Fallback defaults keep the pure module
 *  testable without a Vue / i18n runtime. */
export interface MathRenderLabels {
  loadFailed: (error: string) => string;
  renderFailed: (error: string) => string;
}

const DEFAULT_LABELS: MathRenderLabels = {
  loadFailed: (error) => `⚠ MathJax failed to load: ${error}`,
  renderFailed: (error) => `⚠ Math render failed: ${error}`,
};

/** The one thing the DOM pass needs from `mathjax-full`. Narrow on
 *  purpose: `mathjax-full` is CJS-with-`.d.ts` and has no `exports`
 *  map, so its deep-path types resolve inconsistently between the
 *  plugin's bundler and the host's — keeping the boundary to a single
 *  `string → string` function keeps that out of every caller. */
interface MathTypesetter {
  /** TeX source → `<mjx-container>…<svg>…` markup. */
  render: (tex: string, display: boolean) => string;
}

let typesetterPromise: Promise<MathTypesetter> | null = null;

async function buildTypesetter(): Promise<MathTypesetter> {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }, { LiteElement }] = await Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/AllPackages.js"),
    import("mathjax-full/js/adaptors/lite/Element.js"),
  ]);
  const adaptor = liteAdaptor();
  // `RegisterHTMLHandler` mutates a MathJax-global handler list, so it
  // must run exactly once per page. Memoising the whole builder in
  // `typesetterPromise` is what guarantees that.
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: new SVG({ fontCache: "local" }),
  });
  // `doc` and `adaptor` stay captured here rather than being handed
  // back, so the two calls keep the concrete types the imports gave
  // them and nothing downstream has to assert a node shape.
  return {
    render: (tex, display) => {
      // `AbstractMathDocument.convert` is declared `any`, so the result
      // is narrowed with a real `instanceof` against the lite adaptor's
      // own node class rather than asserted into shape.
      const node: unknown = doc.convert(tex, { display });
      if (!(node instanceof LiteElement)) throw new Error("MathJax returned an unexpected node type");
      return adaptor.outerHTML(node);
    },
  };
}

async function loadTypesetter(): Promise<MathTypesetter> {
  if (typesetterPromise) return typesetterPromise;
  const attempt = buildTypesetter();
  // Share the in-flight promise with parallel callers, but drop the
  // cache once it rejects so a transient failure (offline / stale chunk
  // after a deploy / ad-blocker hiccup) can be retried by the next
  // formula to render. Without this reset the module would be dead
  // until the user reloaded.
  attempt.catch(() => {
    if (typesetterPromise === attempt) typesetterPromise = null;
  });
  typesetterPromise = attempt;
  return attempt;
}

function errorBox(message: string, className: string): HTMLElement {
  const box = document.createElement("code");
  box.className = className;
  box.textContent = message;
  return box;
}

function placeLoadError(nodes: HTMLElement[], err: unknown, labels: MathRenderLabels): void {
  const message = labels.loadFailed(String(err));
  for (const node of nodes) {
    node.replaceWith(errorBox(message, "math-error"));
  }
}

function pendingNodes(root: Element | Document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-math-pending]"));
}

function renderOne(node: HTMLElement, typesetter: MathTypesetter, labels: MathRenderLabels): void {
  // `textContent` gives us the raw TeX — we escaped it going in and
  // DOMPurify preserves text verbatim, so entity decoding is
  // browser-native from the DOM read.
  const source = node.textContent ?? "";
  const display = node.dataset.mathDisplay === "1";
  try {
    const svgNode = adoptSvg(typesetter.render(source, display));
    if (!svgNode) throw new Error("MathJax produced malformed SVG");
    // Keep the placeholder's own element (a `<div>` for block math, a
    // `<span>` inside a paragraph for inline) so the surrounding flow
    // is unchanged — only its contents and the pending flag change.
    node.replaceChildren(svgNode);
    delete node.dataset.mathPending;
  } catch (err) {
    // Preserve the source next to the localised header so the author
    // can see WHICH formula broke.
    node.replaceWith(errorBox(`${labels.renderFailed(String(err))} — ${source}`, "math-error"));
  }
}

/** Typeset every unprocessed math placeholder under `root`. Safe to
 *  call repeatedly — a rendered node loses `data-math-pending` and a
 *  failed one is replaced by an `.math-error` box, so neither matches
 *  a second time. `labels` defaults to English fallbacks so the pure
 *  module remains callable from tests / node environments without an
 *  i18n runtime. */
export async function renderMathNodes(root: Element | Document | null | undefined, labels: MathRenderLabels = DEFAULT_LABELS): Promise<void> {
  if (!root) return;
  const nodes = pendingNodes(root);
  if (nodes.length === 0) return;
  let typesetter: MathTypesetter;
  try {
    typesetter = await loadTypesetter();
  } catch (err) {
    // The dynamic import failed (network / bundler / adblock). Swap
    // every pending placeholder for a visible error box so the user
    // sees WHY the formula is missing instead of raw TeX, and don't let
    // the rejection escape as an unhandled promise (callers fire this
    // via `void run()` in the composable).
    placeLoadError(nodes, err, labels);
    return;
  }
  for (const node of nodes) renderOne(node, typesetter, labels);
}
