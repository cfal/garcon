import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

describe('File draft storage failures', () => {
  test('rolls back failed transactions and handles open failures during close', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const build = await Bun.build({
      entrypoints: [`${root}web/src/lib/files/persistence/file-draft-repository.ts`],
      target: 'browser',
      plugins: [
        {
          name: 'file-repository-aliases',
          setup(builder) {
            builder.onResolve({ filter: /^\$(lib|shared)\// }, ({ path }) => {
              let resolved = path
                .replace(/^\$lib\//, `${root}web/src/lib/`)
                .replace(/^\$shared\//, `${root}common/`);
              if (!existsSync(resolved) && resolved.endsWith('.js'))
                resolved = resolved.slice(0, -3) + '.ts';
              if (!existsSync(resolved) && existsSync(resolved + '.ts')) resolved += '.ts';
              return { path: resolved };
            });
          },
        },
      ],
    });
    if (!build.success) throw new AggregateError(build.logs, 'Repository bundle failed');
    const source = await build.outputs[0]!.text();
    const server = Bun.serve({
      hostname: '0.0.0.0',
      port: 0,
      fetch: () =>
        new Response('<!doctype html><title>Storage failure fixture</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}`);
      const result = await page.evaluate(async (source) => {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const { createFileDraftRepository, FILE_DRAFT_DATABASE_NAME, FILE_DRAFT_SCHEMA_VERSION } =
          (await import(
            url
          )) as typeof import('../../../web/src/lib/files/persistence/file-draft-repository.js');
        URL.revokeObjectURL(url);
        const unhandled: string[] = [];
        window.addEventListener('unhandledrejection', (event) => {
          unhandled.push(String(event.reason));
          event.preventDefault();
        });
        const repository = createFileDraftRepository();
        const record = {
          schemaVersion: 1 as const,
          userNamespace: 'synthetic-user',
          deploymentId: 'synthetic-deployment',
          browserSessionId: 'synthetic-session',
          viewId: 'synthetic-view',
          documentId: 'synthetic-document',
          canonicalFileRootPath: '/synthetic-project',
          normalizedRelativePath: 'file.txt',
          rendererMode: 'code' as const,
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
          scrollLeft: 0,
          scrollTop: 0,
          folds: [],
          updatedAt: 0,
          placement: 'window-main' as const,
        };
        const failures: string[] = [];
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = originalPut.apply(this, args);
          if (this.name === 'views') this.transaction.abort();
          return request;
        };
        try {
          await repository.putView(record);
        } catch (error) {
          failures.push((error as Error).name);
        } finally {
          IDBObjectStore.prototype.put = originalPut;
        }

        // An application failure after a successful request must also roll back that write.
        const originalGetAll = IDBObjectStore.prototype.getAll;
        IDBObjectStore.prototype.getAll = function (...args) {
          if (this.name === 'views') throw new Error('pruning failed');
          return originalGetAll.apply(this, args);
        };
        try {
          await repository.putView(record);
        } catch (error) {
          failures.push((error as Error).message);
        } finally {
          IDBObjectStore.prototype.getAll = originalGetAll;
        }
        const retained = await repository.getViews(
          'synthetic-user',
          'synthetic-deployment',
          'synthetic-session',
        );

        const currentDraft = {
          schemaVersion: 1 as const,
          userNamespace: record.userNamespace,
          deploymentId: record.deploymentId,
          browserSessionId: record.browserSessionId,
          documentId: 'current',
          localDocumentId: 'current',
          canonicalFileRootPath: record.canonicalFileRootPath,
          normalizedRelativePath: record.normalizedRelativePath,
          displayPath: 'file.txt',
          diskRevision: 'v1:initial',
          baselineContent: 'initial',
          content: 'current edit',
          bufferVersion: 1,
          generation: 1,
          savedAt: 1,
          unknownSubmission: null,
          closed: false,
        };
        const alternate = {
          ...currentDraft,
          documentId: 'alternate',
          localDocumentId: 'alternate',
          content: 'alternate edit',
        };
        await repository.putDraft(currentDraft);
        await repository.putDraft(alternate);
        const replacement = { ...currentDraft, generation: 2, content: alternate.content };
        const originalDelete = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function (...args) {
          const request = originalDelete.apply(this, args);
          if (this.name === 'drafts') this.transaction.abort();
          return request;
        };
        try {
          await repository.resolveDraftConflict(alternate, replacement);
        } catch (error) {
          failures.push((error as Error).name);
        } finally {
          IDBObjectStore.prototype.delete = originalDelete;
        }
        const afterAbortedChoice = (
          await repository.getDrafts(
            record.userNamespace,
            record.deploymentId,
            record.browserSessionId,
          )
        )
          .map((draft) => draft.content)
          .sort();
        await repository.resolveDraftConflict(alternate, replacement);
        const afterChoice = await repository.getDrafts(
          record.userNamespace,
          record.deploymentId,
          record.browserSessionId,
        );
        repository.close();

        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(FILE_DRAFT_DATABASE_NAME, FILE_DRAFT_SCHEMA_VERSION + 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        });
        const failedRepository = createFileDraftRepository();
        const failedRead = failedRepository
          .getViews('synthetic-user', 'synthetic-deployment', 'synthetic-session')
          .catch((error: Error) => {
            failures.push(error.name);
          });
        failedRepository.close();
        await failedRead;
        // Lets the browser report promise rejections after the transaction events have drained.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { failures, retained, unhandled, afterAbortedChoice, afterChoice };
      }, source);
      expect(result.failures).toEqual([
        'AbortError',
        'pruning failed',
        'AbortError',
        'VersionError',
      ]);
      expect(result.retained).toEqual([]);
      expect(result.afterAbortedChoice).toEqual(['alternate edit', 'current edit']);
      expect(result.afterChoice).toHaveLength(1);
      expect(result.afterChoice[0]?.content).toBe('alternate edit');
      expect(result.unhandled).toEqual([]);
    } finally {
      await browser.close();
      server.stop(true);
    }
  }, 30_000);
});
