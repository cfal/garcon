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
          FILE_DRAFT_DATABASE_NAME,
          FILE_DRAFT_SCHEMA_VERSION,
          FILE_CLOSED_DRAFT_LIMIT,
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
        const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(FILE_DRAFT_DATABASE_NAME, 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        let blockedMessage = '';
        try {
          await repository.getViews('synthetic-user', 'synthetic-deployment', 'synthetic-session');
        } catch (error) {
          blockedMessage = (error as Error).message;
        } finally {
          blocker.close();
        }
        await repository.getViews('synthetic-user', 'synthetic-deployment', 'synthetic-session');
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

        const conformance: unknown[] = [];
        for (const candidate of [repository, createMemoryFileDraftRepository()]) {
          const user = 'conformance-user';
          const deployment = 'conformance-deployment';
          const session = 'conformance-session';
          const draft = {
            ...currentDraft,
            documentId: 'conformance-current',
            userNamespace: user,
            deploymentId: deployment,
            browserSessionId: session,
          };
          const other = {
            ...draft,
            documentId: 'other',
            localDocumentId: 'other',
            content: 'other edit',
          };
          await candidate.putDraft(draft);
          await candidate.putDraft({ ...draft, generation: 0, content: 'stale' });
          await candidate.putDraft(other);
          const adopted = await candidate.adoptDraft(other, 'adopted');
          await candidate.resolveDraftConflict(adopted, {
            ...draft,
            generation: 2,
            content: adopted.content,
          });
          await candidate.deleteDraft(draft.documentId, 1);
          const protectedDrafts = await candidate.getDrafts(user, deployment, session);
          const scopedView = {
            ...record,
            userNamespace: user,
            deploymentId: deployment,
            browserSessionId: session,
          };
          await candidate.putView(scopedView);
          await candidate.putView({ ...scopedView, browserSessionId: 'other-session' });
          const viewRead = await candidate.getViews(user, deployment, session);
          viewRead[0]!.line = 99;
          const reread = await candidate.getViews(user, deployment, session);
          const recent = {
            schemaVersion: 1 as const,
            userNamespace: user,
            deploymentId: deployment,
            key: 'recent',
            canonicalFileRootPath: '/synthetic-project',
            normalizedRelativePath: 'file.txt',
            displayPath: 'file.txt',
            revision: 'v1:initial',
            line: 1,
            column: 1,
            viewPreference: 'source' as const,
            timestamp: 1,
          };
          await candidate.putRecent(recent);
          const recentRead = await candidate.getRecents(user, deployment);
          recentRead[0]!.line = 99;
          await candidate.putNavigation({
            schemaVersion: 1,
            userNamespace: user,
            deploymentId: deployment,
            key: JSON.stringify([user, deployment]),
            entries: [recent],
            index: 0,
            updatedAt: 1,
          });
          const history = await candidate.getNavigation(user, deployment);
          const blockedClear = await candidate.clearNamespaceIfUnprotected(
            user,
            deployment,
            session,
          );
          await candidate.deleteDraft(draft.documentId, 2);
          const cleared = await candidate.clearNamespaceIfUnprotected(user, deployment, session);
          const otherViews = await candidate.getViews(user, deployment, 'other-session');
          await candidate.deleteView(scopedView.viewId, user, deployment, 'other-session');
          const emptyViews = await candidate.getViews(user, deployment, 'other-session');
          for (let index = 0; index < FILE_CLOSED_DRAFT_LIMIT; index++) {
            await candidate.putDraft({ ...draft, documentId: `closed-${index}`, closed: true });
          }
          let closedFailure = false;
          try {
            await candidate.putDraft({ ...draft, documentId: 'over-limit', closed: true });
          } catch {
            closedFailure = true;
          }
          await candidate.putDraft({
            ...draft,
            userNamespace: 'another-user',
            documentId: 'separate-budget',
            closed: true,
          });
          await candidate.putDraft({
            ...draft,
            browserSessionId: 'another-session',
            documentId: 'separate-session',
            closed: true,
          });
          conformance.push({
            protectedDrafts: protectedDrafts.map((entry) => entry.content),
            line: reread[0]?.line,
            history,
            blockedClear,
            cleared,
            otherViews: otherViews.length,
            emptyViews: emptyViews.length,
            closedFailure,
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
        const failedRepository = repository;
        const failedRead = failedRepository
          .getViews('synthetic-user', 'synthetic-deployment', 'synthetic-session')
          .catch((error: Error) => {
            failures.push(error.name);
          });
        failedRepository.close();
        await failedRead;
        // Lets the browser report promise rejections after the transaction events have drained.
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          failures,
          retained,
          unhandled,
          afterAbortedChoice,
          afterChoice,
          blockedMessage,
          conformance,
        };
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
      expect(result.blockedMessage).toContain('blocked by another tab');
      expect(result.conformance[0]).toEqual(result.conformance[1]);
      expect(result.conformance[0]).toMatchObject({
        protectedDrafts: ['other edit'],
        line: 1,
        blockedClear: false,
        cleared: true,
        otherViews: 1,
        emptyViews: 0,
        closedFailure: true,
      });
    } finally {
      await browser.close();
      server.stop(true);
    }
  }, 30_000);
});
