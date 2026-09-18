import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExecutionNodeProcess } from '../../support/execution-backend.js';
import { WebSocketLink } from '../../../server/execution-nodes/websocket-link.js';

for (const ending of ['shutdown', 'intentional crash', 'unexpected exit'] as const) {
  test(`worker harness retains exit classification after readiness: ${ending}`, async () => {
    const root = await mkdtemp(join(homedir(), 'garcon-worker-exit-'));
    const directories = {
      root, workspace: join(root, 'workspace'), project: join(root, 'project'),
      home: join(root, 'home'), config: join(root, 'config'),
    };
    const connection = {
      nodeId: 'synthetic-worker', secret: 'synthetic-shared-secret-at-least-32-characters',
      allowInsecureDevelopment: true,
    };
    const controller = new WebSocketLink({ ...connection, role: 'controller' });
    let worker: ExecutionNodeProcess | null = null;
    try {
      for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
      worker = await ExecutionNodeProcess.start({
        repoRoot: resolve(import.meta.dir, '../../..'), directories, environment: { PATH: '/usr/bin:/bin' },
        config: { ...connection, connection: { kind: 'listen', port: 0 } },
      });
      controller.dial(await worker.listening());
      await worker.ready();
      if (ending === 'unexpected exit') {
        worker.child.kill('SIGKILL');
        await worker.child.exited;
        await expect(worker.stop()).rejects.toThrow('Execution worker exited');
      } else {
        if (ending === 'intentional crash') await worker.crash();
        await expect(worker.stop()).resolves.toBeUndefined();
      }
    } finally {
      await controller.dispose();
      await worker?.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
