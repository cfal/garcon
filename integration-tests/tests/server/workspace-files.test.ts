import { describe, expect, test } from 'bun:test';
import { link, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReadTextResponse, parseSaveTextResponse, type SaveTextRequest } from '../../../common/file-contracts.js';
import { isRecord } from '../../../common/json.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';

function saveGate() {
  const held = new Deferred<void>();
  const queued = new Deferred<Record<string, unknown>>();
  const secondSettled = new Deferred<Record<string, unknown>>();
  const release = new Deferred<void>();
  const executed: number[] = [];
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    async fetch(request) {
      const payload: unknown = await request.json();
      if (!isRecord(payload) || typeof payload.index !== 'number') return new Response(null, { status: 400 });
      switch (new URL(request.url).pathname) {
        case '/held':
          executed.push(payload.index);
          held.resolve();
          await release.promise;
          break;
        case '/queued': queued.resolve(payload); break;
        case '/executing': executed.push(payload.index); break;
        case '/settled': if (payload.index === 2) secondSettled.resolve(payload); break;
        default: return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 204 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`, executed,
    waitForHeld: () => withTimeout(held.promise, 5_000, () => 'First save did not acquire its canonical file lock'),
    waitForQueued: () => withTimeout(queued.promise, 5_000, () => 'Second save did not queue on the same canonical file lock'),
    waitForSecondSettlement: () => withTimeout(secondSettled.promise, 5_000, () => 'Cancelled save did not settle while the lock was held'),
    release: () => release.resolve(),
    async dispose() { release.resolve(); await server.stop(true); },
  };
}

function fileUrl(filePath: string, projectPath: string): string {
  return `/api/v1/files/text?${new URLSearchParams({ projectPath, path: filePath })}`;
}

async function readText(fixture: IntegrationFixture, filePath = 'sample.txt') {
  const result = parseReadTextResponse(await fixture.client.get(fileUrl(filePath, fixture.dirs.project)));
  if (!result) throw new Error('Invalid workspace file read response');
  return result;
}

function saveText(fixture: IntegrationFixture, filePath: string, request: SaveTextRequest, signal?: AbortSignal) {
  return fetch(`${fixture.garcon.baseUrl}${fileUrl(filePath, fixture.dirs.project)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${fixture.authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
}

function fixtureOptions(gate: ReturnType<typeof saveGate>, alias: 'hard-link' | 'symlink' = 'symlink') {
  return {
    authentication: 'account' as const, bindAddress: '0.0.0.0',
    preloadModules: [fileURLToPath(new URL('../../support/workspace-files-preload.ts', import.meta.url))],
    resolveServerEnvironment: (directories: { project: string }) => ({
      GARCON_TEST_FILE_SAVE_PATH: join(directories.project, 'sample.txt'),
      GARCON_TEST_FILE_SAVE_GATE: gate.url,
    }),
    async prepareWorkspace(directories: { project: string }) {
      const source = join(directories.project, 'sample.txt');
      await writeFile(source, 'synthetic initial file');
      await writeFile(join(directories.project, 'other.txt'), 'synthetic other file');
      await (alias === 'hard-link' ? link : symlink)(source, join(directories.project, 'alias.txt'));
    },
  };
}

describe('workspace files through HTTP', () => {
  test('selects the identity owner before interpreting its file path', async () => {
    await withIntegrationFixture('workspace-identity-owner', async (fixture) => {
      for (const filePath of ['', '/abs', '../outside']) {
        const query = new URLSearchParams({ chatId: '1000000000000001', path: filePath });
        const request = () => fetch(`${fixture.garcon.baseUrl}/api/v1/files/identity?${query}`, {
          headers: { Authorization: `Bearer ${fixture.authToken}` }, signal: AbortSignal.timeout(15_000),
        });
        const missing = await request();
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'Chat not found or missing projectPath' });
        query.delete('chatId');
        query.set('projectPath', fixture.dirs.project);
        const invalid = await request();
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: filePath === '../outside'
          ? 'A valid relative file path is required' : 'A relative file path is required' });
      }
    }, { authentication: 'account', bindAddress: '0.0.0.0' });
  }, 30_000);

  test('sanitizes unexpected project-inspection failures for listing and identity', async () => {
    await withIntegrationFixture('workspace-file-inspection-error', async (fixture) => {
      const query = new URLSearchParams({ projectPath: join(fixture.dirs.project, 'x'.repeat(300)), path: 'sample.txt' });
      for (const operation of ['list', 'identity']) {
        const response = await fetch(`${fixture.garcon.baseUrl}/api/v1/files/${operation}?${query}`, {
          headers: { Authorization: `Bearer ${fixture.authToken}` }, signal: AbortSignal.timeout(15_000),
        });
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({
          success: false, error: 'Internal server error', errorCode: 'INTERNAL_ERROR', retryable: true,
        });
      }
    }, { authentication: 'account', bindAddress: '0.0.0.0' });
  }, 30_000);

  test('cancels a file-tree read without logging a server failure or returning an empty tree', async () => {
    const held = new Deferred<void>();
    const aborted = new Deferred<void>();
    const responded = new Deferred<unknown>();
    const release = new Deferred<void>();
    const gate = Bun.serve({
      hostname: '0.0.0.0', port: 0,
      async fetch(request) {
        switch (new URL(request.url).pathname) {
          case '/held': held.resolve(); await release.promise; break;
          case '/aborted': aborted.resolve(); break;
          case '/responded': responded.resolve(await request.json()); break;
          default: return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 204 });
      },
    });
    try {
      await withIntegrationFixture('workspace-tree-cancellation', async (fixture) => {
        const cancellation = new AbortController();
        const request = fetch(`${fixture.garcon.baseUrl}/api/v1/files/tree`, {
          headers: { Authorization: `Bearer ${fixture.authToken}` },
          signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(15_000)]),
        }).catch((error: unknown) => error);
        try {
          await withTimeout(held.promise, 5_000, () => 'Tree enumeration did not reach its barrier');
          cancellation.abort();
          await withTimeout(aborted.promise, 5_000, () => 'HTTP cancellation did not reach tree enumeration');
          release.resolve();
          expect(await request).toMatchObject({ name: 'AbortError' });
          expect(await withTimeout(responded.promise, 5_000, () => 'Cancelled tree route did not settle'))
            .toEqual({ status: 499 });
        } finally {
          cancellation.abort();
          release.resolve();
          await request;
        }
        await fixture.garcon.stop();
        expect(fixture.garcon.logs.filter((line) => line.includes('[routes:files]') || line.includes('[http:error]')))
          .toEqual([]);
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/workspace-files-cancellation-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_FILE_READ_GATE: `http://127.0.0.1:${gate.port}/` },
      });
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  }, 30_000);

  test('cancels a waiting save without writing when its canonical lock becomes available', async () => {
    const gate = saveGate();
    try {
      await withIntegrationFixture('workspace-save-cancellation', async (fixture) => {
        const original = await readText(fixture);
        const cancellation = new AbortController();
        const first = saveText(fixture, 'sample.txt', {
          content: 'synthetic first save', expectedRevision: original.revision, conflictResolution: 'reject',
        });
        let second: Promise<Response | Error> | undefined;
        try {
          await gate.waitForHeld();
          second = saveText(fixture, 'alias.txt', {
            content: 'synthetic cancelled save', expectedRevision: original.revision, conflictResolution: 'overwrite',
          }, cancellation.signal).catch((error: Error) => error);
          expect(await gate.waitForQueued()).toMatchObject({ hasSignal: true });
          cancellation.abort();
          expect(await second).toMatchObject({ name: 'AbortError' });
          expect(await gate.waitForSecondSettlement()).toMatchObject({ kind: 'rejected', aborted: true });
          expect(await readFile(join(fixture.dirs.project, 'sample.txt'), 'utf8')).toBe(original.content);
          gate.release();
          const response = await first;
          expect(response.status).toBe(200);
          const saved = parseSaveTextResponse(await response.json());
          expect(saved).not.toBeNull();
          expect((await readText(fixture)).content).toBe('synthetic first save');
          const successor = await saveText(fixture, 'alias.txt', {
            content: 'synthetic explicit successor', expectedRevision: saved!.revision, conflictResolution: 'reject',
          });
          expect(successor.status).toBe(200);
          expect((await readText(fixture)).content).toBe('synthetic explicit successor');
          expect(gate.executed).toEqual([1, 3]);
        } finally {
          cancellation.abort();
          gate.release();
          await Promise.allSettled([first, second]);
        }
      }, fixtureOptions(gate));
    } finally {
      await gate.dispose();
    }
  }, 30_000);

  for (const alias of ['hard-link', 'symlink'] as const) {
    test(`serializes revision-checked saves through a ${alias} alias`, async () => {
      const gate = saveGate();
      try {
        await withIntegrationFixture(`workspace-save-${alias}`, async (fixture) => {
          const original = await readText(fixture);
          expect((await readText(fixture, 'alias.txt')).revision).toBe(original.revision);
          const first = saveText(fixture, 'sample.txt', {
            content: 'synthetic first save', expectedRevision: original.revision, conflictResolution: 'reject',
          });
          let second: Promise<Response> | undefined;
          try {
            await gate.waitForHeld();
            second = saveText(fixture, 'alias.txt', {
              content: 'synthetic stale save', expectedRevision: original.revision, conflictResolution: 'reject',
            });
            await gate.waitForQueued();
            gate.release();
            expect((await first).status).toBe(200);
            const conflict = await second;
            expect(conflict.status).toBe(409);
            expect(await conflict.json()).toMatchObject({ errorCode: 'FILE_REVISION_CONFLICT' });
            expect((await readText(fixture, 'alias.txt')).content).toBe('synthetic first save');
          } finally {
            gate.release();
            await Promise.allSettled([first, second]);
          }
        }, fixtureOptions(gate, alias));
      } finally {
        await gate.dispose();
      }
    }, 30_000);
  }

  test('refuses an overwrite when its contained alias changes while waiting for the lock', async () => {
    const gate = saveGate();
    try {
      await withIntegrationFixture('workspace-save-contained-replacement', async (fixture) => {
        const original = await readText(fixture);
        const first = saveText(fixture, 'sample.txt', {
          content: 'synthetic first save', expectedRevision: original.revision, conflictResolution: 'reject',
        });
        let second: Promise<Response> | undefined;
        try {
          await gate.waitForHeld();
          second = saveText(fixture, 'alias.txt', {
            content: 'synthetic wrong target save', expectedRevision: original.revision, conflictResolution: 'overwrite',
          });
          await gate.waitForQueued();
          await unlink(join(fixture.dirs.project, 'alias.txt'));
          await symlink(join(fixture.dirs.project, 'other.txt'), join(fixture.dirs.project, 'alias.txt'));
          gate.release();
          expect((await first).status).toBe(200);
          const conflict = await second;
          expect(conflict.status).toBe(409);
          expect(await conflict.json()).toMatchObject({ errorCode: 'FILE_REVISION_CONFLICT' });
          expect((await readText(fixture)).content).toBe('synthetic first save');
          expect((await readText(fixture, 'alias.txt')).content).toBe('synthetic other file');
        } finally {
          gate.release();
          await Promise.allSettled([first, second]);
        }
      }, fixtureOptions(gate));
    } finally {
      await gate.dispose();
    }
  }, 30_000);
});
