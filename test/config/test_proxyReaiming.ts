// Does a RUNNING Vite proxy actually follow the backend to a new port? (#2995)
//
// The whole fix rests on one property of Vite's bundled http-proxy: each request
// spreads the same object stored as `proxy.options`, so writing
// `proxy.options.target` takes effect from the next request. That is a property
// of a dependency, not of our code — the kind of thing that changes silently on
// an upgrade — so it is pinned here against the real thing rather than argued in
// a comment.
//
// Two backends answer with their own name; the test asks Vite which one it
// reached, before and after the switch. Nothing is mocked: real sockets, a real
// Vite dev server, a real proxy.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer as createViteServer, type ViteDevServer } from "vite";

interface Backend {
  port: number;
  close: () => Promise<void>;
}

/** A backend that answers `/api/who` with its own label. */
async function startBackend(label: string): Promise<Backend> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ who: label }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "expected a bound TCP address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The shape `vite.config.ts` re-aims: an http-proxy instance whose stored
 *  options are re-read per request. */
interface Reaimable {
  options: { target?: unknown };
}

async function whoAnswered(vitePort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${vitePort}/api/who`);
  const body: unknown = await res.json();
  assert.ok(typeof body === "object" && body !== null && "who" in body, "expected the backend's own answer");
  return String((body as { who: unknown }).who);
}

describe("a running Vite proxy can be re-aimed at another backend", () => {
  let first: Backend;
  let second: Backend;
  let vite: ViteDevServer;
  const captured: Reaimable[] = [];

  before(async () => {
    first = await startBackend("first");
    second = await startBackend("second");
    vite = await createViteServer({
      configFile: false,
      root: process.cwd(),
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        proxy: {
          "/api": {
            target: `http://127.0.0.1:${first.port}`,
            changeOrigin: true,
            // Exactly what `vite.config.ts` does: keep the instance so its
            // target can be rewritten later.
            configure: (proxy: unknown) => captured.push(proxy as Reaimable),
          },
        },
      },
    });
    await vite.listen();
  });

  after(async () => {
    await vite?.close();
    await first?.close();
    await second?.close();
  });

  it("reaches the backend it was configured with", async () => {
    const address = vite.httpServer?.address();
    assert.ok(address !== null && typeof address === "object");
    assert.equal(await whoAnswered(address.port), "first");
  });

  it("reaches the OTHER backend after its target is rewritten", async () => {
    const address = vite.httpServer?.address();
    assert.ok(address !== null && typeof address === "object");

    assert.equal(captured.length, 1, "the proxy instance must be reachable through `configure`");
    captured.forEach((proxy) => {
      proxy.options.target = `http://127.0.0.1:${second.port}`;
    });

    // If http-proxy ever snapshots its options at creation instead of spreading
    // them per request, this is the assertion that says so — and the whole
    // runtime-following design would need rethinking rather than a patch.
    assert.equal(await whoAnswered(address.port), "second", "rewriting proxy.options.target must take effect on the next request");
  });
});
