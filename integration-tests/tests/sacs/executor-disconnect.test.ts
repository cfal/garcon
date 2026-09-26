import { expect, test } from 'bun:test';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { executionBackend } from '../../support/execution-backend.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { sacsScriptedDriverFactories } from './drivers.js';

const backend = executionBackend();

for (const factory of sacsScriptedDriverFactories) {
  test.skipIf(backend === 'in-process')(`link loss retains native work for manual Reload without overlap (${factory.label})`, async () => {
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
        const held = driver.holdAssistant(fixture, 'Synthetic detached reply');
        try {
          const running = await fixture.client.runChat(driver.runRequest(fixture, { chatId, command: 'Synthetic held prompt' }));
          await withTimeout(held.requested, 30_000, () => `${factory.label} did not request the held model response`);
          const before = await fixture.client.getMessages(chatId);
          const events = fixture.client.markEvents();
          proxy!.disconnect();
          expect(await fixture.client.waitForTurnTerminal(chatId, running.turnId)).toMatchObject({
            type: 'agent-run-failed', error: expect.stringContaining('Reload from native history'),
          });
          await fixture.client.waitForProcessing(chatId, false, { afterIndex: events });
          await waitForExecutorReconnect(fixture, events);
          const blockedEvents = fixture.client.markEvents();
          const blocked = await fixture.client.runChat(driver.runRequest(fixture, { chatId, command: 'Synthetic blocked overlap' }));
          expect(await fixture.client.waitForTurnTerminal(chatId, blocked.turnId)).toMatchObject({
            type: 'agent-run-failed', error: expect.stringContaining('earlier turn is still running'),
          });
          await fixture.client.waitForProcessing(chatId, false, { afterIndex: blockedEvents });
          await expect(fixture.client.reloadChat(chatId)).rejects.toMatchObject({ response: {
            code: 'HISTORY_LOAD_FAILED', message: expect.stringContaining('turn is still running'),
          } });
          expect((await fixture.client.getMessages(chatId)).transcriptViewId).toBe(before.transcriptViewId);
          expect(driver.requestCountSince(fixture, cursor)).toBe(1);
          held.release();
          await reloadUntilNativeContains(fixture, chatId, 'Synthetic detached reply');
          const reloaded = await fixture.client.getMessages(chatId);
          expect(reloaded.transcriptViewId).not.toBe(before.transcriptViewId);
          expect(assistantContents(reloaded.messages)).toEqual(['Synthetic initial reply', 'Synthetic detached reply']);
          expect(new Set(reloaded.messages.map(row => row.ordinal)).size).toBe(reloaded.messages.length);
          expect(driver.requestCountSince(fixture, cursor)).toBe(1);
          driver.scriptAssistant(fixture, 'Synthetic explicit followup reply');
          const followup = await fixture.client.runChat(driver.runRequest(fixture, { chatId, command: 'Synthetic explicit followup' }));
          expect(await fixture.client.waitForTurnTerminal(chatId, followup.turnId)).toMatchObject({ type: 'agent-run-finished' });
          expect(driver.requestCountSince(fixture, cursor)).toBe(2);
          for (const { turnId } of [initial, running, blocked, followup]) {
            expect(fixture.client.events().filter(event =>
              (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
              && event.chatId === chatId && event.turnId === turnId)).toHaveLength(1);
          }
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
