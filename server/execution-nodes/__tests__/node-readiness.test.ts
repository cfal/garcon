import { expect, test } from 'bun:test';
import { AgentRpc } from '../rpc.js';
import { serveAgentNode } from '../agent-worker.js';
import { RemoteExecutionNode } from '../remote.js';
import { WebSocketLink } from '../websocket-link.js';
import { integrationFixture, linkOptions } from './integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`worker receives controller identity and remote waits for lifecycle (${dialer} dials)`, async () => {
    const nodeId = '22222222-2222-4222-8222-222222222222';
    const controller = new WebSocketLink({ ...linkOptions, nodeId, role: 'controller' });
    const { nodeId: _unused, ...workerOptions } = linkOptions;
    const worker = new WebSocketLink({ ...workerOptions, role: 'worker' });
    const node = new RemoteExecutionNode(nodeId, controller);
    const entering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    node.onAvailabilityChanged((value) => { if (value === 'ready') ready.resolve(); });
    let scope: ReturnType<typeof serveAgentNode> | undefined;
    worker.onSession((transport) => {
      expect(transport.nodeId).toBe(nodeId);
      const fixture = integrationFixture('/workspace', transport.nodeId);
      fixture.integration.lifecycle.start = async () => { entering.resolve(); await release.promise; };
      scope = serveAgentNode(fixture.node, new AgentRpc(transport));
    });
    try {
      expect(node.id).toBe(nodeId);
      expect(node.availability).toBe('offline');
      await expect(node.getAgentIntegration('test')).rejects.toMatchObject({ outcome: 'not-dispatched' });
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      await entering.promise;
      expect(worker.nodeId).toBe(nodeId);
      expect(node.availability).toBe('offline');
      release.resolve();
      await ready.promise;
      expect((await node.getAgentIntegration('test')).producers.scope.nodeId).toBe(nodeId);
    } finally { release.resolve(); await node.dispose(); await worker.dispose(); await scope?.dispose(); }
  });
}
