// Black-box coverage for `/handoff`, which continues a chat under the same agent
// in a NEW chat rather than switching owner in place. The unit tests exercise the
// command against a fake CommandSupport; this asserts the HTTP contract, the
// persisted registry, and that the continuation actually receives the archived
// history as its carried context.
import { describe, expect, test } from 'bun:test';
import type { ChatListEntry } from '../../../common/chat-list.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { expectedCarriedInput } from '../../support/carried-context.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('self handoff', () => {
  test('continues in a new chat carrying the source history', async () => {
    await withIntegrationFixture('self-handoff', async (fixture) => {
      const client = fixture.client;
      const agent = fixture.directAgents.openAi;
      const sourceChatId = fixture.newChatId();
      const targetChatId = fixture.newChatId();

      const started = await client.startDirectChat({
        chatId: sourceChatId,
        content: 'the original request',
        projectPath: fixture.dirs.project,
        agent,
      });
      expect((await client.waitForTurnTerminal(sourceChatId, started.turnId)).type)
        .toBe('agent-run-finished');
      const sourceAnchor = await client.getMessages(sourceChatId);

      const held = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
      const response = await client.post<{ chat: ChatListEntry }>(
        '/api/v1/chats/handoff-run',
        {
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          sourceChatId,
          chatId: targetChatId,
          command: 'continue the work',
        },
      );

      // The response names the continuation, which is what the client navigates to.
      expect(response.chat.id).toBe(targetChatId);
      expect(response.chat.parentChat).toEqual({
        chatId: sourceChatId,
        relation: 'handoff',
        transcriptViewId: sourceAnchor.transcriptViewId,
        ordinal: sourceAnchor.lastOrdinal,
      });

      const request = await held.received;
      const carriedInput = expectedCarriedInput([
        'the original request',
        'echo:the original request',
      ], 'continue the work');
      expect(request.body.messages.map((message) => message.content)).toEqual([
        carriedInput,
      ]);
      expect(held.releaseText('echo:continue the work')).toBeTrue();

      const chats = (await client.listChats()).sessions;
      const source = chats.find((chat) => chat.id === sourceChatId);
      const target = chats.find((chat) => chat.id === targetChatId);
      expect(target).toBeDefined();
      expect(target?.parentChat).toEqual(response.chat.parentChat);
      // Same agent and model; a fresh chat, not a switch in place.
      expect(target?.agentId).toBe(source?.agentId);
      expect(target?.agentOwnershipEpoch).not.toBe(source?.agentOwnershipEpoch);
      // The source keeps its own session and history.
      expect(source?.agentId).toBe(agent.agentId);

      const sourceHistory = await client.getMessages(sourceChatId);
      expect(userContents(sourceHistory.messages)).toContain('the original request');
      const targetHistory = await client.getMessages(targetChatId);
      expect(messagesOfType(targetHistory.messages, 'transcript-notice')).toContainEqual(
        expect.objectContaining({
          title: 'History carried without compaction',
          content: 'Earlier chat history was small enough to carry over as context.',
          detail: undefined,
        }),
      );
    });
  }, 60_000);

  test('refuses a target chat id that already exists', async () => {
    await withIntegrationFixture('self-handoff-collision', async (fixture) => {
      const client = fixture.client;
      const agent = fixture.directAgents.openAi;
      const sourceChatId = fixture.newChatId();
      const otherChatId = fixture.newChatId();

      for (const [chatId, content] of [
        [sourceChatId, 'source request'],
        [otherChatId, 'unrelated chat'],
      ] as const) {
        const started = await client.startDirectChat({
          chatId,
          content,
          projectPath: fixture.dirs.project,
          agent,
        });
        expect((await client.waitForTurnTerminal(chatId, started.turnId)).type)
          .toBe('agent-run-finished');
      }

      // Targeting an existing unrelated chat must not submit the prompt into it.
      await expect(client.post('/api/v1/chats/handoff-run', {
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        sourceChatId,
        chatId: otherChatId,
        command: 'should not land here',
      })).rejects.toMatchObject({ status: 409 });

      const history = await client.getMessages(otherChatId);
      expect(userContents(history.messages)).not.toContain('should not land here');
    });
  }, 60_000);
});
