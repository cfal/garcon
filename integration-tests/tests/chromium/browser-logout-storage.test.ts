import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

let directory: string;
let bundle: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'logout-storage-contract-'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const entry = join(directory, 'entry.ts');
  await writeFile(
    entry,
    [
      'web/src/lib/utils/browser-data-lifetime.ts',
      'web/src/lib/auth/logout-cleanup.ts',
      'web/src/lib/files/persistence/file-draft-repository.ts',
    ]
      .map((path) => `export * from ${JSON.stringify(join(root, path))};`)
      .join('\n') +
      `
    import { CanvasExitGuard } from ${JSON.stringify(join(root, 'web/src/lib/chat-canvas/canvas-exit-guard.ts'))};
    export function installDirtyCanvasGuard() {
      new CanvasExitGuard({ list() { throw new Error('Unsaved recovery'); }, read: () => null, write() {}, remove() {} }, () => null).activate();
    }
  `,
  );
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    tsconfig: join(root, 'web/tsconfig.json'),
    conditions: ['browser'],
  });
  if (!built.success) throw new Error(built.logs.join('\n'));
  bundle = await built.outputs[0]!.text();
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

type Module = typeof import('../../../web/src/lib/utils/browser-data-lifetime.js') &
  typeof import('../../../web/src/lib/auth/logout-cleanup.js') &
  typeof import('../../../web/src/lib/files/persistence/file-draft-repository.js') & {
    installDirtyCanvasGuard(): void;
  };
type TestWindow = typeof globalThis & {
  logoutModule: Module;
  logoutRepository: ReturnType<Module['createFileDraftRepository']>;
  releaseCleanup: () => void;
  cleanupResult: Promise<boolean>;
  cleanupDeadline: number;
};

for (const outcome of ['completed', 'expired'] as const) {
  test(`fresh persistence survives ${outcome} cleanup and retired documents cannot delete it or block exit`, async () => {
    await withChromiumFixture('logout-storage-races', async ({ page, context, integration }) => {
      await context.route('**/logout-contract.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: bundle }),
      );
      await context.route('**/logout-contract-host', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Logout storage contract</title>',
        }),
      );
      await page.goto(`${integration.garcon.baseUrl}/logout-contract-host`);
      await page.evaluate(async () => {
        const scope = globalThis as TestWindow;
        const url = new URL('logout-contract.js', location.href).href;
        const api: Module = await import(url);
        scope.logoutModule = api;
        api.captureBrowserDataLifetime();
        scope.logoutRepository = api.createFileDraftRepository();
        await scope.logoutRepository.putDraft({
          schemaVersion: 1,
          deploymentId: 'test',
          userNamespace: 'user',
          documentId: 'old',
          canonicalFileRootPath: '/project',
          normalizedRelativePath: 'old.txt',
          content: 'Old draft',
          savedAt: 1,
        });
        api.installDirtyCanvasGuard();
        const before = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(before);
        if (!before.defaultPrevented)
          throw new Error('The exit guard must be active before logout');
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, version) => {
          const request = version === undefined ? open(name) : open(name, version);
          if (name === api.FILE_DRAFT_DATABASE_NAME && version === undefined) {
            request.addEventListener(
              'success',
              (event) => {
                event.stopImmediatePropagation();
                scope.releaseCleanup = () => request.onsuccess?.call(request, event);
              },
              { once: true },
            );
          }
          return request;
        };
        const logout = api.publishBrowserLogout();
        scope.cleanupDeadline = logout.deadline;
        scope.cleanupResult = api.clearBrowserPrivateData(logout);
        const after = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(after);
        if (after.defaultPrevented) throw new Error('Logout must bypass the exit guard');
      });
      await page.waitForFunction(() => !!(globalThis as TestWindow).releaseCleanup);
      const fresh = await context.newPage();
      try {
        await fresh.goto(`${integration.garcon.baseUrl}/logout-contract-host`);
        expect(
          await fresh.evaluate(async () => {
            const scope = globalThis as TestWindow;
            const api: Module = await import(new URL('logout-contract.js', location.href).href);
            scope.logoutModule = api;
            api.captureBrowserDataLifetime();
            scope.logoutRepository = api.createFileDraftRepository();
            return api.canPersistBrowserData();
          }),
        ).toBe(false);
        if (outcome === 'expired') {
          const afterDeadline = await page.evaluate(
            () => (globalThis as TestWindow).cleanupDeadline + 1,
          );
          await page.clock.setFixedTime(afterDeadline);
          await fresh.clock.setFixedTime(afterDeadline);
        } else {
          expect(
            await page.evaluate(async () => {
              const scope = globalThis as TestWindow;
              scope.releaseCleanup();
              return await scope.cleanupResult;
            }),
          ).toBe(true);
        }
        await fresh.evaluate(async () => {
          const scope = globalThis as TestWindow;
          await scope.logoutModule.waitForBrowserLogoutCleanup();
          await scope.logoutRepository.putDraft({
            schemaVersion: 1,
            deploymentId: 'test',
            userNamespace: 'user',
            documentId: 'fresh',
            canonicalFileRootPath: '/project',
            normalizedRelativePath: 'fresh.txt',
            content: 'Fresh draft',
            savedAt: 2,
          });
        });
        if (outcome === 'expired') {
          expect(
            await page.evaluate(async () => {
              const scope = globalThis as TestWindow;
              scope.releaseCleanup();
              return await scope.cleanupResult;
            }),
          ).toBe(false);
        }
        expect(
          await page.evaluate(async () => {
            try {
              await (globalThis as TestWindow).logoutRepository.clearDrafts('user', 'test');
              return false;
            } catch {
              return true;
            }
          }),
        ).toBe(true);
        expect(
          await fresh.evaluate(async () =>
            (await (globalThis as TestWindow).logoutRepository.getDrafts('user', 'test')).map(
              (row) => row.documentId,
            ),
          ),
        ).toEqual(outcome === 'completed' ? ['fresh'] : ['fresh', 'old']);
      } finally {
        await fresh.close();
      }
    });
  }, 120_000);
}
