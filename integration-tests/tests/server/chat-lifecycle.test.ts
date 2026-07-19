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
    type: 'pending-user-input-updated',
    input: expect.objectContaining({
      chatId: input.chatId,
      content: input.content,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      turnId: input.turnId,
      deliveryStatus: 'accepted',
    }),
  }));
  expect(events).toContainEqual(expect.objectContaining({
    type: 'chat-processing-updated',
    chatId: input.chatId,
    isProcessing: true,
  }));

  const userEvent = events.find((event): event is ChatMessagesMessage =>
    event.type === 'chat-messages'
    && event.chatId === input.chatId
    && event.messages.some((entry) =>
      entry.message.type === 'user-message' && entry.message.content === input.content));
  expect(userEvent).toMatchObject({
    clientRequestId: input.clientRequestId,
    turnId: input.turnId,
  });
  const user = userEvent?.messages.find((entry) =>
    entry.message.type === 'user-message' && entry.message.content === input.content);
  expect(user?.message).toMatchObject({
    metadata: {
      clientRequestId: input.clientRequestId,
      turnId: input.turnId,
      deliveryStatus: 'accepted',
    },
  });

  const assistantIndex = events.findIndex((event) =>
    event.type === 'chat-messages'
    && event.chatId === input.chatId
    && event.clientRequestId === input.clientRequestId
    && event.turnId === input.turnId
    && event.messages.some((entry) =>
      entry.message.type === 'assistant-message' && entry.message.content === input.assistantContent));
  const clearedIndex = events.findIndex((event) =>
    event.type === 'pending-user-input-cleared'
    && event.chatId === input.chatId
    && event.clientRequestId === input.clientRequestId
    && event.reason === 'persisted');
  const terminalIndex = events.findIndex((event) =>
    event.type === 'agent-run-finished'
    && event.chatId === input.chatId
    && event.clientRequestId === input.clientRequestId
    && event.turnId === input.turnId);
  expect(assistantIndex).toBeGreaterThanOrEqual(0);
  expect(clearedIndex).toBeGreaterThanOrEqual(0);
  expect(terminalIndex).toBeGreaterThan(assistantIndex);
  expect(terminalIndex).toBeGreaterThan(clearedIndex);
}

describe('chat lifecycle', () => {
  test('starts and completes a direct chat through HTTP, WebSocket, and provider sockets', async () => {
    await withIntegrationFixture('direct-chat-happy-path', async (fixture) => {
      const chatId = fixture.newChatId();
      const clientRequestId = crypto.randomUUID();
      const clientMessageId = crypto.randomUUID();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'hello-integration' });
      const observer = await fixture.connectObserver('turn-observer');
      const eventCursor = fixture.client.markEvents();
      const observerCursor = observer.markEvents();

      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'hello-integration',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
        clientRequestId,
        clientMessageId,
      });
      expect(accepted.status).toBe('accepted');
      expect(accepted.chat.id).toBe(chatId);
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
      expect(userMessages(transcript.messages)[0].metadata?.deliveryStatus).not.toBe('failed');
      expect(userMessages(transcript.messages)[0].metadata).toMatchObject({
        clientRequestId,
        turnId: accepted.turnId,
      });
      expect(transcript.pendingUserInputs).toEqual([]);
      expect(fixture.fakeOpenAi.requests()).toHaveLength(1);
    });
  });

  test('preserves provider context across direct turns', async () => {
    await withIntegrationFixture('direct-chat-context', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'turn-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');

      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'turn-b',
        provider: fixture.provider,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, second.turnId)).type).toBe('agent-run-finished');

      const requests = fixture.fakeOpenAi.requests();
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
        provider: fixture.provider,
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

      const requests = fixture.fakeOpenAi.requests();
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
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'chat-a' });
      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'chat-b' });

      const acceptedA = await fixture.client.startDirectChat({
        chatId: chatA,
        content: 'chat-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      const acceptedB = await fixture.client.startDirectChat({
        chatId: chatB,
        content: 'chat-b',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await Promise.all([heldA.received, heldB.received]);

      heldB.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatB, acceptedB.turnId)).type).toBe('agent-run-finished');
      const reconnectWhileAIsHeld = await fixture.client.reconnectState([chatA, chatB]);
      expect(reconnectWhileAIsHeld.processing).toEqual({ outcome: 'snapshot', runningChatIds: [chatA] });

      heldA.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatA, acceptedA.turnId)).type).toBe('agent-run-finished');
      expect(userContents((await fixture.client.getMessages(chatA)).messages)).toEqual(['chat-a']);
      expect(userContents((await fixture.client.getMessages(chatB)).messages)).toEqual(['chat-b']);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText).sort()).toEqual([
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
        provider: fixture.provider,
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
      });
      const first = await fixture.client.startChat(request);
      const duplicate = await fixture.client.startChat(request);
      expect(first.status).toBe('accepted');
      expect(duplicate.status).toBe('duplicate');
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type).toBe('agent-run-finished');
      expect(fixture.fakeOpenAi.requests()).toHaveLength(1);
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
      expect(fixture.fakeOpenAi.requests()).toHaveLength(1);
    });
  });

  test('rejects a concurrent direct turn before mutating pending or transcript state', async () => {
    await withIntegrationFixture('same-chat-direct-admission', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeOpenAi.holdNext({ lastUserText: 'admission-first' });
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'admission-first',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
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
          provider: fixture.provider,
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
        event.type === 'pending-user-input-updated'
        && event.input.clientRequestId === rejectedRequestId)).toBe(false);
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
      expect(whileHeld.pendingUserInputs.map((input) => input.content)).toEqual(['admission-first']);
      expect(fixture.fakeOpenAi.requests()).toHaveLength(1);

      held.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, first.turnId)).type)
        .toBe('agent-run-finished');
      await fixture.client.ping();
      const afterTerminal = fixture.client.eventsSince(cursor);
      expect(afterTerminal.some((event) =>
        event.type === 'pending-user-input-updated'
        && event.input.clientRequestId === rejectedRequestId)).toBe(false);
      expect(afterTerminal.some((event) =>
        event.type === 'chat-messages'
        && (
          event.clientRequestId === rejectedRequestId
          || event.messages.some((entry) =>
            entry.message.type === 'user-message'
            && entry.message.content === 'admission-rejected')
        ))).toBe(false);
      const afterTerminalMessages = await fixture.client.getMessages(chatId);
      expect(afterTerminalMessages.pendingUserInputs.some((input) =>
        input.clientRequestId === rejectedRequestId)).toBe(false);
      expect(countUserContent(afterTerminalMessages.messages, 'admission-rejected')).toBe(0);

      const later = await fixture.client.runDirectChat({
        chatId,
        content: 'admission-later',
        provider: fixture.provider,
      });
      expect((await fixture.client.waitForTurnTerminal(chatId, later.turnId)).type)
        .toBe('agent-run-finished');
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'admission-first',
        'admission-later',
      ]);
    });
  });
});
