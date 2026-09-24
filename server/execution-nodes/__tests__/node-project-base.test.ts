import { expect, spyOn, test } from 'bun:test';
import type { AgentIntegration, NodeAvailability } from '@garcon/server-agent-interface';
import { AgentRpc } from '../rpc.js';
import { serveAgentNode } from '../agent-worker.js';
import { RemoteExecutionNode } from '../remote.js';
import { RemoteAgentIntegration } from '../remote-agent-integration.js';
import { WebSocketLink } from '../websocket-link.js';
import { integrationFixture, linkOptions } from './integration-fixture.js';

function nextAvailability(node: RemoteExecutionNode, expected: NodeAvailability) {
  return new Promise<void>((resolve) => {
    const off = node.onAvailabilityChanged((value) => { if (value === expected) { off(); resolve(); } });
  });
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`fresh sessions accept widened/narrowed bases without replacing facades (${dialer} dials)`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    const errors: string[] = [];
    const node = new RemoteExecutionNode(linkOptions.nodeId, controller, undefined, (message) => errors.push(message));
    const scopes: ReturnType<typeof serveAgentNode>[] = [];
    const generations: ReturnType<typeof integrationFixture>[] = [];
    let base = '/workspace';
    let entered = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    release.resolve();
    worker.onSession((transport) => {
      const fixture = integrationFixture(base);
      const barrier = release.promise;
      const entering = entered;
      fixture.integration.lifecycle.start = async () => { entering.resolve(); await barrier; };
      generations.push(fixture);
      scopes.push(serveAgentNode(fixture.node, new AgentRpc(transport)));
    });
    try {
      const firstReady = nextAvailability(node, 'ready');
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      await firstReady;
      const integration = await node.getAgentIntegration('test');
      const projects = await node.getProjectService();
      const inventory = node.inventory;
      let info = await node.getInfo();

      for (const nextBase of ['/', '/workspace/narrow']) {
        base = nextBase;
        entered = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        const ready = nextAvailability(node, 'ready');
        controller.current!.close();
        await entered.promise;
        expect(node.availability).toBe('offline');
        expect(node.inventory).toEqual(inventory);
        await expect(node.getInfo()).rejects.toMatchObject({ outcome: 'not-dispatched' });
        release.resolve();
        await ready;
        const replacement = await node.getInfo();
        expect(replacement.projectBasePath).toBe(nextBase);
        expect(replacement.instanceId).not.toBe(info.instanceId);
        expect(await node.getAgentIntegration('test')).toBe(integration);
        expect(await node.getProjectService()).toBe(projects);
        expect(node.inventory).toEqual(inventory);
        info = replacement;
      }
      expect(errors).toEqual([]);
    } finally {
      release.resolve();
      await node.dispose(); await worker.dispose();
      await Promise.all(scopes.map((scope) => scope.dispose()));
    }
  });
}

const manifestChanges: Record<string, (integration: AgentIntegration) => AgentIntegration> = {
  descriptor: (integration) => ({ ...integration, descriptor: { ...integration.descriptor, label: 'Changed' } }),
  settings: (integration) => ({ ...integration, settings: { ...integration.settings, defaults: () => ({ ownerId: 'test', schemaVersion: 2, values: {} }) } }),
  capability: (integration) => ({ ...integration, singleQuery: null }),
};

for (const [name, change] of Object.entries(manifestChanges)) {
  test(`a root change does not permit a changed provider ${name}`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    const failure = Promise.withResolvers<string>();
    const node = new RemoteExecutionNode(linkOptions.nodeId, controller, undefined, failure.resolve);
    const scopes: ReturnType<typeof serveAgentNode>[] = [];
    let replacement = false;
    worker.onSession((transport) => {
      const fixture = integrationFixture(replacement ? '/' : '/workspace');
      const integration = replacement ? change(fixture.integration) : fixture.integration;
      scopes.push(serveAgentNode({ ...fixture.node, getAgentIntegration: async () => integration }, new AgentRpc(transport)));
    });
    try {
      const ready = nextAvailability(node, 'ready');
      controller.dial(worker.listen());
      await ready;
      const inventory = node.inventory;
      replacement = true;
      controller.current!.close();
      expect(await failure.promise).toContain('provider capabilities changed');
      expect(node.availability).toBe('offline');
      expect(node.inventory).toEqual(inventory);
    } finally {
      await node.dispose(); await worker.dispose();
      await Promise.all(scopes.map((scope) => scope.dispose()));
    }
  });
}

test('a superseded candidate cannot publish metadata or errors over the accepted session', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const errors: string[] = [];
  const node = new RemoteExecutionNode(linkOptions.nodeId, controller, undefined, (message) => errors.push(message));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scopes: ReturnType<typeof serveAgentNode>[] = [];
  let generation = 0;
  worker.onSession((transport) => {
    const candidate = ++generation;
    const fixture = integrationFixture(candidate === 1 ? '/stale' : '/accepted');
    scopes.push(serveAgentNode(fixture.node, new AgentRpc(transport)));
  });
  const initialize = RemoteAgentIntegration.prototype.initializeReplacement;
  const initialization = spyOn(RemoteAgentIntegration.prototype, 'initializeReplacement')
    .mockImplementation(async function (this: RemoteAgentIntegration, backing, initial) {
      await initialize.call(this, backing, initial);
      if (backing.info.projectBasePath === '/stale') { entered.resolve(); await release.promise; }
    });
  try {
    const ready = nextAvailability(node, 'ready');
    controller.dial(worker.listen());
    await entered.promise;
    controller.current!.close();
    await ready;
    release.resolve();
    await Promise.resolve();
    expect((await node.getInfo()).projectBasePath).toBe('/accepted');
    expect(errors).toEqual([]);
  } finally {
    release.resolve(); initialization.mockRestore();
    await node.dispose(); await worker.dispose();
    await Promise.all(scopes.map((scope) => scope.dispose()));
  }
});
