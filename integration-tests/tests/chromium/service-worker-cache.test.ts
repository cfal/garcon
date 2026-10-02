import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Deferred, withTimeout } from "../../support/deferred.js";

test("service worker caches late navigation and isolates cache-write failures", async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("../../../web/src/service-worker.ts", import.meta.url),
      ),
    ],
    target: "browser",
    plugins: [
      {
        name: "test-manifest",
        setup(build) {
          build.onResolve({ filter: /^\$service-worker$/ }, () => ({
            path: "manifest",
            namespace: "test-manifest",
          }));
          build.onLoad({ filter: /.*/, namespace: "test-manifest" }, () => ({
            contents:
              "export const build = []; export const files = []; export const version = 'test';",
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!bundle.success)
    throw new AggregateError(bundle.logs, "Service worker bundle failed");
  const workerSource = await bundle.outputs[0]!.text();
  const lateRequest = new Deferred<void>();
  const lateResponse = new Deferred<Response>();
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/service-worker.js") {
        return new Response(workerSource, {
          headers: { "Content-Type": "text/javascript" },
        });
      }
      if (path === "/late") {
        lateRequest.resolve();
        return lateResponse.promise;
      }
      if (path.startsWith("/asset")) return new Response("asset bytes");
      return new Response("<!doctype html><title>Offline shell</title>", {
        headers: { "Content-Type": "text/html" },
      });
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.port}`;
    await page.goto(origin);
    const workerReady = context.waitForEvent("serviceworker");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js");
      await navigator.serviceWorker.ready;
    });
    const worker = await workerReady;
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );

    const navigation = page.goto(`${origin}/late`);
    await withTimeout(
      lateRequest.promise,
      10_000,
      () => "Navigation never reached the network",
    );
    await navigation;
    expect(await page.title()).toBe("Offline shell");
    lateResponse.resolve(
      new Response("<!doctype html><title>Late response</title>", {
        headers: { "Content-Type": "text/html" },
      }),
    );
    await page.waitForFunction(
      async () => (await caches.match("/late")) !== undefined,
    );
    expect(
      await page.evaluate(async () => (await caches.match("/late"))?.text()),
    ).toContain("Late response");

    await worker.evaluate(() => {
      const failures: string[] = [];
      Reflect.set(globalThis, "cacheFailures", failures);
      globalThis.addEventListener("unhandledrejection", (event) => {
        if (event instanceof PromiseRejectionEvent)
          failures.push(String(event.reason));
      });
      Cache.prototype.put = async () => {
        throw new Error("Synthetic quota failure");
      };
    });
    expect(
      await page.evaluate(async () => (await fetch("/asset-one")).text()),
    ).toBe("asset bytes");
    // A second fetch event lets rejection handling from the first event finish.
    expect(
      await page.evaluate(async () => (await fetch("/asset-two")).text()),
    ).toBe("asset bytes");
    expect(
      await worker.evaluate(() => Reflect.get(globalThis, "cacheFailures")),
    ).toEqual([]);
    expect(
      await page.evaluate(
        async () => (await caches.match("/asset-one")) === undefined,
      ),
    ).toBe(true);
  } finally {
    lateResponse.resolve(new Response("closed"));
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
