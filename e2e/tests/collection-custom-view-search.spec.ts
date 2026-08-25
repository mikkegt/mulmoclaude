import { test, expect, type Page } from "@playwright/test";
import { mockAllApis } from "../fixtures/api";

// The standard table's search box drives a custom view too (#2959): the host
// relays what the user types into the sandboxed iframe, where the injected
// `__MC_VIEW.searchQuery` / `.onSearchQueryChange(cb)` bridge exposes it. This
// exercises the whole chain in a real browser — watcher → postMessage → the
// bootstrap's listener → the view's own DOM.

const SEARCH_VIEW = { id: "search", label: "Search", file: "views/search.html", capabilities: ["read"] };

const DETAIL = {
  collection: {
    slug: "news",
    title: "News",
    icon: "rss_feed",
    source: "feed",
    schema: {
      title: "News",
      icon: "rss_feed",
      dataPath: "data/feeds/news",
      primaryKey: "id",
      fields: { id: { type: "string", label: "ID", primary: true } },
      views: [SEARCH_VIEW],
    },
  },
  items: [{ id: "a" }, { id: "b" }],
};

// Renders whatever the host relays, and counts callbacks so the debounce is
// observable (a per-keystroke relay would push the count past 1).
const VIEW_HTML = `<!doctype html><html><head></head><body>
<div id="query">unset</div>
<div id="calls">0</div>
<script>
  var view = window.__MC_VIEW;
  var calls = 0;
  function paint(query) {
    document.getElementById('query').textContent = query ? query : '(empty)';
  }
  paint(view.searchQuery);
  view.onSearchQueryChange(function (query) {
    calls++;
    document.getElementById('calls').textContent = String(calls);
    paint(query);
  });
</script>
</body></html>`;

async function setup(page: Page) {
  await mockAllApis(page);
  await page.route(
    (url) => url.pathname === "/api/collections/news",
    (route) => route.fulfill({ json: DETAIL }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/news/view-token",
    (route) => route.fulfill({ json: { token: "tok-123", exp: Date.now() + 3_600_000, dataUrl: "/api/collections/news/view-data", capabilities: ["read"] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/collections/news/view-file",
    (route) => route.fulfill({ contentType: "text/html", body: VIEW_HTML }),
  );
}

const viewFrame = (page: Page) => page.frameLocator('[data-testid="collection-custom-view-iframe"]');

test.describe("standard search box → custom view", () => {
  test("relays what the user types, and the cleared box after it", async ({ page }) => {
    await setup(page);
    await page.goto("/collections/news");
    await page.getByTestId("collection-view-custom-search").click();
    await expect(page.getByTestId("collection-custom-view-iframe")).toBeVisible();
    await expect(viewFrame(page).locator("#query")).toHaveText("(empty)");

    await page.getByPlaceholder("Search records…").fill("kafka");
    await expect(viewFrame(page).locator("#query")).toHaveText("kafka");
    // One callback for the settled value — not one per character of "kafka".
    await expect(viewFrame(page).locator("#calls")).toHaveText("1");

    await page.getByPlaceholder("Search records…").fill("");
    await expect(viewFrame(page).locator("#query")).toHaveText("(empty)");
  });

  test("seeds a view opened after the query was already typed", async ({ page }) => {
    await setup(page);
    await page.goto("/collections/news");
    // Type in the table view first — no iframe exists to receive the message,
    // so the relay has to happen when the frame loads.
    await page.getByPlaceholder("Search records…").fill("kafka");
    await page.getByTestId("collection-view-custom-search").click();
    await expect(viewFrame(page).locator("#query")).toHaveText("kafka");
  });

  test("hides the host's match count while a custom view is active", async ({ page }) => {
    await setup(page);
    await page.goto("/collections/news");
    // The count describes the host's own field matching, which a custom view
    // does not share — so it may only appear on the built-in views.
    await expect(page.getByText("Showing 2 of 2")).toBeVisible();
    await page.getByTestId("collection-view-custom-search").click();
    await expect(page.getByText(/Showing \d+ of \d+/)).toHaveCount(0);
    await page.getByTestId("collection-view-toggle-table").click();
    await expect(page.getByText("Showing 2 of 2")).toBeVisible();
  });
});
