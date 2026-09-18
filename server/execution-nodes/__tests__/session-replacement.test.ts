import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { type NodeAvailability } from '@garcon/server-agent-interface';
import { AgentRpc } from '../rpc.js';
import { RemoteExecutionNode } from '../remote.js';
import { WebSocketLink } from '../websocket-link.js';
import { serveAgentNode } from '../agent-worker.js';
import { integrationFixture, remoteFixture, requestFor, linkOptions as options } from './integration-fixture.js';

function nextAvailability(node: RemoteExecutionNode, value: NodeAvailability) {
  const reached = Promise.withResolvers<void>();
  const off = node.onAvailabilityChanged((next) => { if (next === value) { off(); reached.resolve(); } });
  return reached.promise;
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`fresh session keeps facades, fences old calls and replays only lifecycle (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      await integration.lifecycle.migrateOwnedStorage();
      await integration.lifecycle.start();
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = fixture.generations[0]!;
      original.hooks.start = async () => { entered.resolve(); await release.promise; };
      const events: string[] = [];
      integration.producers.subscribe(({ event }) => events.push(event.type));
      const call = integration.execution.start(request);
      const failed = call.catch((error: unknown) => error);
      await entered.promise;
      const ready = nextAvailability(fixture.node, 'ready');
      const transitions: NodeAvailability[] = [];
      fixture.node.onAvailabilityChanged((value) => transitions.push(value));
      fixture.controller.current!.close();
      expect(fixture.node.availability).toBe('offline');
      expect(await failed).toMatchObject({ outcome: 'unknown' });
      await ready;
      expect(await fixture.node.getAgentIntegration('test')).toBe(integration);
      expect(integration.producers.scope.instanceId).not.toBe(request.producerBinding.instanceId);
      expect(transitions.filter((value) => value === 'offline')).toHaveLength(1);
      const replacement = fixture.generations.at(-1)!;
      expect(replacement.calls).toMatchObject({ migrate: 1, initialize: 1, start: 0, resume: 0, import: 0 });
      release.resolve();
      original.nativePublishers[0]!({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'old output') }] });
      await integration.execution.runningSessions();
      expect(events).toEqual([]);
      await expect(integration.execution.start(request)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      await integration.execution.start(await requestFor(integration));
      expect(replacement.calls.start).toBe(1);
      expect(events).toEqual(['session']);
    } finally { await fixture.dispose(); }
  });

  test(`same-session reconnect retains binding and ordered events (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const events: string[] = [];
      const terminal = Promise.withResolvers<void>();
      integration.producers.subscribe(({ event }) => {
        events.push(event.type);
        if (event.type === 'run-ended') terminal.resolve();
      });
      const availability: NodeAvailability[] = [];
      const replayAtReady: string[][] = [];
      fixture.node.onAvailabilityChanged((value) => {
        availability.push(value);
        if (value === 'ready') replayAtReady.push([...events]);
      });
      const ready = nextAvailability(fixture.node, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      const publish = fixture.generations[0]!.nativePublishers[0]!;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'retained output') }] });
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await terminal.promise;
      await ready;
      await integration.execution.runningSessions();
      expect(events).toEqual(['rows', 'run-ended']);
      expect(replayAtReady).toEqual([['rows', 'run-ended']]);
      expect(integration.producers.scope).toEqual(fixture.generations[0]!.scope);
      expect(availability).not.toContain('offline');
      expect(fixture.generations).toHaveLength(1);
    } finally { await fixture.dispose(); }
  });
}

test('controller restart replaces the worker session without waiting for native cleanup', async () => {
  const worker = new WebSocketLink({ ...options, role: 'worker' });
  let controller = new WebSocketLink({ ...options, role: 'controller' });
  const generations: ReturnType<typeof integrationFixture>[] = [];
  const cleanup = Promise.withResolvers<void>();
  worker.onSession((session) => {
    const fixture = integrationFixture();
    generations.push(fixture);
    fixture.hooks.stop = () => cleanup.promise;
    serveAgentNode(fixture.node, new AgentRpc(session), 20);
  });
  const url = worker.listen();
  try {
    const first = RemoteExecutionNode.connect(controller);
    controller.dial(url);
    const node = await first;
    const integration = await node.getAgentIntegration('test');
    await integration.execution.start(await requestFor(integration));
    await node.dispose();
    controller = new WebSocketLink({ ...options, role: 'controller' });
    const next = RemoteExecutionNode.connect(controller);
    controller.dial(url);
    const replacement = await next;
    expect(replacement.availability).toBe('ready');
    expect(generations).toHaveLength(2);
    expect(generations[0]!.calls.stop).toBe(1);
    expect(generations[1]!.calls).toMatchObject({ start: 0, resume: 0, import: 0 });
    await replacement.dispose();
  } finally { cleanup.resolve(); await controller.dispose(); await worker.dispose(); }
});
