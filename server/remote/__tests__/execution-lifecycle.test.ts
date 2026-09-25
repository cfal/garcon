import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentProducerNotification } from '@garcon/server-agent-interface';
import { integrationFixture, remoteFixture, requestFor } from './integration-fixture.js';

for (const backend of ['local', 'controller', 'worker'] as const) {
  test(`execution handles stay bound to one run when native session IDs are reused (${backend})`, async () => {
    const remote = backend === 'local' ? null : await remoteFixture(backend);
    const native = remote?.generations[0] ?? integrationFixture();
    const integration = remote ? await remote.executor.getAgentIntegration('test') : native.integration;
    const events: AgentProducerNotification[] = [];
    const unsubscribe = integration.producers.subscribe((event) => events.push(event));
    try {
      const request = await requestFor(integration);
      const first = await integration.execution.start(request);
      const second = await integration.execution.resume({
        ...request, runId: 'second-run', agentSessionId: 'test-session', nativeSession: null,
      });
      expect(second).not.toEqual(first);
      await expect(integration.execution.abort(first)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(native.calls.abort).toBe(0);

      native.nativePublishers[0]!({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      native.nativePublishers[0]!({
        type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'Late first-run output') }],
      });
      await integration.execution.runningSessions();
      expect(events.filter(({ event }) => event.type === 'run-ended')).toMatchObject([
        { event: { runId: request.runId, outcome: 'finished' } },
      ]);
      expect(events.filter(({ event }) => event.type === 'rows')).toMatchObject([
        { binding: request.producerBinding, event: { rows: [{ message: { content: 'Late first-run output' } }] } },
      ]);
      await expect(integration.execution.abort(second)).resolves.toBe(true);
      expect(native.calls.abort).toBe(1);

      native.nativePublishers[1]!({ type: 'run-ended', runId: 'second-run', outcome: 'finished' });
      await integration.execution.runningSessions();
      await expect(integration.execution.abort(second)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(native.calls.abort).toBe(1);

      await integration.producers.close(request.producerBinding);
      const received = events.length;
      native.nativePublishers[0]!({
        type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:01Z', 'Closed-binding output') }],
      });
      await integration.execution.runningSessions();
      expect(events).toHaveLength(received);
    } finally {
      unsubscribe();
      if (remote) await remote.dispose();
      else await native.executor.dispose();
    }
  });
}
