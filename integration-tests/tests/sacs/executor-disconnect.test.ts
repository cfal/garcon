import { expect, test } from 'bun:test';
import type { ChatProcessingUpdatedMessage } from '../../../common/ws-events.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { executionBackend } from '../../support/execution-backend.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { sacsScriptedDriverFactories } from './drivers.js';

const backend = executionBackend();

for (const factory of sacsScriptedDriverFactories) {
  test.skipIf(backend === 'in-process')(`link loss resumes the running turn and delivers its reply once (${factory.label})`, async () => {
    const driver = await factory.start();
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`sacs-link-loss-${factory.id}-${backend}`, async (fixture) => {
        const chatId = fixture.newChatId();
        driver.scriptAssistant(fixture, 'Synthetic initial reply');
        const initial = await fixture.client.startChat(driver.startRequest(fixture, {
          chatId, projectPath: fixture.dirs.project, command: 'Synthetic initial prompt',
        }));
        expect(await fixture.client.waitForTurnTerminal(chatId, initial.turnId)).toMatchObject({ type: 'agent-run-finished' });
        await fixture.client.waitForProcessing(chatId, false);
        const cursor = driver.markRequests(fixture);
        const held = driver.holdAssistant(fixture, 'Synthetic resumed reply');
        try {
          const running = await fixture.client.runChat(driver.runRequest(fixture, { chatId, command: 'Synthetic held prompt' }));
          await withTimeout(held.requested, 30_000, () => `${factory.label} did not request the held model response`);
          const before = await fixture.client.getMessages(chatId);
          const events = fixture.client.markEvents();
          const processingPhase = (phase: ChatProcessingUpdatedMessage['phase']) => fixture.client.waitForEvent(
            (event): event is ChatProcessingUpdatedMessage => event.type === 'chat-processing-updated'
              && event.chatId === chatId && event.phase === phase,
            `${chatId} processing ${phase}`, { afterIndex: events, timeoutMs: 20_000 },
          );
          const terminals = (turnId: string) => fixture.client.events().filter(event =>
            (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
            && event.chatId === chatId && event.turnId === turnId);

          // Holding the link down makes the reconnecting phase observable before the resume.
          proxy!.refuseConnections();
          proxy!.disconnect();
          const reconnecting = await processingPhase('reconnecting');
          proxy!.acceptConnections();
          await waitForExecutorReconnect(fixture, events);
          const resumed = await processingPhase('running');
          expect(fixture.client.events().indexOf(reconnecting)).toBeLessThan(fixture.client.events().indexOf(resumed));
          expect(terminals(running.turnId)).toEqual([]);

          held.release();
          expect(await fixture.client.waitForTurnTerminal(chatId, running.turnId)).toMatchObject({ type: 'agent-run-finished' });
          await fixture.client.waitForProcessing(chatId, false, { afterIndex: events });
          const after = await fixture.client.getMessages(chatId);
          expect(after.transcriptViewId).toBe(before.transcriptViewId);
          expect(assistantContents(after.messages)).toEqual(['Synthetic initial reply', 'Synthetic resumed reply']);
          expect(new Set(after.messages.map(row => row.ordinal)).size).toBe(after.messages.length);
          expect(driver.requestCountSince(fixture, cursor)).toBe(1);

          driver.scriptAssistant(fixture, 'Synthetic explicit followup reply');
          const followup = await fixture.client.runChat(driver.runRequest(fixture, { chatId, command: 'Synthetic explicit followup' }));
          expect(await fixture.client.waitForTurnTerminal(chatId, followup.turnId)).toMatchObject({ type: 'agent-run-finished' });
          expect(driver.requestCountSince(fixture, cursor)).toBe(2);
          for (const { turnId } of [initial, running, followup]) expect(terminals(turnId)).toHaveLength(1);
          expect(proxy!.connections).toBe(2);
          driver.assertSettled(fixture);
        } finally { held.release(); }
      }, {
        ...driver.fixtureOptions,
        executionBackend: backend,
        interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); await driver.dispose(); }
  }, 120_000);
}
