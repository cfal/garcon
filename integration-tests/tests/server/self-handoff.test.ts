// Black-box coverage for `/handoff`, which continues a chat under the same agent
// in a NEW chat rather than switching owner in place. The unit tests exercise the
// command against a fake CommandSupport; this asserts the HTTP contract, the
// persisted registry, and that the continuation actually receives the archived
// history as its carried context.
import { describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatListEntry } from '../../../common/chat-list.js';
import type { ForkRunCommandResponse } from '../../../common/chat-command-contracts.js';
import { CURRENT_WORKSPACE_VERSION } from '../../../server/migrations/index.js';
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
      expect(response.chat.title).toBe('the original request (1)');
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
      expect(target?.title).toBe('the original request (1)');
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

  test('shares collision-based names with forks, reuses gaps, and migrates legacy counters', async () => {
    await withIntegrationFixture('self-handoff-names', async (fixture) => {
      const client = fixture.client;
      const sourceChatId = fixture.newChatId();
      const started = await client.startDirectChat({
        chatId: sourceChatId,
        content: 'source request',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await client.waitForTurnTerminal(sourceChatId, started.turnId);
      await client.updateSessionName(sourceChatId, 'Topic');

      const firstFork = await client.forkChat({ sourceChatId, chatId: fixture.newChatId() });
      expect(firstFork.chat.title).toBe('Topic (1)');
      expect((await client.toggleArchive(firstFork.chat.id)).isArchived).toBeTrue();

      const handoff = async (sourceId: string) => {
        const request = {
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          sourceChatId: sourceId,
          chatId: fixture.newChatId(),
          command: 'continue the work',
        };
        const response = await client.post<ForkRunCommandResponse>('/api/v1/chats/handoff-run', request);
        await client.waitForTurnTerminal(response.chat.id, response.turnId);
        return { request, response };
      };
      const second = await handoff(sourceChatId);
      expect(second.response.chat.title).toBe('Topic (2)');
      const replay = await client.post<ForkRunCommandResponse>('/api/v1/chats/handoff-run', second.request);
      expect(replay.status).toBe('duplicate');
      expect(replay.chat.title).toBe('Topic (2)');

      const nested = await handoff(second.response.chat.id);
      expect(nested.response.chat.title).toBe('Topic (2) (1)');
      await client.deleteChat(firstFork.chat.id);
      const replacement = await handoff(sourceChatId);
      expect(replacement.response.chat.title).toBe('Topic (1)');

      const registryPath = join(fixture.dirs.workspace, 'chats.json');
      let beforeMigration: unknown;
      await fixture.restartGarcon({
        beforeStart: async () => {
          const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
            version: number;
            sessions: Record<string, Record<string, unknown>>;
          };
          beforeMigration = structuredClone(registry);
          for (const entry of Object.values(registry.sessions)) {
            expect(entry).not.toHaveProperty('nextForkOrdinal');
            entry.nextForkOrdinal = 42;
          }
          await writeFile(registryPath, JSON.stringify(registry));
          await writeFile(join(fixture.dirs.workspace, 'workspace-version.json'), JSON.stringify({ version: 7 }));
        },
      });

      expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual(beforeMigration);
      expect(JSON.parse(await readFile(join(fixture.dirs.workspace, 'workspace-version.json'), 'utf8')))
        .toEqual({ version: CURRENT_WORKSPACE_VERSION });
      const chats = (await fixture.client.listChats()).sessions;
      expect(chats.find((chat) => chat.id === sourceChatId)?.title).toBe('Topic');
      expect(chats.find((chat) => chat.id === second.response.chat.id)?.title).toBe('Topic (2)');
      expect(chats.find((chat) => chat.id === replacement.response.chat.id)?.title).toBe('Topic (1)');
      expect(chats.find((chat) => chat.id === nested.response.chat.id)?.title).toBe('Topic (2) (1)');
    });
  }, 60_000);

  test('allocates distinct names for a concurrent fork and handoff from different sources', async () => {
    await withIntegrationFixture('self-handoff-concurrent-names', async (fixture) => {
      const client = fixture.client;
      const sourceIds = [fixture.newChatId(), fixture.newChatId()];
      for (const chatId of sourceIds) {
        const started = await client.startDirectChat({
          chatId,
          content: 'shared title',
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAi,
        });
        await client.waitForTurnTerminal(chatId, started.turnId);
      }

      const [fork, handoff] = await Promise.all([
        client.forkChat({ sourceChatId: sourceIds[0]!, chatId: fixture.newChatId() }),
        client.post<ForkRunCommandResponse>('/api/v1/chats/handoff-run', {
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          sourceChatId: sourceIds[1]!,
          chatId: fixture.newChatId(),
          command: 'continue the work',
        }),
      ]);
      expect([fork.chat.title, handoff.chat.title].sort()).toEqual(['shared title (1)', 'shared title (2)']);
      await client.waitForTurnTerminal(handoff.chat.id, handoff.turnId);
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
