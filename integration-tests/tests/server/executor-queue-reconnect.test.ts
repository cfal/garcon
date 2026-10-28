import { expect, test } from 'bun:test';
import type { AgentRunFinishedMessage, ExecutorsChangedMessage } from '../../../common/ws-events.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`a queue resumed while its executor reconnects holds its turn until the executor is ready (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`queue-reconnect-${executionBackend}`, async (fixture) => {
        const { client, executionDirs, directAgents, fakeProviders } = fixture;
        const chatId = fixture.newChatId();
        const first = fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic first turn' });
        const started = await client.startDirectChat({
          chatId, content: 'Synthetic first turn', projectPath: executionDirs.project, agent: directAgents.openAi,
        });
        await first.received;
        const queuedText = 'Synthetic turn held while the executor reconnects';
        const held = fakeProviders.openAi.holdNext({ lastUserText: queuedText });
        await client.enqueueNew(chatId, queuedText);
        await client.pauseQueue(chatId);
        first.releaseText('Synthetic first reply');
        await client.waitForTurnTerminal(chatId, started.turnId);
        const pause = (await client.getExecutionControl(chatId)).queue.pause;
        if (!pause) throw new Error('Expected a paused queue');
        const cursor = client.markEvents();

        // A silent link keeps the executor reconnecting until it is restored.
        proxy!.blackhole();
        proxy!.disconnect();
        const reconnecting = await client.waitForEvent(
          (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
            && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'reconnecting'),
          'executor reconnecting', { afterIndex: cursor, timeoutMs: 20_000 },
        );
        await client.resumeQueue(chatId, pause.id);
        // The awaited coordinator contract covers non-admission; this scenario covers recovery.
        const waiting = await client.getExecutionControl(chatId);
        expect(waiting.queue.entries.map(entry => entry.content)).toEqual([queuedText]);
        expect(waiting.queue.pause).toBeNull();
        expect(fakeProviders.openAi.requests().filter(request => request.lastUserText === queuedText)).toEqual([]);

        // Dropping the silent attempt permits the next reconnect attempt.
        proxy!.restore();
        proxy!.disconnect();
        const ready = await client.waitForEvent(
          (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
            && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'ready'),
          'executor ready after reconnect', { afterIndex: client.events().indexOf(reconnecting) + 1, timeoutMs: 20_000 },
        );
        await held.received;
        held.releaseText('Synthetic reply after the executor reconnected');
        await client.waitForEvent(
          (event): event is AgentRunFinishedMessage => event.type === 'agent-run-finished' && event.chatId === chatId,
          'queued turn finished after reconnect', { afterIndex: cursor, timeoutMs: 20_000 },
        );

        const settled = await client.getExecutionControl(chatId);
        expect(settled.queue.entries).toEqual([]);
        expect(settled.queue.pause).toBeNull();
        expect(assistantContents((await client.getMessages(chatId)).messages).at(-1))
          .toBe('Synthetic reply after the executor reconnected');
        expect(client.eventsSince(cursor).filter(event => event.type === 'agent-run-failed')).toEqual([]);
        expect(fakeProviders.openAi.requests().filter(request => request.lastUserText === queuedText)).toHaveLength(1);
        const dequeued = client.events().findIndex((event, index) => index >= cursor
          && event.type === 'chat-execution-control-updated' && event.chatId === chatId
          && !event.control.queue.entries.some(entry => entry.content === queuedText));
        expect(dequeued).toBeGreaterThan(client.events().indexOf(ready));
      }, {
        executionBackend,
        interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); }
  }, 60_000);
}
