import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Deferred, withTimeout } from "../../support/deferred.js";
import { captureBrowserErrors } from '../../support/browser-errors.js';

test("service worker caches late navigation and isolates cache-write failures", async () => {
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("../../../web/src/service-worker/index.ts", import.meta.url),
      ),
    ],
    target: "browser",
    plugins: [
      {
        name: "test-manifest",
        setup(build) {
          build.onResolve({ filter: /^\$app\/(env|manifest)$/ }, ({ path }) => ({
            path,
            namespace: "test-manifest",
          }));
          build.onLoad({ filter: /.*/, namespace: "test-manifest" }, ({ path }) => ({
            contents: path === "$app/env"
              ? "export const version = 'test';"
              : "export const immutable = []; export const assets = [];",
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
  let buildVersion = 'first';
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/_app/version.json") return Response.json({ version: buildVersion });
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
    const browserErrors: string[] = [];
    captureBrowserErrors(context, browserErrors);
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.port}`;
    await page.goto(origin);
    const workerReady = context.waitForEvent("serviceworker");
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js", { type: "module" });
      await navigator.serviceWorker.ready;
    });
    const worker = await workerReady;
    await page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    );

    const readBuildVersion = () => page.evaluate(async () =>
      (await fetch('/_app/version.json')).json(),
    );
    expect(await readBuildVersion()).toEqual({ version: 'first' });
    buildVersion = 'second';
    expect(await readBuildVersion()).toEqual({ version: 'second' });

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
    expect(browserErrors).toEqual([]);
  } finally {
    lateResponse.resolve(new Response("closed"));
    await browser.close();
    await server.stop(true);
  }
}, 30_000);

test.each(['', '/tools/garcon'])("service worker upgrade preserves requested fonts offline at mount %s", async (basePath) => {
  const uiPath = `${basePath}/fonts/ui.woff2`;
  const mathPath = `${basePath}/fonts/math.woff2`;
  const unusedPath = `${basePath}/fonts/unused.woff2`;
  const obsoletePath = `${basePath}/fonts/obsolete.woff2`;
  const ui = Bun.file(fileURLToPath(new URL('../../../web/src/lib/theme/assets/DepartureMono-1.500-core.woff2', import.meta.url)));
  const math = Bun.file(fileURLToPath(new URL('../../../web/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2', import.meta.url)));
  const bundles: string[] = [];
  for (const version of ['old', 'next']) {
    const paths = version === 'old' ? ['fonts/obsolete.woff2'] : ['fonts/ui.woff2', 'fonts/math.woff2', 'fonts/unused.woff2'];
    const bundle = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../../../web/src/service-worker/index.ts', import.meta.url))],
      target: 'browser',
      plugins: [{
        name: 'upgrade-manifest',
        setup(build) {
          build.onResolve({ filter: /^\$app\/(env|manifest)$/ }, ({ path }) => ({ path, namespace: 'upgrade-manifest' }));
          build.onLoad({ filter: /.*/, namespace: 'upgrade-manifest' }, ({ path }) => ({
            contents: path === '$app/env'
              ? `export const version = ${JSON.stringify(version)};`
              : `export const immutable = ${JSON.stringify(paths.map(path => ({ path })))}; export const assets = [];`,
            loader: 'js',
          }));
        },
      }],
    });
    if (!bundle.success) throw new AggregateError(bundle.logs, 'Service worker upgrade bundle failed');
    const source = await bundle.outputs[0]!.text();
    bundles.push(source);
  }
  let upgrading = false;
  const installing = new Deferred<void>();
  const releaseInstall = new Deferred<Response>();
  const fontRequests: string[] = [];
  const shell = () => new Response('<!doctype html><title>Font upgrade proof</title>', { headers: { 'Content-Type': 'text/html' } });
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === `${basePath}/service-worker.js`) return new Response(bundles[upgrading ? 1 : 0], { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } });
      if ([uiPath, mathPath, unusedPath, obsoletePath].includes(path)) {
        fontRequests.push(path);
        return new Response(path === mathPath ? math : ui, { headers: { 'Content-Type': 'font/woff2' } });
      }
      if (upgrading) {
        installing.resolve();
        return releaseInstall.promise;
      }
      return shell();
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.port}`;
    await page.goto(`${origin}${basePath}/`);
    await page.evaluate(async basePath => {
      await navigator.serviceWorker.register(`${basePath}/service-worker.js`, { type: 'module' });
      await navigator.serviceWorker.ready;
    }, basePath);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const oldWorker = context.serviceWorkers()[0]!;
    await oldWorker.evaluate(uiPath => {
      const put = Cache.prototype.put;
      const gate = Promise.withResolvers<void>();
      Reflect.set(globalThis, 'releaseFontCacheWrite', gate.resolve);
      Cache.prototype.put = async function(request, response) {
        const url = typeof request === 'string' ? request : request instanceof Request ? request.url : request.href;
        if (new URL(url, location.origin).pathname === uiPath) await gate.promise;
        return put.call(this, request, response);
      };
    }, uiPath);
    await page.evaluate(async obsoletePath => { await fetch(obsoletePath); }, obsoletePath);
    await page.evaluate(() => navigator.serviceWorker.addEventListener('controllerchange', () => Reflect.set(window, 'fontUpgradeControlled', true)));
    upgrading = true;
    const update = page.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await withTimeout(installing.promise, 10_000, () => 'New worker did not reach its installation barrier');
    await page.evaluate(async paths => {
      for (const [index, path] of paths.entries()) {
        const face = await new FontFace(`UpgradeProof${index}`, `url('${path}')`).load();
        document.fonts.add(face);
        const sample = document.createElement('p');
        sample.style.fontFamily = face.family;
        sample.textContent = 'x + y';
        document.body.append(sample);
      }
      document.body.getBoundingClientRect();
      await document.fonts.ready;
    }, [uiPath, mathPath]);
    const prefix = `garcon:${encodeURIComponent(basePath)}:`;
    await page.waitForFunction(async ({ name, paths }) => {
      const cache = await caches.open(name);
      return (await Promise.all(paths.map(path => cache.match(path)))).every(Boolean);
    }, { name: `${prefix}old`, paths: [mathPath, obsoletePath] });
    releaseInstall.resolve(shell());
    await update;
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed');
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await oldWorker.evaluate(() => Reflect.get(globalThis, 'releaseFontCacheWrite')());
    await page.waitForFunction(() => Reflect.get(window, 'fontUpgradeControlled') === true && navigator.serviceWorker.controller?.state === 'activated');
    const entries = await page.evaluate(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname), `${prefix}next`);
    expect(entries).toContain(uiPath);
    expect(entries).toContain(mathPath);
    expect(entries).not.toContain(unusedPath);
    expect(entries).not.toContain(obsoletePath);
    expect(fontRequests).not.toContain(unusedPath);
    expect(await page.evaluate(() => caches.keys())).not.toContain(`${prefix}old`);

    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await context.setOffline(true);
    await page.reload();
    expect(await page.title()).toBe('Font upgrade proof');
    const offline = await page.evaluate(async paths => {
      const bytes = [];
      for (const [index, path] of paths.entries()) {
        const response = await fetch(path, { cache: 'reload' });
        bytes.push((await response.arrayBuffer()).byteLength);
        const face = await new FontFace(`OfflineProof${index}`, `url('${path}')`).load();
        document.fonts.add(face);
      }
      return bytes;
    }, [uiPath, mathPath]);
    expect(offline).toEqual([ui.size, math.size]);
  } finally {
    releaseInstall.resolve(shell());
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
