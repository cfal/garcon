import { describe, expect, test } from 'bun:test';
import type {
  ChatMessagesMessage,
  ChatTitleUpdatedMessage,
  ServerWsMessage,
} from '../../../common/ws-events.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  assistantContents,
  countUserContent,
  userContents,
  userMessages,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

function expectSuccessfulTurnContract(
  events: readonly ServerWsMessage[],
  input: {
    chatId: string;
    content: string;
    assistantContent: string;
    clientRequestId: string;
    clientMessageId: string;
    turnId: string;
  },
): void {
  expect(events).toContainEqual(expect.objectContaining({
    type: 'chat-list-refresh-requested',
    reason: 'chat-added',
    chatId: input.chatId,
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: 'chat-processing-updated',
    chatId: input.chatId,
    phase: 'running',
  }));

  const userEvent = events.find((event): event is ChatMessagesMessage =>
    event.type === 'chat-messages'
    && event.chatId === input.chatId
    && event.messages.some((entry) =>
      entry.message.type === 'user-message' && entry.message.content === input.content));
  expect(userEvent).toMatchObject({
    clientRequestId: undefined,
    turnId: undefined,
  });
  const user = userEvent?.messages.find((entry) =>
    entry.message.type === 'user-message' && entry.message.content === input.content);
  expect(user?.message).toMatchObject({
    metadata: {
      clientMessageId: input.clientMessageId,
    },
  });
  expect(user?.message.type === 'user-message'
    ? user.message.metadata?.clientRequestId
    : undefined).toBeUndefined();
  expect(user?.message.type === 'user-message'
    ? user.message.metadata?.turnId
    : undefined).toBeUndefined();

  const assistantIndex = events.findIndex((event) =>
    event.type === 'chat-messages'
    && event.chatId === input.chatId
    && event.messages.some((entry) =>
      entry.message.type === 'assistant-message' && entry.message.content === input.assistantContent));
  const terminalIndex = events.findIndex((event) =>
    event.type === 'agent-run-finished'
    && event.chatId === input.chatId
    && event.clientRequestId === input.clientRequestId
    && event.turnId === input.turnId);
  expect(assistantIndex).toBeGreaterThanOrEqual(0);
  expect(terminalIndex).toBeGreaterThan(assistantIndex);
}

describe('chat lifecycle', () => {
  test('starts and completes a direct chat through HTTP, WebSocket, and provider sockets', async () => {
    await withIntegrationFixture('direct-chat-happy-path', async (fixture) => {
      const chatId = fixture.newChatId();
      const clientRequestId = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'hello-integration' });
      const observer = await fixture.connectObserver('turn-observer');
      const eventCursor = fixture.client.markEvents();
      const observerCursor = observer.markEvents();

      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'hello-integration',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        clientRequestId,
        clientMessageId,
      });
      expect(accepted.status).toBe('accepted');
      expect(accepted.chat).not.toBeNull();
      expect(accepted.chat?.id).toBe(chatId);
      expect(accepted.turnId).toBeString();
      expect(accepted.clientRequestId).toBe(clientRequestId);

      const providerRequest = await held.received;
      expect(providerRequest.body.model).toBe('integration-echo');
      expect(providerRequest.body.messages).toEqual([
        { role: 'user', content: 'hello-integration' },
      ]);
      await fixture.client.waitForProcessing(chatId, true, { afterIndex: eventCursor });

      held.releaseEcho();
      const [terminal] = await Promise.all([
        fixture.client.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: eventCursor }),
        observer.waitForTurnTerminal(chatId, accepted.turnId, { afterIndex: observerCursor }),
      ]);
      expect(terminal.type).toBe('agent-run-finished');
      const turnContract = {
        chatId,
        content: 'hello-integration',
        assistantContent: 'echo:hello-integration',
        clientRequestId,
        clientMessageId,
        turnId: accepted.turnId!,
      };
      expectSuccessfulTurnContract(fixture.client.eventsSince(eventCursor), turnContract);
      expectSuccessfulTurnContract(observer.eventsSince(observerCursor), turnContract);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['hello-integration']);
      expect(assistantContents(transcript.messages)).toEqual(['echo:hello-integration']);
      expect(countUserContent(transcript.messages, 'hello-integration')).toBe(1);
      expect(userMessages(transcript.messages)[0].metadata).toEqual({ clientMessageId });
      expect(transcript.resendCandidates).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
    });
  });

  test('preserves provider context across direct turns', async () => {
    await withIntegrationFixture('direct-chat-context', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'turn-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');

      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'turn-b',
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type).toBe('agent-run-finished');

      const requests = fixture.fakeProviders.openAi.requests();
      expect(requests).toHaveLength(2);
      expect(requests[1].body.messages).toEqual([
        { role: 'user', content: 'turn-a' },
        { role: 'assistant', content: 'echo:turn-a' },
        { role: 'user', content: 'turn-b' },
      ]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['turn-a', 'turn-b']);
      expect(assistantContents(transcript.messages)).toEqual(['echo:turn-a', 'echo:turn-b']);
    });
  });

  test('keeps title generation separate from direct transcript execution', async () => {
    await withIntegrationFixture('direct-chat-title-generation', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'title-enabled-turn',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: eventCursor,
      });
      await fixture.client.waitForEvent(
        (event): event is ChatTitleUpdatedMessage =>
          event.type === 'chat-title-updated' && event.chatId === chatId,
        'generated chat title',
        { afterIndex: eventCursor },
      );

      const requests = fixture.fakeProviders.openAi.requests();
      expect(requests).toHaveLength(2);
      expect(requests.filter((request) => request.lastUserText === 'title-enabled-turn')).toHaveLength(1);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['title-enabled-turn']);
      expect(assistantContents(transcript.messages)).toEqual(['echo:title-enabled-turn']);
    }, { chatTitleEnabled: true });
  });

  test('isolates concurrent chats completed in reverse order', async () => {
    await withIntegrationFixture('concurrent-chat-isolation', async (fixture) => {
      const chatA = fixture.newChatId();
      const chatB = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'chat-a' });
      const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'chat-b' });

      const acceptedA = await fixture.client.startDirectChat({
        chatId: chatA,
        content: 'chat-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      const acceptedB = await fixture.client.startDirectChat({
        chatId: chatB,
        content: 'chat-b',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await Promise.all([heldA.received, heldB.received]);

      heldB.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatB, acceptedB.turnId)).type).toBe('agent-run-finished');
      const reconnectWhileAIsHeld = await fixture.client.reconnectState([chatA, chatB]);
      expect(reconnectWhileAIsHeld.processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId: chatA, phase: 'running', retry: null }],
      });

      heldA.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatA, acceptedA.turnId)).type).toBe('agent-run-finished');
      expect(userContents((await fixture.client.getMessages(chatA)).messages)).toEqual(['chat-a']);
      expect(userContents((await fixture.client.getMessages(chatB)).messages)).toEqual(['chat-b']);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText).sort()).toEqual([
        'chat-a',
        'chat-b',
      ]);
    });
  });

  test('deduplicates identical commands and rejects conflicting identity reuse', async () => {
    await withIntegrationFixture('command-idempotency', async (fixture) => {
      const chatId = fixture.newChatId();
      const request = fixture.client.directStartRequest({
        chatId,
        content: 'idempotent',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
      });
      const first = await fixture.client.startChat(request);
      const duplicate = await fixture.client.startChat(request);
      expect(first.status).toBe('accepted');
      expect(duplicate.status).toBe('duplicate');
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
      expect(countUserContent((await fixture.client.getMessages(chatId)).messages, 'idempotent')).toBe(1);

      let conflict: unknown;
      try {
        await fixture.client.startChat({ ...request, command: 'conflicting' });
      } catch (error) {
        conflict = error;
      }
      expect(conflict).toBeInstanceOf(GarconApiError);
      expect((conflict as GarconApiError).status).toBe(409);
      expect((conflict as GarconApiError).body).toMatchObject({
        errorCode: 'IDEMPOTENCY_CONFLICT',
      });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
    });
  });

  test('does not dispatch a second command that reuses a committed client message identity', async () => {
    await withIntegrationFixture('message-idempotency-across-commands', async (fixture) => {
      const chatId = fixture.newChatId();
      const clientMessageId = crypto.randomUUID();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'message-identity-once',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        clientMessageId,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const beforeDuplicate = await fixture.client.getMessages(chatId);

      await fixture.client.runDirectChat({
        chatId,
        content: 'message-identity-once',
        agent: fixture.directAgents.openAi,
        clientRequestId: crypto.randomUUID(),
        clientMessageId,
      });
      await fixture.client.ping();

      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
      expect(await fixture.client.getMessages(chatId)).toEqual(beforeDuplicate);

      const fresh = await fixture.client.runDirectChat({
        chatId,
        content: 'message-identity-fresh',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, fresh.turnId);

      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
      expect(fixture.fakeProviders.openAi.requests().at(-1)?.body.messages).toEqual([
        { role: 'user', content: 'message-identity-once' },
        { role: 'assistant', content: 'echo:message-identity-once' },
        { role: 'user', content: 'message-identity-fresh' },
      ]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([
        'message-identity-once',
        'message-identity-fresh',
      ]);
      expect(assistantContents(transcript.messages)).toEqual([
        'echo:message-identity-once',
        'echo:message-identity-fresh',
      ]);
    });
  });

  test('uses client message identity rather than content equality for duplicate submission', async () => {
    await withIntegrationFixture('message-idempotency-not-content', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstMessageId = crypto.randomUUID();
      const secondMessageId = crypto.randomUUID();
      const repeatedContent = 'equal-content-distinct-occurrences';
      const first = await fixture.client.startDirectChat({
        chatId,
        content: repeatedContent,
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
        clientMessageId: firstMessageId,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);

      let conflictingReuse: unknown;
      try {
        await fixture.client.runDirectChat({
          chatId,
          content: 'different-content-with-reused-identity',
          agent: fixture.directAgents.openAi,
          clientRequestId: crypto.randomUUID(),
          clientMessageId: firstMessageId,
        });
      } catch (error) {
        conflictingReuse = error;
      }
      expect(conflictingReuse).toBeInstanceOf(GarconApiError);
      expect((conflictingReuse as GarconApiError).body).toMatchObject({
        errorCode: 'IDEMPOTENCY_CONFLICT',
      });
      await fixture.client.ping();

      const second = await fixture.client.runDirectChat({
        chatId,
        content: repeatedContent,
        agent: fixture.directAgents.openAi,
        clientMessageId: secondMessageId,
      });
      await fixture.client.waitForTurnTerminal(chatId, second.turnId);

      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
      const transcript = await fixture.client.getMessages(chatId);
      const userRows = transcript.messages.filter((entry) => entry.message.type === 'user-message');
      expect(userRows.map((entry) => ({
        ordinal: entry.ordinal,
        content: entry.message.type === 'user-message' ? entry.message.content : null,
        clientMessageId: entry.message.type === 'user-message'
          ? entry.message.metadata?.clientMessageId
          : null,
      }))).toEqual([
        {
          ordinal: expect.any(Number),
          content: repeatedContent,
          clientMessageId: firstMessageId,
        },
        {
          ordinal: expect.any(Number),
          content: repeatedContent,
          clientMessageId: secondMessageId,
        },
      ]);
      expect(userRows[1]!.ordinal).toBeGreaterThan(userRows[0]!.ordinal);
      expect(JSON.stringify(transcript.messages)).not.toContain('different-content-with-reused-identity');
    });
  }, 15_000);

  test('qualifies committed submission identity by exact attachment content', async () => {
    await withIntegrationFixture('message-idempotency-attachments', async (fixture) => {
      const chatId = fixture.newChatId();
      const clientMessageId = crypto.randomUUID();
      const image = {
        data: 'data:image/png;base64,YQ==',
        name: 'diagram.png',
        mimeType: 'image/png',
      };
      const firstRequest = {
        ...fixture.client.directStartRequest({
          chatId,
          content: 'same-text-with-attachment',
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.anthropic,
          clientMessageId,
        }),
        images: [image],
      };
      const first = await fixture.client.startChat(firstRequest);
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const beforeRetry = await fixture.client.getMessages(chatId);
      const requestCount = fixture.fakeProviders.anthropic.requests().length;

      await fixture.client.runChat({
        ...fixture.client.directRunRequest({
          chatId,
          content: 'same-text-with-attachment',
          agent: fixture.directAgents.anthropic,
          clientRequestId: crypto.randomUUID(),
          clientMessageId,
        }),
        images: [{
          mimeType: image.mimeType,
          data: image.data,
          name: image.name,
        }],
      });
      await fixture.client.ping();
      expect(await fixture.client.getMessages(chatId)).toEqual(beforeRetry);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(requestCount);

      await expect(fixture.client.runChat({
        ...fixture.client.directRunRequest({
          chatId,
          content: 'same-text-with-attachment',
          agent: fixture.directAgents.anthropic,
          clientRequestId: crypto.randomUUID(),
          clientMessageId,
        }),
        images: [{ ...image, data: 'data:image/png;base64,Yg==' }],
      })).rejects.toMatchObject({
        status: 409,
        body: { errorCode: 'IDEMPOTENCY_CONFLICT' },
      });
      expect(await fixture.client.getMessages(chatId)).toEqual(beforeRetry);
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(requestCount);
    });
  });

  test('rejects a concurrent direct turn before mutating transcript state', async () => {
    await withIntegrationFixture('same-chat-direct-admission', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'admission-first' });
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'admission-first',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;

      const rejectedRequestId = crypto.randomUUID();
      const rejectedMessageId = crypto.randomUUID();
      const cursor = fixture.client.markEvents();
      let rejected: unknown;
      try {
        await fixture.client.runDirectChat({
          chatId,
          content: 'admission-rejected',
          agent: fixture.directAgents.openAi,
          clientRequestId: rejectedRequestId,
          clientMessageId: rejectedMessageId,
        });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(GarconApiError);
      expect(rejected).toMatchObject({
        status: 409,
        body: { errorCode: 'SESSION_BUSY' },
      });
      await fixture.client.ping();

      const rejectedEvents = fixture.client.eventsSince(cursor);
      expect(rejectedEvents.some((event) =>
        event.type === 'chat-messages'
        && (
          event.clientRequestId === rejectedRequestId
          || event.messages.some((entry) =>
            entry.message.type === 'user-message'
            && entry.message.content === 'admission-rejected')
        ))).toBe(false);
      const whileHeld = await fixture.client.getMessages(chatId);
      expect(userContents(whileHeld.messages)).toEqual(['admission-first']);
      expect(whileHeld.resendCandidates).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
        .toBe('agent-run-finished');
      await fixture.client.ping();
      const afterTerminal = fixture.client.eventsSince(cursor);
      expect(afterTerminal.some((event) =>
        event.type === 'chat-messages'
        && (
          event.clientRequestId === rejectedRequestId
          || event.messages.some((entry) =>
            entry.message.type === 'user-message'
            && entry.message.content === 'admission-rejected')
        ))).toBe(false);
      const afterTerminalMessages = await fixture.client.getMessages(chatId);
      expect(countUserContent(afterTerminalMessages.messages, 'admission-rejected')).toBe(0);

      const later = await fixture.client.runDirectChat({
        chatId,
        content: 'admission-later',
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, later.turnId)).type)
        .toBe('agent-run-finished');
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'admission-first',
        'admission-later',
      ]);
    });
  });
});
