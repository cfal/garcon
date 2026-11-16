import { expect, test } from 'bun:test';
import { ChatActivityUpdatedMessage } from '../../../common/ws-events.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('accepted input clears a failed result while the queue remains paused', async () => {
  await withIntegrationFixture('chat-activity-paused-queue', async fixture => {
    const chatId = fixture.newChatId();
    const held = fixture.fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic failing turn' });
    const started = await fixture.client.startDirectChat({
      chatId, content: 'Synthetic failing turn', projectPath: fixture.executionDirs.project,
      agent: fixture.directAgents.anthropic,
    });
    await held.received;
    await fixture.client.enqueueNew(chatId, 'Synthetic retained queue tail');
    await fixture.client.pauseQueue(chatId);
    const failedAt = fixture.client.markEvents();
    held.releaseStreamError('Synthetic turn failure');
    await fixture.client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: failedAt });
    await fixture.client.waitForEvent(
      (event): event is ChatActivityUpdatedMessage => event instanceof ChatActivityUpdatedMessage
        && event.chatId === chatId && event.activityStatus === 'error',
      'failed activity before paused input', { afterIndex: failedAt },
    );
    const paused = await fixture.client.getExecutionControl(chatId);
    expect(paused.queue.pause).not.toBeNull();
    expect((await fixture.client.getChatSnapshot(chatId, 0)).chat.activityStatus).toBe('error');

    const acceptedAt = fixture.client.markEvents();
    const accepted = await fixture.client.enqueueNew(chatId, 'Synthetic newly accepted input');
    expect(accepted.control.queue.pause?.id).toBe(paused.queue.pause!.id);
    await fixture.client.waitForEvent(
      (event): event is ChatActivityUpdatedMessage => event instanceof ChatActivityUpdatedMessage
        && event.chatId === chatId && event.activityStatus === null,
      'cleared activity after paused input', { afterIndex: acceptedAt },
    );
    expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.activityStatus).toBeNull();
    const snapshot = await fixture.client.getChatSnapshot(chatId, 0);
    expect(snapshot.chat.activityStatus).toBeNull();
    expect(snapshot.processingPhase).toBeNull();
    expect((await fixture.client.getExecutionControl(chatId)).queue.entries.map(entry => entry.content)).toEqual([
      'Synthetic retained queue tail', 'Synthetic newly accepted input',
    ]);
    console.log('Paused queue activity assertions completed');
  });
}, 120_000);
