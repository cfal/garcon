import { describe, expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('chat title icon history', () => {
  test('shares title icons across chats, records generated titles, and resets on restart', async () => {
    await withIntegrationFixture('chat-title-icon-history', async (fixture) => {
      const firstChatId = fixture.newChatId();
      const secondChatId = fixture.newChatId();

      for (const [chatId, content] of [
        [firstChatId, 'first-title-history-chat'],
        [secondChatId, 'second-title-history-chat'],
      ]) {
        const started = await fixture.client.startDirectChat({
          chatId,
          content,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      }

      await fixture.client.updateSessionName(firstChatId, 'Investigate 🧿 access 🔐');
      fixture.fakeProviders.openAiResponses.respondThinkingThenTextNext(
        { lastUserTextIncludes: 'first-history-generation' },
        '🧪 Testing and packaging 📦',
      );
      await fixture.client.generateChatTitle({
        chatId: secondChatId,
        message: 'first-history-generation',
      });

      const firstGenerationRequest = fixture.fakeProviders.openAiResponses.requests().find(
        (request) => request.lastUserText.includes('first-history-generation'),
      );
      expect(firstGenerationRequest?.lastUserText).toContain(
        '### Recently Used Emojis to Avoid When Another Accurate Emoji Is Available:\n🔐 🧿',
      );

      fixture.fakeProviders.openAiResponses.respondThinkingThenTextNext(
        { lastUserTextIncludes: 'second-history-generation' },
        '🧭 Follow-up title',
      );
      await fixture.client.generateChatTitle({
        chatId: firstChatId,
        message: 'second-history-generation',
      });

      const secondGenerationRequest = fixture.fakeProviders.openAiResponses.requests().find(
        (request) => request.lastUserText.includes('second-history-generation'),
      );
      expect(secondGenerationRequest?.lastUserText).toContain(
        '### Recently Used Emojis to Avoid When Another Accurate Emoji Is Available:\n📦 🧪 🔐 🧿',
      );

      await fixture.restartGarcon();
      fixture.fakeProviders.openAiResponses.respondThinkingThenTextNext(
        { lastUserTextIncludes: 'post-restart-generation' },
        '🛰️ Restarted title',
      );
      await fixture.client.generateChatTitle({
        chatId: secondChatId,
        message: 'post-restart-generation',
      });

      const postRestartRequest = fixture.fakeProviders.openAiResponses.requests().find(
        (request) => request.lastUserText.includes('post-restart-generation'),
      );
      expect(postRestartRequest?.lastUserText).toContain(
        '### Recently Used Emojis to Avoid When Another Accurate Emoji Is Available:\nNone',
      );
      expect(postRestartRequest?.lastUserText).not.toContain('🧿');
      expect(postRestartRequest?.lastUserText).not.toContain('🔐');
      expect(postRestartRequest?.lastUserText).not.toContain('🧪');
      expect(postRestartRequest?.lastUserText).not.toContain('📦');
      expect(postRestartRequest?.lastUserText).not.toContain('🧭');
    }, { chatTitleAgent: 'openAiResponses' });
  });
});
