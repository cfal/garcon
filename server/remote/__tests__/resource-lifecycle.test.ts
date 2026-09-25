import { expect, test } from 'bun:test';
import { AssistantMessage, BashToolUseMessage } from '@garcon/common/chat-types';
import type { AgentPermissionResponseRef } from '@garcon/server-agent-interface';
import { outgoingFault, remoteFixture, requestFor } from './integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`uncertain permission delivery cannot invoke the native response twice (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = outgoingFault(worker); });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const response = Promise.withResolvers<AgentPermissionResponseRef>();
      integration.producers.subscribe(({ event }) => {
        if (event.type === 'permission' && event.decision) response.resolve(event.decision.response);
      });
      let invocations = 0;
      fixture.generations[0]!.nativePublishers[0]!({
        type: 'permission', runId: request.runId,
        lifecycle: { kind: 'requested', permissionOccurrenceId: 'permission', requestedTool: new BashToolUseMessage('2026-01-01T00:00:00Z', 'tool', 'pwd'), options: [] },
        decision: { permissionOccurrenceId: 'permission', async respond() { invocations++; } },
      });
      const ref = await response.promise;
      const lost = Promise.withResolvers<void>();
      fault.inject = (encoded) => {
        const packet = JSON.parse(encoded);
        if (packet.type === 'result') { lost.resolve(); return 'disconnect'; }
        return null;
      };
      const cancellation = new AbortController();
      const pending = integration.permissions.respond({ response: ref, decision: { allow: true } }, { signal: cancellation.signal })
        .catch((error: unknown) => error);
      await lost.promise;
      expect(invocations).toBe(1);
      cancellation.abort();
      expect(await pending).toMatchObject({ outcome: 'unknown' });
      fault.inject = () => null;
      fixture.controller.disconnect(); fixture.worker.disconnect();
      const ready = Promise.withResolvers<void>();
      fixture.executor.onAvailabilityChanged((value) => { if (value === 'ready') ready.resolve(); });
      await ready.promise;
      await expect(integration.permissions.respond({ response: ref, decision: { allow: true } }))
        .rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(invocations).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`history cancellation reaches the worker reader and closes it (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const entered = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.history = async function* (signal) {
        try {
          entered.resolve();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
          signal.throwIfAborted();
          yield [];
        } finally { stopped.resolve(); }
      };
      const cancellation = new AbortController();
      const request = await requestFor(integration);
      const reader = integration.nativeHistoryImport!.load({
        chat: {
          chatId: request.chatId, projectPath: request.projectPath, agentId: 'test', model: request.model,
          agentSessionId: 'test-session', nativeSession: null, nativeSeedReceipt: null,
          carryOverRevision: 'revision', settings: request.settings,
        },
        signal: cancellation.signal,
      })[Symbol.asyncIterator]();
      const batch = reader.next().catch((error: unknown) => error);
      await entered.promise;
      cancellation.abort();
      expect(await batch).toMatchObject({ outcome: 'unknown' });
      await stopped.promise;
      expect(fixture.generations[0]!.calls.import).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`publication snapshots provider-owned messages before delivery (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const received = Promise.withResolvers<string>();
      integration.producers.subscribe(({ event }) => {
        if (event.type === 'rows' && event.rows[0]?.message.type === 'assistant-message') received.resolve(event.rows[0].message.content);
      });
      const message = new AssistantMessage('2026-01-01T00:00:00Z', 'original');
      fixture.generations[0]!.nativePublishers[0]!({ type: 'rows', rows: [{ message }] });
      message.content = 'mutated after emission';
      expect(await received.promise).toBe('original');
    } finally { await fixture.dispose(); }
  });
}
