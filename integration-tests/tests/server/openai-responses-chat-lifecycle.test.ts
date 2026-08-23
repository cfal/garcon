import { describe, expect, test } from 'bun:test';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('OpenAI Responses chat lifecycle', () => {
  test('starts, resumes, persists, and rehydrates direct Responses history', async () => {
    await withIntegrationFixture('openai-responses-chat-lifecycle', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'responses-turn-one',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAiResponses,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe(
        'agent-run-finished',
      );

      const firstRequest = fixture.fakeProviders.openAiResponses.requests()[0];
      expect(firstRequest.body).toEqual({
        model: 'integration-responses-echo',
        input: [{ role: 'user', content: 'responses-turn-one' }],
        previous_response_id: null,
        stream: true,
        store: true,
      });

      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'responses-turn-two',
        agent: fixture.directAgents.openAiResponses,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type).toBe(
        'agent-run-finished',
      );
      const secondRequest = fixture.fakeProviders.openAiResponses.requests()[1];
      expect(secondRequest.body).toEqual({
        model: 'integration-responses-echo',
        input: [{ role: 'user', content: 'responses-turn-two' }],
        previous_response_id: firstRequest.responseId,
        stream: true,
        store: true,
      });

      const beforeRestart = await fixture.client.getMessages(chatId);
      expect(userContents(beforeRestart.messages)).toEqual([
        'responses-turn-one',
        'responses-turn-two',
      ]);
      expect(assistantContents(beforeRestart.messages)).toEqual([
        'echo:responses-turn-one',
        'echo:responses-turn-two',
      ]);

      await fixture.restartGarcon();
      const third = await fixture.client.runDirectChat({
        chatId,
        content: 'responses-turn-three',
        agent: fixture.directAgents.openAiResponses,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, third.turnId)).type).toBe(
        'agent-run-finished',
      );
      expect(fixture.fakeProviders.openAiResponses.requests()[2].body).toEqual({
        model: 'integration-responses-echo',
        input: [{ role: 'user', content: 'responses-turn-three' }],
        previous_response_id: secondRequest.responseId,
        stream: true,
        store: true,
      });
      expect(fixture.fakeProviders.openAi.requests()).toEqual([]);
      expect(fixture.fakeProviders.anthropic.requests()).toEqual([]);
    });
  });

  test('recovers an expired checkpoint once from complete local history', async () => {
    await withIntegrationFixture('openai-responses-checkpoint-recovery', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'responses-before-expiry',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAiResponses,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const firstRequest = fixture.fakeProviders.openAiResponses.requests()[0];
      expect(fixture.fakeProviders.openAiResponses.expireResponse(firstRequest.responseId)).toBe(
        true,
      );

      const recovered = await fixture.client.runDirectChat({
        chatId,
        content: 'responses-after-expiry',
        agent: fixture.directAgents.openAiResponses,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, recovered.turnId)).type).toBe(
        'agent-run-finished',
      );
      const failedContinuation = fixture.fakeProviders.openAiResponses.requests()[1];
      const fullRetry = fixture.fakeProviders.openAiResponses.requests()[2];
      expect(failedContinuation.body).toMatchObject({
        input: [{ role: 'user', content: 'responses-after-expiry' }],
        previous_response_id: firstRequest.responseId,
        store: true,
      });
      expect(fullRetry.body).toMatchObject({
        input: [
          { role: 'user', content: 'responses-before-expiry' },
          { role: 'assistant', content: 'echo:responses-before-expiry' },
          { role: 'user', content: 'responses-after-expiry' },
        ],
        previous_response_id: null,
        store: true,
      });

      const following = await fixture.client.runDirectChat({
        chatId,
        content: 'responses-after-recovery',
        agent: fixture.directAgents.openAiResponses,
      });
      await fixture.client.waitForTurnTerminal(chatId, following.turnId);
      expect(fixture.fakeProviders.openAiResponses.requests()[3].body).toMatchObject({
        input: [{ role: 'user', content: 'responses-after-recovery' }],
        previous_response_id: fullRetry.responseId,
      });
    });
  });

  test('starts a full-context chain after a Responses endpoint change', async () => {
    await withIntegrationFixture('openai-responses-endpoint-change', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'responses-before-route-change',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAiResponses,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const changedProvider = await fixture.client.createOpenAiResponsesProvider(
        fixture.fakeProviders.openAiResponses.baseUrl,
      );

      const changed = await fixture.client.runDirectChat({
        chatId,
        content: 'responses-after-route-change',
        agent: {
          ...fixture.directAgents.openAiResponses,
          provider: changedProvider,
        },
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, changed.turnId)).type).toBe(
        'agent-run-finished',
      );
      expect(fixture.fakeProviders.openAiResponses.requests()[1].body).toMatchObject({
        input: [
          { role: 'user', content: 'responses-before-route-change' },
          { role: 'assistant', content: 'echo:responses-before-route-change' },
          { role: 'user', content: 'responses-after-route-change' },
        ],
        previous_response_id: null,
        store: true,
      });
    });
  });

  test('generates titles from reasoning-first Responses SSE and rejects truncation', async () => {
    await withIntegrationFixture('openai-responses-title-generation', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startDirectChat({
        chatId,
        content: 'create-title-source-chat',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);

      fixture.fakeProviders.openAiResponses.respondThinkingThenTextNext(
        { lastUserTextIncludes: 'responses-title-source' },
        'Responses Stream Title',
      );
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'responses-title-source',
      })).resolves.toEqual({
        success: true,
        chatId,
        title: 'Responses Stream Title',
      });

      const titleRequest = fixture.fakeProviders.openAiResponses.requests()[0];
      expect(titleRequest.body).toMatchObject({
        model: 'integration-responses-echo',
        stream: true,
        store: false,
      });
      expect(titleRequest.lastUserText).toContain('### Task:');
      expect(titleRequest.lastUserText).toContain('responses-title-source');

      fixture.fakeProviders.openAiResponses.failNextResponse(
        { lastUserTextIncludes: 'responses-failed-title' },
        'title generation failed',
      );
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'responses-failed-title',
      })).rejects.toMatchObject({
        status: 502,
        body: { errorCode: 'TITLE_GENERATION_FAILED' },
      });

      fixture.fakeProviders.openAiResponses.incompleteNextResponse(
        { lastUserTextIncludes: 'responses-incomplete-title' },
        'max_output_tokens',
      );
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'responses-incomplete-title',
      })).rejects.toMatchObject({
        status: 502,
        body: { errorCode: 'TITLE_GENERATION_FAILED' },
      });

      fixture.fakeProviders.openAiResponses.respondEmptyNext({
        lastUserTextIncludes: 'responses-empty-title',
      });
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'responses-empty-title',
      })).rejects.toMatchObject({
        status: 422,
        body: { errorCode: 'TITLE_GENERATION_EMPTY' },
      });

      fixture.fakeProviders.openAiResponses.truncateNextStream({
        lastUserTextIncludes: 'responses-truncated-title',
      });
      await expect(fixture.client.generateChatTitle({
        chatId,
        message: 'responses-truncated-title',
      })).rejects.toMatchObject({ status: 502 });

      const chats = await fixture.client.listChats();
      expect(chats.sessions.find((chat) => chat.id === chatId)?.title).toBe(
        'Responses Stream Title',
      );
      expect(fixture.fakeProviders.openAiResponses.requests()).toHaveLength(5);
      expect(fixture.fakeProviders.openAiResponses.requests().every((request) => (
        request.body.stream === true && request.body.store === false
      ))).toBe(true);
    }, { chatTitleAgent: 'openAiResponses' });
  });

  test('rejects Responses failures without persisting partial assistant output', async () => {
    await withIntegrationFixture('openai-responses-provider-failures', async (fixture) => {
      const failures = [
        {
          content: 'responses-http-error',
          configure: () => fixture.fakeProviders.openAiResponses.failNextHttp(
            { lastUserText: 'responses-http-error' },
            429,
            'rate limited',
          ),
        },
        {
          content: 'responses-stream-error',
          configure: () => fixture.fakeProviders.openAiResponses.failNextStream(
            { lastUserText: 'responses-stream-error' },
            'stream failed',
          ),
        },
        {
          content: 'responses-failed',
          configure: () => fixture.fakeProviders.openAiResponses.failNextResponse(
            { lastUserText: 'responses-failed' },
            'generation failed',
          ),
        },
        {
          content: 'responses-incomplete',
          configure: () => fixture.fakeProviders.openAiResponses.incompleteNextResponse(
            { lastUserText: 'responses-incomplete' },
            'max_output_tokens',
          ),
        },
        {
          content: 'responses-empty',
          configure: () => fixture.fakeProviders.openAiResponses.respondEmptyNext({
            lastUserText: 'responses-empty',
          }),
        },
        {
          content: 'responses-truncated',
          configure: () => fixture.fakeProviders.openAiResponses.truncateNextStream({
            lastUserText: 'responses-truncated',
          }),
        },
      ];

      for (const failure of failures) {
        const chatId = fixture.newChatId();
        failure.configure();
        const accepted = await fixture.client.startDirectChat({
          chatId,
          content: failure.content,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAiResponses,
        });
        const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
        expect(terminal).toMatchObject({
          type: 'agent-run-failed',
          chatId,
          turnId: accepted.turnId,
        });
        expect((terminal as AgentRunFailedMessage).error).toBeString();

        const transcript = await fixture.client.getMessages(chatId);
        expect(userContents(transcript.messages)).toEqual([failure.content]);
        expect(assistantContents(transcript.messages)).toEqual([]);
      }
      expect(fixture.fakeProviders.openAiResponses.requests()).toHaveLength(failures.length);
    });
  });

  test('skips malformed Responses events before a valid completion', async () => {
    await withIntegrationFixture('openai-responses-malformed-sse', async (fixture) => {
      const chatId = fixture.newChatId();
      fixture.fakeProviders.openAiResponses.respondMalformedThenTextNext(
        { lastUserText: 'responses-malformed-then-valid' },
        'valid-after-malformed',
      );
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'responses-malformed-then-valid',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAiResponses,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).type).toBe(
        'agent-run-finished',
      );
      const transcript = await fixture.client.getMessages(chatId);
      expect(assistantContents(transcript.messages)).toEqual(['valid-after-malformed']);
    });
  });

  test('propagates session abort and leaves no partial assistant turn', async () => {
    await withIntegrationFixture('openai-responses-session-abort', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAiResponses.holdNext({
        lastUserText: 'responses-abort',
      });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'responses-abort',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAiResponses,
      });
      await held.received;
      const aborted = held.expectAbort();
      const cursor = fixture.client.markEvents();

      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
        agentId: fixture.directAgents.openAiResponses.agentId,
      });
      expect(stopped.outcome).toBe('interrupt-requested');
      expect((await aborted).abortedAt).toBeNumber();
      expect((await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: cursor,
      })).type).toBe('agent-run-finished');

      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['responses-abort']);
      expect(assistantContents(transcript.messages)).toEqual([]);
    });
  });
});
