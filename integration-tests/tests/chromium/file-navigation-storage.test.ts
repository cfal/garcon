import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

test('file navigation discards obsolete backups and survives failed storage transactions', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const build = await Bun.build({
    entrypoints: [`${root}web/src/lib/files/persistence/file-navigation-repository.ts`],
    target: 'browser',
    plugins: [{
      name: 'file-repository-aliases',
      setup(builder) {
        builder.onResolve({ filter: /^\$(lib|shared)\// }, ({ path }) => {
          let resolved = path.replace(/^\$lib\//, `${root}web/src/lib/`).replace(/^\$shared\//, `${root}common/`);
          if (!existsSync(resolved) && resolved.endsWith('.js')) resolved = resolved.slice(0, -3) + '.ts';
          if (!existsSync(resolved) && existsSync(resolved + '.ts')) resolved += '.ts';
          return { path: resolved };
        });
      },
    }],
  });
  if (!build.success) throw new AggregateError(build.logs, 'Repository bundle failed');
  const source = await build.outputs[0]!.text();
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('<!doctype html><title>Navigation storage</title>', { headers: { 'content-type': 'text/html' } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const result = await page.evaluate(async source => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const { createFileNavigationRepository, navigationKey, FILE_NAVIGATION_DATABASE_NAME, FILE_NAVIGATION_SCHEMA_VERSION } =
        await import(url) as typeof import('../../../web/src/lib/files/persistence/file-navigation-repository.js');
      URL.revokeObjectURL(url);
      const unhandled: string[] = [];
      window.addEventListener('unhandledrejection', event => { unhandled.push(String(event.reason)); event.preventDefault(); });
      const user = 'synthetic-user';
      const deployment = 'synthetic-deployment';
      const recent = {
        schemaVersion: 1 as const, userNamespace: user, deploymentId: deployment,
        key: 'file', executorId: 'local', canonicalFileRootPath: '/project', normalizedRelativePath: 'file.txt',
        displayPath: 'file.txt', revision: 'v1:initial', line: 1, column: 1, viewPreference: 'source' as const, timestamp: 1,
      };
      const history = { schemaVersion: 1 as const, userNamespace: user, deploymentId: deployment, key: navigationKey(user, deployment), entries: [recent], index: 0, updatedAt: 1 };
      const old = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(FILE_NAVIGATION_DATABASE_NAME, 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('drafts', { keyPath: 'documentId' }).put({ documentId: 'obsolete', content: 'Synthetic old backup' });
          request.result.createObjectStore('recents', { keyPath: 'key' }).put(recent);
          request.result.createObjectStore('navigation', { keyPath: 'key' }).put(history);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const repository = createFileNavigationRepository();
      let blockedMessage = '';
      try { await repository.getRecents(user, deployment); }
      catch (error) { blockedMessage = (error as Error).message; }
      finally { old.close(); }
      const restored = await repository.getRecents(user, deployment);
      const restoredHistory = await repository.getNavigation(user, deployment);
      const stores = await new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open(FILE_NAVIGATION_DATABASE_NAME);
        request.onsuccess = () => { resolve([...request.result.objectStoreNames]); request.result.close(); };
        request.onerror = () => reject(request.error);
      });
      const failures: string[] = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        this.transaction.abort();
        return request;
      };
      try { await repository.putNavigation({ ...history, index: -1 }); }
      catch (error) { failures.push((error as Error).name); }
      finally { IDBObjectStore.prototype.put = put; }
      const afterFailure = await repository.getNavigation(user, deployment);
      await repository.putNavigation({ ...history, updatedAt: 2 });
      const afterRetry = await repository.getNavigation(user, deployment);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(FILE_NAVIGATION_DATABASE_NAME, FILE_NAVIGATION_SCHEMA_VERSION + 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { request.result.close(); resolve(); };
      });
      const failedRead = repository.getRecents(user, deployment).catch((error: Error) => { failures.push(error.name); });
      repository.close();
      await failedRead;
      await new Promise(resolve => setTimeout(resolve, 0));
      return { restored, restoredHistory, stores, afterFailure, afterRetry, failures, blockedMessage, unhandled };
    }, source);
    expect(result.stores).toEqual(['navigation', 'recents']);
    expect(result.restored).toMatchObject([{ normalizedRelativePath: 'file.txt' }]);
    expect(result.restoredHistory?.entries).toEqual(result.restored);
    expect(result.afterFailure).toEqual(result.restoredHistory);
    expect(result.afterRetry?.updatedAt).toBe(2);
    expect(result.failures).toEqual(['AbortError', 'VersionError']);
    expect(result.blockedMessage).toContain('blocked by another tab');
    expect(result.unhandled).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30_000);
