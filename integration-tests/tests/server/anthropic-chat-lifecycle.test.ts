import { describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Anthropic chat lifecycle', () => {
  test('starts, resumes, persists, and rehydrates direct Anthropic history', async () => {
    await withIntegrationFixture('anthropic-chat-lifecycle', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'anthropic-turn-one',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.anthropic,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe(
        'agent-run-finished',
      );

      const firstRequest = fixture.fakeProviders.anthropic.requests()[0];
      expect(firstRequest.body).toMatchObject({
        model: 'integration-anthropic-echo',
        max_tokens: 4096,
        stream: true,
        messages: [{ role: 'user', content: 'anthropic-turn-one' }],
      });
      expect(firstRequest.rawBody).not.toHaveProperty('thinking');

      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'anthropic-turn-two',
        agent: fixture.directAgents.anthropic,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type).toBe(
        'agent-run-finished',
      );
      expect(fixture.fakeProviders.anthropic.requests()[1].body.messages).toEqual([
        { role: 'user', content: 'anthropic-turn-one' },
        { role: 'assistant', content: 'echo:anthropic-turn-one' },
        { role: 'user', content: 'anthropic-turn-two' },
      ]);

      const beforeRestart = await fixture.client.getMessages(chatId);
      expect(userContents(beforeRestart.messages)).toEqual([
        'anthropic-turn-one',
        'anthropic-turn-two',
      ]);
      expect(assistantContents(beforeRestart.messages)).toEqual([
        'echo:anthropic-turn-one',
        'echo:anthropic-turn-two',
      ]);

      await fixture.restartGarcon();
      const third = await fixture.client.runDirectChat({
        chatId,
        content: 'anthropic-turn-three',
        agent: fixture.directAgents.anthropic,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, third.turnId)).type).toBe(
        'agent-run-finished',
      );
      expect(fixture.fakeProviders.anthropic.requests()[2].body.messages).toEqual([
        { role: 'user', content: 'anthropic-turn-one' },
        { role: 'assistant', content: 'echo:anthropic-turn-one' },
        { role: 'user', content: 'anthropic-turn-two' },
        { role: 'assistant', content: 'echo:anthropic-turn-two' },
        { role: 'user', content: 'anthropic-turn-three' },
      ]);
      expect(fixture.fakeProviders.openAi.requests()).toEqual([]);
    });
  });

  test('generates titles from reasoning-first Anthropic SSE and rejects truncation', async () => {
    await withIntegrationFixture('anthropic-title-generation', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'create-anthropic-title-source-chat',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);

      fixture.fakeProviders.anthropic.respondThinkingThenTextNext(
        { model: 'integration-anthropic-echo', stream: true },
        'Anthropic Stream Title',
      );
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'anthropic-title-source',
      })).resolves.toEqual({
        success: true,
        chatId,
        title: 'Anthropic Stream Title',
      });

      const titleRequest = fixture.fakeProviders.anthropic.requests()[0];
      expect(titleRequest.body).toMatchObject({
        model: 'integration-anthropic-echo',
        max_tokens: 4096,
        stream: true,
      });
      expect(titleRequest.lastUserText).toContain('### Task:');
      expect(titleRequest.lastUserText).toContain('anthropic-title-source');

      fixture.fakeProviders.anthropic.truncateNextStream({
        model: 'integration-anthropic-echo',
        stream: true,
      });
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'anthropic-truncated-title',
      })).rejects.toMatchObject({ status: 502 });

      const chats = await fixture.client.listChats();
      expect(chats.sessions.find((chat) => chat.id === chatId)?.title).toBe(
        'Anthropic Stream Title',
      );
    }, { chatTitleAgent: 'anthropic' });
  });
});
