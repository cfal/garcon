import { expect, test } from 'bun:test';
import { ExecutorRpc } from '../../../remote/transport/rpc.js';
import { serveExecutionRuntime } from '../../../remote/server/executor-rpc-server.js';
import { RemoteExecutorClient } from '../../../remote/client/executor-client.js';
import { WebSocketLink } from '../../../remote/transport/websocket-link.js';
import { integrationFixture, linkOptions } from '../../../remote/__tests__/integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`worker receives controller identity and remote waits for lifecycle (${dialer} dials)`, async () => {
    const executorId = '22222222-2222-4222-8222-222222222222';
    const controller = new WebSocketLink({ ...linkOptions, executorId, role: 'controller' });
    const { executorId: _unused, ...workerOptions } = linkOptions;
    const worker = new WebSocketLink({ ...workerOptions, role: 'worker' });
    const executor = new RemoteExecutorClient(executorId, controller);
    const entering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    executor.onAvailabilityChanged((value) => { if (value === 'ready') ready.resolve(); });
    let scope: ReturnType<typeof serveExecutionRuntime> | undefined;
    worker.onSession((transport) => {
      expect(transport.executorId).toBe(executorId);
      const fixture = integrationFixture('/workspace', transport.executorId);
      fixture.integration.lifecycle.start = async () => { entering.resolve(); await release.promise; };
      scope = serveExecutionRuntime(fixture.executor, new ExecutorRpc(transport));
    });
    try {
      expect(executor.id).toBe(executorId);
      expect(executor.availability).toBe('offline');
      await expect(executor.getAgentIntegration('test')).rejects.toMatchObject({ outcome: 'not-dispatched' });
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      await entering.promise;
      expect(worker.executorId).toBe(executorId);
      expect(executor.availability).toBe('offline');
      release.resolve();
      await ready.promise;
      expect((await executor.getAgentIntegration('test')).producers.scope.executorId).toBe(executorId);
    } finally { release.resolve(); await executor.dispose(); await worker.dispose(); await scope?.dispose(); }
  });
}
