import { describe, expect, test } from 'bun:test';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import { GarconApiError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('fork-run lifecycle', () => {
  test('atomically forks provider context, runs once, and survives restart', async () => {
    await withIntegrationFixture('fork-run-atomic', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'fork-source-first',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'fork-source-second',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, second.turnId);

      const targetChatId = fixture.newChatId();
      const clientRequestId = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();
      const request = {
        sourceChatId,
        chatId: targetChatId,
        command: 'fork-target-new',
        clientRequestId,
        clientMessageId,
        permissionMode: 'default' as const,
        thinkingMode: 'none' as const,
        model: fixture.directAgents.openAi.provider.model,
        apiProviderId: fixture.directAgents.openAi.provider.providerId,
        modelEndpointId: fixture.directAgents.openAi.provider.endpointId,
        modelProtocol: fixture.directAgents.openAi.provider.protocol,
      };
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'fork-target-new' });
      const cursor = fixture.client.markEvents();
      const accepted = await fixture.client.forkRunChat(request);
      expect(accepted).toMatchObject({
        status: 'accepted',
        commandType: 'fork-run',
        clientRequestId,
        chatId: targetChatId,
        chat: { id: targetChatId },
      });
      expect(accepted.turnId).toBeString();

      const duplicate = await fixture.client.forkRunChat(request);
      expect(duplicate).toMatchObject({
        status: 'duplicate',
        clientRequestId,
        chatId: targetChatId,
        turnId: accepted.turnId,
        chat: { id: targetChatId },
      });
      let conflict: unknown;
      try {
        await fixture.client.forkRunChat({ ...request, command: 'fork-target-conflict' });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(GarconApiError);
      expect(conflict).toMatchObject({
        status: 409,
        body: { errorCode: 'IDEMPOTENCY_CONFLICT' },
      });

      const providerRequest = await held.received;
      expect(providerRequest.body.messages).toEqual([
        { role: 'user', content: 'fork-source-first' },
        { role: 'assistant', content: 'echo:fork-source-first' },
        { role: 'user', content: 'fork-source-second' },
        { role: 'assistant', content: 'echo:fork-source-second' },
        { role: 'user', content: 'fork-target-new' },
      ]);
      held.releaseEcho();
      const terminal = await fixture.client.waitForTurnTerminal(targetChatId, accepted.turnId, {
        afterIndex: cursor,
      });
      expect(terminal).toMatchObject({
        type: 'agent-run-finished',
        chatId: targetChatId,
        turnId: accepted.turnId,
        clientRequestId,
      });

      const pendingEvent = fixture.client.eventsSince(cursor).find((event) =>
        event.type === 'pending-user-input-updated'
        && event.input.chatId === targetChatId
        && event.input.clientRequestId === clientRequestId);
      expect(pendingEvent?.type === 'pending-user-input-updated' ? pendingEvent.input : null)
        .toMatchObject({
          clientRequestId,
          clientMessageId,
          turnId: accepted.turnId,
          content: 'fork-target-new',
        });

      const targetUserEvent = fixture.client.eventsSince(cursor).find(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === targetChatId
          && event.clientRequestId === clientRequestId
          && event.turnId === accepted.turnId
          && event.messages.some((entry) =>
            entry.message.type === 'user-message'
            && entry.message.content === 'fork-target-new'),
      );
      expect(targetUserEvent).toBeDefined();
      const targetEventUser = targetUserEvent?.messages.find((entry) =>
        entry.message.type === 'user-message'
        && entry.message.content === 'fork-target-new');
      expect(targetEventUser?.message.type === 'user-message'
        ? targetEventUser.message.metadata
        : null).toMatchObject({
        clientRequestId,
        turnId: accepted.turnId,
      });
      expect(fixture.client.eventsSince(cursor)).toContainEqual(expect.objectContaining({
        type: 'pending-user-input-cleared',
        chatId: targetChatId,
        clientRequestId,
        reason: 'persisted',
      }));

      const source = await fixture.client.getMessages(sourceChatId);
      const target = await fixture.client.getMessages(targetChatId);
      expect(userContents(source.messages)).toEqual(['fork-source-first', 'fork-source-second']);
      expect(assistantContents(source.messages)).toEqual([
        'echo:fork-source-first',
        'echo:fork-source-second',
      ]);
      expect(userContents(target.messages)).toEqual([
        'fork-source-first',
        'fork-source-second',
        'fork-target-new',
      ]);
      expect(assistantContents(target.messages)).toEqual([
        'echo:fork-source-first',
        'echo:fork-source-second',
        'echo:fork-target-new',
      ]);
      expect(countUserContent(target.messages, 'fork-target-new')).toBe(1);
      const finalTargetUser = target.messages.find((entry) =>
        entry.message.type === 'user-message'
        && entry.message.content === 'fork-target-new');
      expect(finalTargetUser?.message.type === 'user-message'
        ? finalTargetUser.message.metadata
        : null).toMatchObject({
        clientRequestId,
        turnId: accepted.turnId,
      });
      expect(target.pendingUserInputs).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests().filter((entry) =>
        entry.lastUserText === 'fork-target-new')).toHaveLength(1);

      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.map((chat) => chat.id).sort()).toEqual(
        [sourceChatId, targetChatId].sort(),
      );
      expect(userContents((await fixture.client.getMessages(sourceChatId)).messages)).toEqual(
        ['fork-source-first', 'fork-source-second'],
      );
      expect(userContents((await fixture.client.getMessages(targetChatId)).messages)).toEqual(
        ['fork-source-first', 'fork-source-second', 'fork-target-new'],
      );
    });
  });
});
