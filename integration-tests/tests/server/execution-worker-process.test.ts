import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExecutionNodeProcess } from '../../support/execution-backend.js';
import { WebSocketLink } from '../../../server/execution-nodes/websocket-link.js';
import { parseConnectionUrl } from '../../../server/execution-nodes/connection-url.js';

for (const ending of ['shutdown', 'intentional crash', 'unexpected exit'] as const) {
  test(`worker harness retains exit classification after connection: ${ending}`, async () => {
    const root = await mkdtemp(join(homedir(), 'garcon-worker-exit-'));
    const directories = {
      root, workspace: join(root, 'workspace'), project: join(root, 'project'),
      home: join(root, 'home'), config: join(root, 'config'),
    };
    let controller: WebSocketLink | null = null;
    let worker: ExecutionNodeProcess | null = null;
    try {
      for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
      worker = await ExecutionNodeProcess.start({
        repoRoot: resolve(import.meta.dir, '../../..'), directories, environment: { PATH: '/usr/bin:/bin' },
        connection: { kind: 'listen', port: 0 },
      });
      const connection = parseConnectionUrl(await worker.connectionUrl());
      const url = new URL(connection.socketUrl);
      url.hostname = '127.0.0.1';
      controller = new WebSocketLink({ role: 'controller', nodeId: '22222222-2222-4222-8222-222222222222', secret: connection.secret, allowInsecureDevelopment: true });
      controller.dial(url.href);
      await worker.connected();
      expect(worker.logs.join('\n')).not.toContain('execution-node-ready');
      expect(worker.logs.join('\n')).not.toContain(connection.secret);
      if (ending === 'unexpected exit') {
        worker.child.kill('SIGKILL');
        await worker.child.exited;
        await expect(worker.stop()).rejects.toThrow('Execution worker exited');
      } else {
        if (ending === 'intentional crash') await worker.crash();
        await expect(worker.stop()).resolves.toBeUndefined();
      }
    } finally {
      await controller?.dispose();
      await worker?.stop().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
