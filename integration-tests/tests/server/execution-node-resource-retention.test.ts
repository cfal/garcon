import { expect, test } from 'bun:test';
import { AssistantMessage } from '../../../common/chat-types.js';
import { createAgentResourceRef, type AgentProducerNotification } from '../../../server-agents/interface/src/index.js';
import { remoteFixture, requestFor } from '../../../server/execution-nodes/__tests__/integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test.each([false, true])(`closed pending startup keeps its typed error (${dialer} dials, session published: %s)`, async (published) => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      const native = fixture.generations[0]!;
      const started = Promise.withResolvers<void>();
      native.hooks.start = async ({ admission }) => {
        if (published) native.nativePublishers.at(-1)!({
          type: 'session', session: { agentSessionId: 'test-session', nativeSession: null, nativeSeedReceipt: null },
        });
        started.resolve();
        await release.promise;
        admission.signal.throwIfAborted();
      };
      const starting = integration.execution.start(request);
      await started.promise;
      await integration.producers.close(request.producerBinding);
      release.resolve();
      await expect(starting).rejects.toMatchObject({ outcome: 'rejected', code: 'STALE_RESOURCE' });
      expect(native.calls.abort).toBe(published ? 1 : 0);
      native.hooks.start = async () => {};
      const next = await requestFor(integration);
      await integration.execution.start(next);
      expect(native.calls.start).toBe(2);
      expect(fixture.node.availability).toBe('ready');
      await integration.producers.close(next.producerBinding);
    } finally {
      release.resolve();
      await fixture.dispose();
    }
  });

  test(`completed chats release execution capacity without evicting late-row bindings (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const first = await requestFor(integration);
      const native = fixture.generations[0]!;
      const rows: AgentProducerNotification[] = [];
      integration.producers.subscribe(notification => {
        if (notification.event.type === 'rows') rows.push(notification);
      });
      for (let index = 0; index < 4097; index++) {
        const chatId = index === 0 ? first.chatId : `synthetic-chat-${index}`;
        const producerBinding = index === 0 ? first.producerBinding : createAgentResourceRef(integration.producers.scope, 'producer');
        if (index > 0) await integration.producers.bind({ binding: producerBinding, chatId });
        const runId = `synthetic-run-${index}`;
        await integration.execution.start({ ...first, chatId, producerBinding, runId });
        native.nativePublishers[index]!({ type: 'run-ended', runId, outcome: 'finished' });
      }
      await integration.execution.runningSessions();
      expect(native.calls.start).toBe(4097);
      expect(fixture.node.availability).toBe('ready');
      native.nativePublishers[0]!({
        type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'Synthetic late output') }],
      });
      await integration.execution.runningSessions();
      expect(rows).toMatchObject([{ binding: first.producerBinding, event: { type: 'rows', rows: [{ message: { content: 'Synthetic late output' } }] } }]);
      await integration.producers.close(first.producerBinding);
      native.nativePublishers[0]!({ type: 'rows', rows: [] });
      await integration.execution.runningSessions();
      expect(rows).toHaveLength(1);
    } finally { await fixture.dispose(); }
  }, 30_000);
}
