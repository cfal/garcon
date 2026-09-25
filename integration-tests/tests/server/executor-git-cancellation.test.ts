import { expect, test } from 'bun:test';
import { watch } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { ExecutionGitResults } from '../../../common/git-execution.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { withTimeout } from '../../support/deferred.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test.skipIf(process.platform === 'win32')(`HTTP cancellation terminates clean filters and removes scratch indexes (${executionBackend})`, async () => {
    await withIntegrationFixture(`git-cancel-${executionBackend}`, async fixture => {
      const { client } = fixture;
      const project = fixture.executionDirs.project;
      await initializeFixtureRepository(project);
      const socketPath = join(fixture.dirs.root, 'filter.sock');
      const ready = Promise.withResolvers<Socket>();
      const stopped = Promise.withResolvers<void>();
      const server = createServer(socket => {
        socket.once('data', () => ready.resolve(socket));
        socket.once('close', () => stopped.resolve());
      });
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      const filter = join(fixture.dirs.root, 'filter.js');
      await writeFile(filter, `
import { createConnection } from 'node:net';
process.on('SIGTERM', () => {});
const socket = createConnection(${JSON.stringify(socketPath)}, () => socket.write('ready'));
socket.on('data', () => process.exit(0));
setInterval(() => {}, 1000);
`);
      await writeFile(join(project, '.gitattributes'), 'new.txt filter=blocked\n');
      await writeFile(join(project, 'new.txt'), 'new content\n');
      await runFixtureGit(project, 'config', 'filter.blocked.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`);
      const target = { project, executorId: client.executorId };
      const snapshot = await client.post<ExecutionGitResults['getWorkbenchSnapshot']>('/api/v1/git/workbench/snapshot', { ...target, mode: 'working', context: 2 });
      if (snapshot.status !== 'ready') throw new Error('Expected repository');
      const indexBefore = await readFile(join(project, '.git/index'));
      const controller = new AbortController();
      const pending = fixture.client.fetch(`/api/v1/git/review-documents/files`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ ...target, files: ['new.txt'], purpose: 'visible', document: {
          executorId: client.executorId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId,
        } }),
      }).catch(error => error);
      let socket: Socket | undefined;
      let awaitingCleanup = false;
      const cleaned = Promise.withResolvers<void>();
      const scratch = () => readdir(join(project, '.git')).then(entries => entries.filter(name => name.startsWith('.garcon-index-')));
      const watcher = watch(join(project, '.git'), () => {
        if (awaitingCleanup) void scratch().then(entries => { if (entries.length === 0) cleaned.resolve(); });
      });
      try {
        socket = await withTimeout(ready.promise, 5_000, () => 'Filter did not start');
        expect((await scratch()).length).toBeGreaterThan(0);
        awaitingCleanup = true;
        controller.abort();
        expect(await pending).toMatchObject({ name: 'AbortError' });
        await withTimeout(Promise.all([stopped.promise, cleaned.promise]), 3_000, () => 'Filter or scratch index survived cancellation');
        expect(await scratch()).toEqual([]);
        expect(await readFile(join(project, '.git/index'))).toEqual(indexBefore);
      } finally {
        watcher.close();
        socket?.write('release');
        controller.abort();
        await pending;
        socket?.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, { executionBackend, projectRoots: 'separate' });
  }, 60_000);
}
