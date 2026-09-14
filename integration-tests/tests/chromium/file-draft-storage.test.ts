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
        const {
          createFileDraftRepository,
          createMemoryFileDraftRepository,
          fileDraftKey,
          navigationKey,
          FILE_DRAFT_DATABASE_NAME,
          FILE_DRAFT_SCHEMA_VERSION,
          FILE_DRAFT_LIMIT,
        } = (await import(
          url
        )) as typeof import('../../../web/src/lib/files/persistence/file-draft-repository.js');
        URL.revokeObjectURL(url);
        const unhandled: string[] = [];
        window.addEventListener('unhandledrejection', (event) => {
          unhandled.push(String(event.reason));
          event.preventDefault();
        });
        const repository = createFileDraftRepository();
        const user = 'synthetic-user';
        const deployment = 'synthetic-deployment';
        const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(FILE_DRAFT_DATABASE_NAME, 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        let blockedMessage = '';
        try {
          await repository.getDrafts(user, deployment);
        } catch (error) {
          blockedMessage = (error as Error).message;
        } finally {
          blocker.close();
        }
        await repository.getDrafts(user, deployment);
        const draft = {
          schemaVersion: 1 as const,
          userNamespace: user,
          deploymentId: deployment,
          documentId: fileDraftKey(user, deployment, '/project', 'file.txt'),
          canonicalFileRootPath: '/project',
          normalizedRelativePath: 'file.txt',
          content: 'local edit',
          savedAt: 1,
        };
        const failures: string[] = [];
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = originalPut.apply(this, args);
          if (this.name === 'drafts') this.transaction.abort();
          return request;
        };
        try {
          await repository.putDraft(draft);
        } catch (error) {
          failures.push((error as Error).name);
        } finally {
          IDBObjectStore.prototype.put = originalPut;
        }
        const retained = await repository.getDrafts(user, deployment);
        await repository.putDraft(draft);

        // Deleting the previous backup and writing its replacement share a transaction.
        IDBObjectStore.prototype.put = function (...args) {
          if (this.name === 'drafts') throw new Error('write failed');
          return originalPut.apply(this, args);
        };
        try {
          await repository.putDraft({ ...draft, content: 'replacement' });
        } catch (error) {
          failures.push((error as Error).message);
        } finally {
          IDBObjectStore.prototype.put = originalPut;
        }
        const afterFailure = await repository.getDrafts(user, deployment);
        await repository.clearDrafts(user, deployment);

        const conformance: unknown[] = [];
        for (const candidate of [repository, createMemoryFileDraftRepository()]) {
          await candidate.putDraft(draft);
          await candidate.putDraft({ ...draft, content: 'latest', savedAt: 2 });
          const read = await candidate.getDrafts(user, deployment);
          read[0]!.content = 'mutated read';
          const reread = await candidate.getDrafts(user, deployment);
          await candidate.deleteDraft(draft.documentId);
          const empty = await candidate.getDrafts(user, deployment);
          for (let i = 0; i <= FILE_DRAFT_LIMIT; i++) {
            await candidate.putDraft({
              ...draft,
              documentId: fileDraftKey(user, deployment, '/project', i + '.txt'),
              normalizedRelativePath: i + '.txt',
              savedAt: i,
            });
          }
          const bounded = await candidate.getDrafts(user, deployment);
          const recent = {
            schemaVersion: 1 as const,
            userNamespace: user,
            deploymentId: deployment,
            key: 'recent',
            canonicalFileRootPath: '/project',
            normalizedRelativePath: 'file.txt',
            displayPath: 'file.txt',
            revision: 'v1:initial',
            line: 1,
            column: 1,
            viewPreference: 'source' as const,
            timestamp: 1,
          };
          await candidate.putRecent(recent);
          const recents = await candidate.getRecents(user, deployment);
          recents[0]!.line = 99;
          await candidate.putNavigation({
            schemaVersion: 1,
            userNamespace: user,
            deploymentId: deployment,
            key: navigationKey(user, deployment),
            entries: [recent],
            index: 0,
            updatedAt: 1,
          });
          const history = await candidate.getNavigation(user, deployment);
          await candidate.putDraft({
            ...draft,
            userNamespace: 'other',
            documentId: fileDraftKey('other', deployment, '/project', 'file.txt'),
          });
          await candidate.clearDrafts(user, deployment);
          conformance.push({
            reread,
            empty,
            bounded: bounded.map((entry) => entry.normalizedRelativePath),
            recentLine: (await candidate.getRecents(user, deployment))[0]!.line,
            history,
            cleared: await candidate.getDrafts(user, deployment),
            otherCount: (await candidate.getDrafts('other', deployment)).length,
          });
        }
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(FILE_DRAFT_DATABASE_NAME, FILE_DRAFT_SCHEMA_VERSION + 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        });
        const failedRead = repository.getDrafts(user, deployment).catch((error: Error) => {
          failures.push(error.name);
        });
        repository.close();
        await failedRead;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          failures,
          retained,
          afterFailure,
          unhandled,
          blockedMessage,
          conformance,
        };
      }, source);
      expect(result.failures).toEqual(['AbortError', 'write failed', 'VersionError']);
      expect(result.retained).toEqual([]);
      expect(result.afterFailure).toMatchObject([{ content: 'local edit' }]);
      expect(result.unhandled).toEqual([]);
      expect(result.blockedMessage).toContain('blocked by another tab');
      expect(result.conformance[0]).toEqual(result.conformance[1]);
      expect(result.conformance[0]).toMatchObject({
        reread: [{ content: 'latest' }],
        empty: [],
        cleared: [],
        otherCount: 1,
        recentLine: 1,
        bounded: Array.from({ length: 20 }, (_, i) => 20 - i + '.txt'),
      });
    } finally {
      await browser.close();
      server.stop(true);
    }
  }, 30_000);
});
