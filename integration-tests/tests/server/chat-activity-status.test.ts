import { expect, test } from 'bun:test';
import { ChatActivityUpdatedMessage } from '../../../common/ws-events.js';
import type { ChatActivityStatus } from '../../../common/chat-activity.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`chat list activity follows working, completion, and failure (${executionBackend})`, async () => {
    await withIntegrationFixture(`chat-activity-${executionBackend}`, async (fixture) => {
      const chatId = fixture.newChatId();
      const waitForStatus = (status: ChatActivityStatus, afterIndex: number) => fixture.client.waitForEvent(
        (event): event is ChatActivityUpdatedMessage => event instanceof ChatActivityUpdatedMessage
          && event.chatId === chatId && event.activityStatus === status,
        `chat activity ${status}`,
        { afterIndex },
      );
      const expectListedStatus = async (status: ChatActivityStatus) => {
        expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.activityStatus).toBe(status);
        expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe(status);
      };

      const held = fixture.fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic status success' });
      const startedAt = fixture.client.markEvents();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'Synthetic status success',
        projectPath: fixture.executionDirs.project,
        agent: fixture.directAgents.anthropic,
      });
      await held.received;
      await waitForStatus('working', startedAt);
      await expectListedStatus('working');
      held.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: startedAt });
      await waitForStatus('complete', startedAt);
      await expectListedStatus('complete');

      const failed = fixture.fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic status failure' });
      const failedAt = fixture.client.markEvents();
      const next = await fixture.client.runDirectChat({
        chatId,
        content: 'Synthetic status failure',
        agent: fixture.directAgents.anthropic,
      });
      await failed.received;
      await waitForStatus('working', failedAt);
      await expectListedStatus('working');
      failed.releaseStreamError('Synthetic provider error');
      expect((await fixture.client.waitForTurnTerminal(chatId, next.turnId, { afterIndex: failedAt })).type).toBe('agent-run-failed');
      await waitForStatus('error', failedAt);
      await expectListedStatus('error');
      console.log(`Chat activity assertions completed: ${executionBackend}`);
    }, { executionBackend });
  }, 120_000);
}
