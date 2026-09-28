import { expect, spyOn, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { type ExecutorAvailability } from '@garcon/server-agent-interface';
import { RemoteExecutorClient } from '../../client/executor-client.js';
import { integrationFixture, linkOptions, remoteFixture, requestFor } from '../../__tests__/integration-fixture.js';
import { connectRemoteExecutor } from '../../__tests__/runtime-adapter.js';
import { serveExecutionRuntime } from '../../server/executor-rpc-server.js';
import { ProducerRelay } from '../../server/producer-relay.js';
import { ExecutorRpc } from '../rpc.js';
import { WebSocketLink } from '../websocket-link.js';

function nextAvailability(executor: RemoteExecutorClient, value: ExecutorAvailability) {
  const reached = Promise.withResolvers<void>();
  const off = executor.onAvailabilityChanged((next) => { if (next === value) { off(); reached.resolve(); } });
  return reached.promise;
}

function record(integration: Awaited<ReturnType<RemoteExecutorClient['getAgentIntegration']>>) {
  const events: string[] = [];
  integration.producers.subscribe(({ event }) => {
    events.push(event.type === 'rows' ? `rows:${(event.rows[0]!.message as AssistantMessage).content}` : event.type);
  });
  return events;
}

function availabilityLog(executor: RemoteExecutorClient) {
  const log: ExecutorAvailability[] = [];
  executor.onAvailabilityChanged((value) => log.push(value));
  return log;
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`a short disconnect resumes the binding and delivers gap output once (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      const events = record(integration);
      const publish = worker.nativePublishers[0]!;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'before') }] });
      await integration.execution.runningSessions();
      const availability = availabilityLog(fixture.executor);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(fixture.executor.availability).toBe('reconnecting');
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:01Z', 'during') }] });
      await ready;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:02Z', 'after') }] });
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.runningSessions();

      expect(availability).toEqual(['reconnecting', 'ready']);
      expect(events).toEqual(['rows:before', 'rows:during', 'rows:after', 'run-ended']);
      expect(worker.calls).toMatchObject({ start: 1, abort: 0, stop: 0 });
      await integration.producers.close(request.producerBinding);
    } finally { await fixture.dispose(); }
  });

  test(`output beyond the retention budget arrives as one gap before the newest rows (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { relay: { retainedBytes: 4_096 } });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const events = record(integration);
      const publish = fixture.generations[0]!.nativePublishers[0]!;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      for (let index = 0; index < 8; index += 1) {
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', `gap-${index}:${'x'.repeat(1_000)}`) }] });
      }
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await ready;
      await integration.execution.runningSessions();

      expect(events[0]).toBe('publication-gap');
      expect(events.at(-1)).toBe('run-ended');
      const delivered = events.slice(1, -1).map((event) => event.split(':')[1]);
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.length).toBeLessThan(8);
      expect(delivered).toEqual(Array.from({ length: delivered.length }, (_, index) => `gap-${8 - delivered.length + index}`));
    } finally { await fixture.dispose(); }
  });

  test(`a start in flight during a short disconnect publishes through the resumed binding (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const worker = fixture.generations[0]!;
      worker.hooks.start = async () => { entered.resolve(); await release.promise; };
      const events = record(integration);
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(await call).toMatchObject({ outcome: 'unknown' });
      await ready;
      await expect(integration.execution.start(await requestFor(integration))).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      release.resolve();
      await integration.execution.runningSessions();
      expect(events).toEqual(['session']);
      expect(worker.calls).toMatchObject({ start: 1, abort: 0, stop: 0 });
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`a binding the worker released fails its run and fences later output (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { relay: { graceMs: 1 } });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      const events = record(integration);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await Bun.sleep(5);
      await ready;
      await integration.execution.runningSessions();
      expect(events).toEqual(['publication-failed']);

      const publish = worker.nativePublishers[0]!;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'detached output') }] });
      await integration.execution.runningSessions();
      expect(events).toEqual(['publication-failed']);
      const next = await requestFor(integration);
      await expect(integration.execution.start(next)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      const running = spyOn(worker.integration.execution, 'runningSessions').mockResolvedValue([
        { agentSessionId: 'test-session', status: null, startedAt: null },
      ]);
      try {
        const reader = integration.nativeHistoryImport!.load({
          chat: { chatId: 'test-chat', agentId: 'test', agentSessionId: 'test-session', projectPath: '/test-project',
            model: 'test-model', nativeSession: null, carryOverRevision: '0', nativeSeedReceipt: null, settings: integration.settings.defaults() },
          signal: new AbortController().signal,
        })[Symbol.asyncIterator]();
        await expect(reader.next()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
        expect(worker.calls.import).toBe(0);
      } finally { running.mockRestore(); }
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.start(next);
      expect(worker.calls.start).toBe(2);
    } finally { await fixture.dispose(); }
  });

  test(`the controller abandons bindings once its reconnect grace expires (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, {
      relay: { graceMs: 50 }, client: { reconnectGraceMs: 1 },
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const events = record(integration);
      const availability = availabilityLog(fixture.executor);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await ready;
      fixture.generations[0]!.nativePublishers[0]!({
        type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'abandoned') }],
      });
      await integration.execution.runningSessions();

      expect(availability).toEqual(['reconnecting', 'offline', 'ready']);
      expect(events).toEqual([]);
      await expect(integration.producers.close(request.producerBinding)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    } finally { await fixture.dispose(); }
  });
}

test('a restarted worker cannot resume bindings, so the controller reports them lost first', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const generations: ReturnType<typeof integrationFixture>[] = [];
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  worker.onSession((transport) => {
    const fixture = integrationFixture();
    generations.push(fixture);
    scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(transport), new ProducerRelay()));
  });
  const connected = connectRemoteExecutor(controller);
  controller.dial(worker.listen());
  const executor = await connected;
  try {
    const integration = await executor.getAgentIntegration('test');
    await integration.execution.start(await requestFor(integration));
    const availability = availabilityLog(executor);
    const ready = nextAvailability(executor, 'ready');
    controller.disconnect(); worker.disconnect();
    await ready;

    expect(availability).toEqual(['reconnecting', 'offline', 'ready']);
    expect(generations).toHaveLength(2);
    expect(integration.producers.scope.instanceId).toBe(generations[1]!.scope.instanceId);
  } finally {
    await executor.dispose();
    await worker.dispose();
    await Promise.all(scopes.map((scope) => scope.dispose()));
    for (const generation of generations) await generation.executor.dispose();
  }
});
