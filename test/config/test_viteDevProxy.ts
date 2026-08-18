// The dev proxy is the only thing keeping an iframe `src` off Vite's SPA catch-all,
// and the failure is silent in the worst way: index.html answers 200, so the pane
// renders blank and the console blames CORS on `/@vite/client` (#2928 — `/htmlfile`
// had been missing since the mount was added, while `/artifacts/html` beside it was
// fine, so build, lint and test all stayed green).
//
// So the check is against the URLs the View ACTUALLY builds, not a second list of
// prefixes: a new URL shape from the plugin fails here rather than in a blank pane.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { htmlArtifactPreviewUrl, htmlFileUrl } from "@mulmoclaude/html-plugin";
import viteConfig, { PROXIED_BACKEND_PREFIXES } from "../../vite.config.js";

const proxyPrefixes = Object.keys(viteConfig.server?.proxy ?? {});

const isCoveredBy = (prefixes: readonly string[], url: string): boolean => prefixes.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));

/** Every URL shape `packages/plugins/html-plugin/src/vue/View.vue` can put in its
 *  iframe `src`, built by the same helpers the View calls. */
const iframeSources: readonly (readonly [string, string | null])[] = [
  ["a page presentHtml wrote", htmlArtifactPreviewUrl("artifacts/html/2026/08/report.html")],
  ["an absolute path presentHtml was pointed at", htmlFileUrl("/Users/someone/proj/demo.html")],
  ["a workspace-relative path presentHtml was pointed at", htmlFileUrl("docs/report.html")],
];

describe("vite dev proxy", () => {
  iframeSources.forEach(([label, url]) => {
    it(`forwards the iframe src for ${label} to the backend`, () => {
      assert.notEqual(url, null, `the html plugin built no URL for ${label} — the fixture path no longer qualifies`);
      assert.equal(isCoveredBy(proxyPrefixes, url ?? ""), true, `${url} is not proxied — Vite's SPA catch-all would answer it with index.html`);
    });
  });

  // The LAN guard is a SECOND list, and a prefix proxied without being guarded is
  // reachable from the network whenever MULMOCLAUDE_DEV_LAN is set — these mounts
  // are deliberately bearer-exempt, so the loopback check is their only protection.
  it("guards every proxied prefix against non-loopback callers", () => {
    proxyPrefixes.forEach((prefix) => {
      assert.equal(
        isCoveredBy(PROXIED_BACKEND_PREFIXES, prefix),
        true,
        `${prefix} is proxied to the backend but no PROXIED_BACKEND_PREFIXES entry covers it — it would be reachable from the LAN`,
      );
    });
  });
});
