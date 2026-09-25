import { expect, spyOn, test } from 'bun:test';
import type { AgentIntegration, ExecutorAvailability } from '@garcon/server-agent-interface';
import { ExecutorRpc } from '../transport/rpc.js';
import { serveExecutionRuntime } from '../server/executor-rpc-server.js';
import { RemoteExecutorClient } from '../client/executor-client.js';
import { RemoteAgentIntegration } from '../client/remote-agent-integration.js';
import { WebSocketLink } from '../transport/websocket-link.js';
import { integrationFixture, linkOptions } from './integration-fixture.js';

function nextAvailability(executor: RemoteExecutorClient, expected: ExecutorAvailability) {
  return new Promise<void>((resolve) => {
    const off = executor.onAvailabilityChanged((value) => { if (value === expected) { off(); resolve(); } });
  });
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`fresh sessions accept widened/narrowed bases without replacing facades (${dialer} dials)`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
    const errors: string[] = [];
    const executor = new RemoteExecutorClient(linkOptions.executorId, controller, undefined, (message) => errors.push(message));
    const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
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
      scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(transport)));
    });
    try {
      const firstReady = nextAvailability(executor, 'ready');
      if (dialer === 'controller') controller.dial(worker.listen());
      else worker.dial(controller.listen());
      await firstReady;
      const integration = await executor.getAgentIntegration('test');
      const projects = await executor.getProjectService();
      const inventory = executor.inventory;
      let info = await executor.getInfo();

      for (const nextBase of ['/', '/workspace/narrow']) {
        base = nextBase;
        entered = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        const ready = nextAvailability(executor, 'ready');
        controller.current!.close();
        await entered.promise;
        expect(executor.availability).toBe('offline');
        expect(executor.inventory).toEqual(inventory);
        await expect(executor.getInfo()).rejects.toMatchObject({ outcome: 'not-dispatched' });
        release.resolve();
        await ready;
        const replacement = await executor.getInfo();
        expect(replacement.projectBasePath).toBe(nextBase);
        expect(replacement.instanceId).not.toBe(info.instanceId);
        expect(await executor.getAgentIntegration('test')).toBe(integration);
        expect(await executor.getProjectService()).toBe(projects);
        expect(executor.inventory).toEqual(inventory);
        info = replacement;
      }
      expect(errors).toEqual([]);
    } finally {
      release.resolve();
      await executor.dispose(); await worker.dispose();
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
    const executor = new RemoteExecutorClient(linkOptions.executorId, controller, undefined, failure.resolve);
    const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
    let replacement = false;
    worker.onSession((transport) => {
      const fixture = integrationFixture(replacement ? '/' : '/workspace');
      const integration = replacement ? change(fixture.integration) : fixture.integration;
      scopes.push(serveExecutionRuntime({ ...fixture.executor, getAgentIntegration: async () => integration }, new ExecutorRpc(transport)));
    });
    try {
      const ready = nextAvailability(executor, 'ready');
      controller.dial(worker.listen());
      await ready;
      const inventory = executor.inventory;
      replacement = true;
      controller.current!.close();
      expect(await failure.promise).toContain('provider capabilities changed');
      expect(executor.availability).toBe('offline');
      expect(executor.inventory).toEqual(inventory);
    } finally {
      await executor.dispose(); await worker.dispose();
      await Promise.all(scopes.map((scope) => scope.dispose()));
    }
  });
}

test('a superseded candidate cannot publish metadata or errors over the accepted session', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const errors: string[] = [];
  const executor = new RemoteExecutorClient(linkOptions.executorId, controller, undefined, (message) => errors.push(message));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  let generation = 0;
  worker.onSession((transport) => {
    const candidate = ++generation;
    const fixture = integrationFixture(candidate === 1 ? '/stale' : '/accepted');
    scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(transport)));
  });
  const initialize = RemoteAgentIntegration.prototype.initializeReplacement;
  const initialization = spyOn(RemoteAgentIntegration.prototype, 'initializeReplacement')
    .mockImplementation(async function (this: RemoteAgentIntegration, backing, initial) {
      await initialize.call(this, backing, initial);
      if (backing.info.projectBasePath === '/stale') { entered.resolve(); await release.promise; }
    });
  try {
    const ready = nextAvailability(executor, 'ready');
    controller.dial(worker.listen());
    await entered.promise;
    controller.current!.close();
    await ready;
    release.resolve();
    await Promise.resolve();
    expect((await executor.getInfo()).projectBasePath).toBe('/accepted');
    expect(errors).toEqual([]);
  } finally {
    release.resolve(); initialization.mockRestore();
    await executor.dispose(); await worker.dispose();
    await Promise.all(scopes.map((scope) => scope.dispose()));
  }
});
