import { describe, expect, test } from 'bun:test';
import {
  assistantContents,
  userContents,
} from '../../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../../support/integration-fixture.js';
import {
  exactReplyPrompt,
  expectAssistantMarker,
  liveMarker,
  waitForVisibleResponse,
} from '../../../support/live-agent.js';
import {
  liveOpenCodeFixtureOptions,
  liveOpenCodeRunRequest,
  liveOpenCodeStartRequest,
} from '../../../support/live-opencode.js';
import { openCodeNativeSession } from '../../../support/scripted-opencode.js';

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('live OpenCode lifecycle', () => {
  test('restores archived history and resumes the native session after restart', async () => {
    const fixtureOptions = await liveOpenCodeFixtureOptions();
    await withIntegrationFixture('live-opencode-restart', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstMarker = liveMarker('OPENCODE_FIRST');
      const firstPrompt = exactReplyPrompt(firstMarker);
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstMarker,
        afterIndex: firstCursor,
      });

      const nativeBefore = await openCodeNativeSession(fixture, chatId);
      const transcriptBefore = await fixture.client.getMessages(chatId);
      expectAssistantMarker(assistantContents(transcriptBefore.messages), firstMarker);

      await fixture.restartGarcon();

      const restored = await fixture.client.getMessages(chatId);
      expect(restored).toEqual(transcriptBefore);
      expect(await openCodeNativeSession(fixture, chatId)).toEqual(nativeBefore);

      const secondMarker = liveMarker('OPENCODE_SECOND');
      const secondPrompt = exactReplyPrompt(secondMarker);
      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(liveOpenCodeRunRequest({
        chatId,
        command: secondPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondMarker,
        afterIndex: secondCursor,
      });

      const finalTranscript = await fixture.client.getMessages(chatId);
      expect(finalTranscript.transcriptViewId).toBe(transcriptBefore.transcriptViewId);
      expect(finalTranscript.messages.slice(0, transcriptBefore.messages.length))
        .toEqual(transcriptBefore.messages);
      expect(userContents(finalTranscript.messages)).toEqual([firstPrompt, secondPrompt]);
      expectAssistantMarker(assistantContents(finalTranscript.messages), firstMarker);
      expectAssistantMarker(assistantContents(finalTranscript.messages), secondMarker);
      expect((await openCodeNativeSession(fixture, chatId)).agentSessionId)
        .toBe(nativeBefore.agentSessionId);
    }, fixtureOptions);
  }, 180_000);
});
