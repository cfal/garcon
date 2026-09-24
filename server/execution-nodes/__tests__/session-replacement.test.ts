import { expect, test, spyOn } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { type NodeAvailability } from '@garcon/server-agent-interface';
import { RemoteExecutionNode } from '../remote.js';
import { remoteFixture, requestFor } from './integration-fixture.js';

function nextAvailability(node: RemoteExecutionNode, value: NodeAvailability) {
  const reached = Promise.withResolvers<void>();
  const off = node.onAvailabilityChanged((next) => { if (next === value) { off(); reached.resolve(); } });
  return reached.promise;
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`disconnect preserves native work but fences old output and new dispatch (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      const events: string[] = [];
      integration.producers.subscribe(({ event }) => events.push(event.type));
      const ready = nextAvailability(fixture.node, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(fixture.node.availability).toBe('offline');
      await ready;
      expect(await fixture.node.getAgentIntegration('test')).toBe(integration);
      expect(integration.producers.scope).toEqual(worker.scope);
      expect(worker.calls).toMatchObject({ start: 1, abort: 0, stop: 0 });
      await expect(integration.producers.close(request.producerBinding)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(worker.calls.abort).toBe(0);
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
      const publish = worker.nativePublishers[0]!;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'detached output') }] });
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.runningSessions();
      expect(events).toEqual([]);
      await expect(integration.execution.start(request)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      await integration.execution.start(next);
      expect(worker.calls.start).toBe(2);
      expect(events).toEqual(['session']);
    } finally { await fixture.dispose(); }
  });

  test(`late start results cannot publish into a replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const worker = fixture.generations[0]!;
      worker.hooks.start = async () => { entered.resolve(); await release.promise; };
      const events: string[] = [];
      integration.producers.subscribe(({ event }) => events.push(event.type));
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      const ready = nextAvailability(fixture.node, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(await call).toMatchObject({ outcome: 'unknown' });
      await ready;
      await expect(integration.execution.start(await requestFor(integration))).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      release.resolve();
      await integration.execution.runningSessions();
      expect(events).toEqual([]);
      expect(worker.calls).toMatchObject({ start: 1, abort: 0, stop: 0 });
    } finally { release.resolve(); await fixture.dispose(); }
  });
}
