import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExecutionNodeProcess } from '../../support/execution-backend.js';
import { WebSocketLink } from '../../../server/execution-nodes/websocket-link.js';
import { parseConnectionUrl } from '../../../server/execution-nodes/connection-url.js';
import { RemoteExecutionNode } from '../../../server/execution-nodes/remote.js';
import { AgentRpc } from '../../../server/execution-nodes/rpc.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { withTimeout } from '../../support/deferred.js';

for (const ending of ['shutdown', 'intentional crash', 'unexpected exit'] as const) {
  test(`worker harness retains exit classification after connection: ${ending}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-worker-exit-'));
    const directories = {
      root, workspace: join(root, 'config', 'execution-node'), project: join(root, 'project'),
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

test('re-adding a running worker under a new node identity requires restarting that worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'garcon-worker-identity-'));
  const directories = {
    root, workspace: join(root, 'config', 'execution-node'), project: join(root, 'project'),
    home: join(root, 'home'), config: join(root, 'config'),
  };
  const controllers: WebSocketLink[] = [];
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
    for (const nodeId of ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']) {
      const controller = new WebSocketLink({ role: 'controller', nodeId, secret: connection.secret, allowInsecureDevelopment: true });
      controllers.push(controller);
      if (controllers.length === 1) {
        const connected = RemoteExecutionNode.connect(controller);
        controller.dial(url.href);
        await withTimeout(connected, 10_000, () => worker!.logs.join('\n'));
      } else {
        const session = Promise.withResolvers<AgentRpc>();
        const unsubscribe = controller.onSession((transport) => session.resolve(new AgentRpc(transport)));
        controller.dial(url.href);
        const rpc = await withTimeout(session.promise, 10_000, () => worker!.logs.join('\n'));
        await rpc.transport.ready;
        const reverseCalls: string[] = [];
        rpc.handle(async (call) => {
          reverseCalls.push(call.method);
          return { serverInstanceId: 'synthetic-controller', defaultNodeId: nodeId, workspaceName: null };
        });
        await expect(discoverRuntime({ configDir: directories.config, runtime: 'execution-node' }))
          .rejects.toThrow('HTTP 503');
        expect(reverseCalls).toEqual([]);
        const description = await rpc.call('', 'node.describe', null);
        expect(description.info.nodeId).toBe('22222222-2222-4222-8222-222222222222');
        await expect(rpc.call('', 'projects.inspect', { projectPath: directories.project }))
          .rejects.toMatchObject({ outcome: 'not-dispatched' });
        rpc.retireUnknown();
        unsubscribe();
        const failure = Promise.withResolvers<string>();
        const remote = new RemoteExecutionNode(nodeId, controller, undefined, failure.resolve);
        try {
          const message = await withTimeout(failure.promise, 10_000, () => worker!.logs.join('\n'));
          expect(message).toContain('restart the worker to serve');
          expect(remote.availability).toBe('offline');
        } finally { await remote.dispose(); }
      }
      await controller.dispose();
    }
  } finally {
    for (const controller of controllers) await controller.dispose();
    await worker?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
