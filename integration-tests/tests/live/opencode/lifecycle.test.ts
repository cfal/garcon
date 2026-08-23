import { describe, expect, test } from 'bun:test';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../../support/integration-fixture.js';
import {
  exactReplyPrompt,
  expectAssistantMarker,
  LIVE_TURN_TIMEOUT_MS,
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
  test('renders a real tool call and continues after an answered question', async () => {
    const fixtureOptions = await liveOpenCodeFixtureOptions();
    await withIntegrationFixture('live-opencode-tool-question', async (fixture) => {
      const chatId = fixture.newChatId();
      const questionMarker = liveMarker('OPENCODE_QUESTION');
      const toolMarker = liveMarker('OPENCODE_BASH');
      const replyMarker = liveMarker('OPENCODE_TOOL_REPLY');
      const questionPrompt = `Which mode should ${questionMarker} use?`;
      const command = `printf '%s' '${toolMarker}'`;
      const prompt = [
        'Use the question tool immediately as your first action.',
        `Ask exactly one single-select question with header "Integration", question "${questionPrompt}", and exactly two options: "Careful" described as "Run the compatibility check." and "Stop" described as "Do not run it.".`,
        'Do not answer the question yourself or use another tool before the user answers.',
        `Only if the answer is "Careful", use the bash tool exactly once to run exactly \`${command}\`.`,
        `After bash succeeds, reply with exactly ${replyMarker}.`,
        'Do not use any other tools.',
      ].join(' ');
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));

      const permission = await fixture.client.waitForTransientPermission(
        chatId,
        (row) => row.message.type === 'permission-request'
          && row.message.requestedTool.type === 'ask-user-question-tool-use'
          && row.message.requestedTool.questions.some((question) =>
            question.prompt.includes(questionMarker)),
        { afterIndex: cursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      if (
        permission.message.type !== 'permission-request'
        || permission.message.requestedTool.type !== 'ask-user-question-tool-use'
      ) {
        throw new Error('Live OpenCode question request was not rendered.');
      }
      const questions = permission.message.requestedTool.questions;
      expect(questions).toHaveLength(1);
      const question = questions[0]!;
      expect(question.prompt).toContain(questionMarker);
      expect(question.allowMultiple).toBe(false);
      const selected = question.options.find((option) => option.label === 'Careful');
      if (!selected) throw new Error('Live OpenCode question omitted the Careful option.');

      expect((await fixture.client.sendPermissionDecision({
        clientRequestId: crypto.randomUUID(),
        chatId,
        permissionOccurrenceId: permission.message.permissionOccurrenceId,
        allow: true,
        alwaysAllow: false,
        response: {
          type: 'ask-user-question-response',
          outcome: 'answered',
          answers: [{ questionId: question.id, selectedOptionIds: [selected.id] }],
        },
      })).status).toBe('accepted');

      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: replyMarker,
        afterIndex: cursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      const questionTools = messagesOfType(
        transcript.messages,
        'ask-user-question-tool-use',
      );
      expect(questionTools).toHaveLength(1);
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command.includes(toolMarker),
      );
      if (!bash) throw new Error('Live OpenCode Bash tool use was not rendered.');
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(toolMarker);
      expect(messagesOfType(transcript.messages, 'permission-resolved')).toContainEqual(
        expect.objectContaining({
          permissionOccurrenceId: permission.message.permissionOccurrenceId,
          allowed: true,
        }),
      );
      expect(messagesOfType(transcript.messages, 'unknown-tool-use')).toEqual([]);
      expectAssistantMarker(assistantContents(transcript.messages), replyMarker);
    }, fixtureOptions);
  }, 180_000);

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
