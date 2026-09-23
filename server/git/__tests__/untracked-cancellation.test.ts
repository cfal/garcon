import { afterEach, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { runGit } from '../run.js';
import { cleanupNodeRuntimeFixtures, nodeRuntimeFixture } from './node-runtime-fixture.js';

afterEach(cleanupNodeRuntimeFixtures);

for (const interruption of ['abort', 'deadline'] as const) {
  test.skipIf(process.platform === 'win32')(`untracked filter ${interruption} terminates descendants before scratch cleanup`, async () => {
    const { projectPath, root, git } = await nodeRuntimeFixture();
    const socketPath = path.join(root, 'filter.sock');
    const ready = Promise.withResolvers<Socket>();
    const stopped = Promise.withResolvers<void>();
    const server = createServer(socket => {
      socket.once('data', () => ready.resolve(socket));
      socket.once('close', () => stopped.resolve());
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const filter = path.join(root, 'filter.js');
    await fs.writeFile(filter, `
import { createConnection } from 'node:net';
process.on('SIGTERM', () => {});
const socket = createConnection(${JSON.stringify(socketPath)}, () => socket.write('ready'));
socket.on('data', () => process.exit(0));
setInterval(() => {}, 1000);
`);
    await fs.writeFile(path.join(projectPath, '.gitattributes'), 'new.txt filter=blocked\n');
    await fs.writeFile(path.join(projectPath, 'new.txt'), 'new content\n');
    await runGit(projectPath, ['config', 'filter.blocked.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(filter)}`]);
    const snapshot = await git.getWorkbenchSnapshot({ projectPath, mode: 'working', context: 2 });
    if (snapshot.status !== 'ready') throw new Error('Expected repository');
    const indexBefore = await fs.readFile(path.join(projectPath, '.git/index'));
    const controller = new AbortController();
    const pending = git.getReviewDocumentFileBodies({
      projectPath, files: ['new.txt'], purpose: 'visible',
      document: { nodeId: snapshot.nodeId, instanceId: snapshot.instanceId, documentId: snapshot.reviewSummary.documentId },
    }, { signal: controller.signal, timeoutMs: interruption === 'deadline' ? 1_000 : 10_000 });
    const settled = pending.then(() => 'success', error => error.code);
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      socket = await ready.promise;
      if (interruption === 'abort') controller.abort();
      const completed = Promise.all([settled, stopped.promise]);
      expect(await Promise.race([
        completed,
        new Promise(resolve => { timer = setTimeout(() => resolve('filter still running'), 2_000); }),
      ])).toEqual(['GIT_TIMEOUT', undefined]);
      expect((await fs.readdir(path.join(projectPath, '.git'))).filter(name => name.startsWith('.garcon-index-'))).toEqual([]);
      expect(await fs.readFile(path.join(projectPath, '.git/index'))).toEqual(indexBefore);
      expect((await git.getRepoInfo({ projectPath })).isGitRepository).toBe(true);
    } finally {
      clearTimeout(timer);
      socket?.write('release');
      controller.abort();
      await settled;
      socket?.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);
}
