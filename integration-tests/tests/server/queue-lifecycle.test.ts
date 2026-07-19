import { describe, expect, test } from 'bun:test';
import type {
  ChatMessagesMessage,
  PendingUserInputClearedMessage,
  PendingUserInputUpdatedMessage,
} from '../../../common/ws-events.js';
import { GarconApiError, type GarconTestClient } from '../../support/garcon-client.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

async function waitForQueuedTurnIdentity(
  client: GarconTestClient,
  chatId: string,
  content: string,
  afterIndex = 0,
) {
  const event = await client.waitForEvent(
    (message): message is PendingUserInputUpdatedMessage =>
      message.type === 'pending-user-input-updated'
      && message.input.chatId === chatId
      && message.input.content === content,
    `queued turn identity for ${content}`,
    { afterIndex },
  );
  expect(event.input.clientRequestId).toBeString();
  expect(event.input.clientMessageId).toBeString();
  expect(event.input.turnId).toBeString();
  return event.input as typeof event.input & {
    clientMessageId: string;
    turnId: string;
  };
}

describe('queue lifecycle', () => {
  test('dispatches queued entries in FIFO order', async () => {
    await withIntegrationFixture('queue-fifo', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'fifo-a' });
      const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'fifo-b' });
      const heldC = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'fifo-c' });
      const acceptedA = await fixture.client.startDirectChat({
        chatId,
        content: 'fifo-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;

      const queueRequestId = crypto.randomUUID();
      const queueRequest = {
        chatId,
        content: 'fifo-b',
        clientRequestId: queueRequestId,
      };
      const queuedB = await fixture.client.enqueue(queueRequest);
      const duplicateB = await fixture.client.enqueue(queueRequest);
      expect(duplicateB).toMatchObject({
        status: 'duplicate',
        entryId: queuedB.entryId,
      });
      expect(duplicateB.control.queue.entries.map((entry) => entry.id)).toEqual([queuedB.entryId]);
      let queueConflict: unknown;
      try {
        await fixture.client.enqueue({ ...queueRequest, content: 'fifo-conflict' });
      } catch (error) {
        queueConflict = error;
      }
      expect(queueConflict).toBeInstanceOf(GarconApiError);
      expect(queueConflict).toMatchObject({
        status: 409,
        body: { errorCode: 'IDEMPOTENCY_CONFLICT' },
      });
      const queuedC = await fixture.client.enqueueNew(chatId, 'fifo-c');
      expect(queuedB.entryId).not.toBe(queuedC.entryId);
      expect(queuedC.control.queue.entries.map((entry) => [entry.id, entry.content])).toEqual([
        [queuedB.entryId, 'fifo-b'],
        [queuedC.entryId, 'fifo-c'],
      ]);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual(['fifo-a']);

      heldA.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, acceptedA.turnId)).type).toBe('agent-run-finished');
      await heldB.received;
      heldB.releaseEcho();
      await heldC.received;
      const queuedTurnC = await waitForQueuedTurnIdentity(fixture.client, chatId, 'fifo-c');
      const finalCursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, queuedTurnC.turnId, { afterIndex: finalCursor });

      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'fifo-a',
        'fifo-b',
        'fifo-c',
      ]);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual(['fifo-a', 'fifo-b', 'fifo-c']);
      expect(assistantContents(transcript.messages)).toEqual([
        'echo:fifo-a',
        'echo:fifo-b',
        'echo:fifo-c',
      ]);
      for (const content of ['fifo-a', 'fifo-b', 'fifo-c']) {
        expect(countUserContent(transcript.messages, content)).toBe(1);
      }
    });
  });

  test('edits and deletes queued inputs by stable identity', async () => {
    await withIntegrationFixture('queue-edit-delete', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'edit-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'edit-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'original-b');
      const queuedC = await fixture.client.enqueueNew(chatId, 'delete-c');
      const entryB = queuedB.control.queue.entries.find((entry) => entry.id === queuedB.entryId)!;

      const replaced = await fixture.client.replaceQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: entryB.id,
        content: 'edited-b',
        expectedRevision: entryB.revision,
      });
      const editedEntry = replaced.control.queue.entries.find((entry) => entry.id === entryB.id)!;
      expect(editedEntry.revision).toBe(entryB.revision + 1);
      expect(editedEntry.content).toBe('edited-b');

      let staleError: unknown;
      try {
        await fixture.client.replaceQueued({
          clientRequestId: crypto.randomUUID(),
          chatId,
          entryId: entryB.id,
          content: 'stale-edit',
          expectedRevision: entryB.revision,
        });
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toBeInstanceOf(GarconApiError);
      expect((staleError as GarconApiError).body).toMatchObject({
        errorCode: 'QUEUE_ENTRY_REVISION_CONFLICT',
      });

      const deleted = await fixture.client.deleteQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: queuedC.entryId,
      });
      expect(deleted.control.queue.entries.map((entry) => entry.id)).toEqual([entryB.id]);

      const heldEdited = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'edited-b' });
      heldA.releaseEcho();
      await heldEdited.received;
      const editedTurn = await waitForQueuedTurnIdentity(fixture.client, chatId, 'edited-b');
      const cursor = fixture.client.markEvents();
      heldEdited.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, editedTurn.turnId, { afterIndex: cursor });
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'edit-a',
        'edited-b',
      ]);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        'edit-a',
        'edited-b',
      ]);
    });
  });

  test('uses pause identities and resumes without aborting the active turn', async () => {
    await withIntegrationFixture('queue-pause-resume', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'pause-a' });
      const acceptedA = await fixture.client.startDirectChat({
        chatId,
        content: 'pause-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      await fixture.client.enqueueNew(chatId, 'pause-b');

      const firstPause = await fixture.client.pauseQueue(chatId);
      expect(firstPause.control.queue.pause?.kind).toBe('manual');
      await fixture.client.resumeQueue(chatId, firstPause.control.queue.pause!.id);
      const secondPause = await fixture.client.pauseQueue(chatId);
      expect(secondPause.control.queue.pause?.id).not.toBe(firstPause.control.queue.pause?.id);

      let staleResume: unknown;
      try {
        await fixture.client.resumeQueue(chatId, firstPause.control.queue.pause!.id);
      } catch (error) {
        staleResume = error;
      }
      expect(staleResume).toBeInstanceOf(GarconApiError);
      expect((staleResume as GarconApiError).body).toMatchObject({ errorCode: 'QUEUE_PAUSE_CHANGED' });

      heldA.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, acceptedA.turnId)).type).toBe('agent-run-finished');
      const pausedQueue = (await fixture.client.getExecutionControl(chatId)).queue;
      expect(pausedQueue.entries.map((entry) => entry.content)).toEqual(['pause-b']);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual(['pause-a']);

		const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'pause-b' });
		await fixture.client.resumeQueue(chatId, secondPause.control.queue.pause!.id);
      await heldB.received;
      const queuedTurnB = await waitForQueuedTurnIdentity(fixture.client, chatId, 'pause-b');
      const cursor = fixture.client.markEvents();
      heldB.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, queuedTurnB.turnId, { afterIndex: cursor });
      expect((await fixture.client.getExecutionControl(chatId)).queue.pause).toBeNull();
    });
  });

  test('stops active work and leaves queued input paused until resume', async () => {
    await withIntegrationFixture('queue-stop-resume', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'stop-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'stop-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      await fixture.client.enqueueNew(chatId, 'stop-b');

      const activeAborted = heldA.expectAbort();
      const stopCursor = fixture.client.markEvents();
      const stopRequest = {
        chatId,
        clientRequestId: crypto.randomUUID(),
      };
      const stopped = await fixture.client.stopChat(stopRequest);
      await activeAborted;
      const duplicateStop = await fixture.client.stopChat(stopRequest);
      expect(stopped.stopped).toBe(true);
      expect(duplicateStop).toMatchObject({
        status: 'duplicate',
        stopped: true,
        control: stopped.control,
      });
      await fixture.client.ping();
      expect(fixture.client.eventsSince(stopCursor).filter((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.intent === 'stop')).toHaveLength(1);
		expect(stopped.control.queue.pause).not.toBeNull();
		expect(stopped.control.queue.entries.map((entry) => entry.content)).toEqual(['stop-b']);
		expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual(['stop-a']);

		const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'stop-b' });
		await fixture.client.resumeQueue(chatId, stopped.control.queue.pause!.id);
      await heldB.received;
      const queuedTurnB = await waitForQueuedTurnIdentity(fixture.client, chatId, 'stop-b');
      const cursor = fixture.client.markEvents();
      heldB.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, queuedTurnB.turnId, { afterIndex: cursor });
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'stop-a',
        'stop-b',
      ]);
    });
  });

  test('stops an actively draining entry without dispatching its queued successor', async () => {
    await withIntegrationFixture('queue-stop-active-drain', async (fixture) => {
      const chatId = fixture.newChatId();
      const seed = await fixture.client.startDirectChat({
        chatId,
        content: 'drain-stop-seed',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, seed.turnId);

      const heldActive = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'drain-stop-active' });
      await fixture.client.runDirectChat({
        chatId,
        content: 'drain-stop-active',
        agent: fixture.directAgents.openAi,
      });
      await heldActive.received;
      await fixture.client.enqueueNew(chatId, 'drain-stop-b');
      await fixture.client.enqueueNew(chatId, 'drain-stop-c');
      const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'drain-stop-b' });
      heldActive.releaseEcho();
      await heldB.received;

      const duringDrain = await fixture.client.getMessages(chatId);
      const pendingB = duringDrain.pendingUserInputs.find((entry) => entry.content === 'drain-stop-b');
      if (!pendingB) throw new Error('Actively draining input was not pending.');
      const stopCursor = fixture.client.markEvents();
      const activeAborted = heldB.expectAbort();
      const stopped = await fixture.client.stopChat({
        chatId,
        clientRequestId: crypto.randomUUID(),
      });
      await activeAborted;
      expect(stopped.stopped).toBe(true);
		expect(stopped.control.queue.pause?.kind).toBe('manual');
		expect(stopped.control.queue.entries.map((entry) => entry.content)).toEqual(['drain-stop-c']);
		expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'drain-stop-seed',
        'drain-stop-active',
        'drain-stop-b',
      ]);
      await fixture.client.waitForEvent(
        (event): event is PendingUserInputClearedMessage =>
          event.type === 'pending-user-input-cleared'
          && event.chatId === chatId
          && event.clientRequestId === pendingB.clientRequestId
          && event.reason === 'persisted',
        'stopped drain persistence settlement',
        { afterIndex: stopCursor },
      );

		const heldC = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'drain-stop-c' });
		await fixture.client.resumeQueue(chatId, stopped.control.queue.pause!.id);
      await heldC.received;
      const queuedTurnC = await waitForQueuedTurnIdentity(fixture.client, chatId, 'drain-stop-c');
      const completionCursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, queuedTurnC.turnId, {
        afterIndex: completionCursor,
      });

      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'drain-stop-seed',
        'drain-stop-active',
        'drain-stop-b',
        'drain-stop-c',
      ]);
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, 'drain-stop-b')).toBe(1);
      expect(countUserContent(transcript.messages, 'drain-stop-c')).toBe(1);
      expect(transcript.pendingUserInputs).toEqual([]);
    });
  });

  test('interrupts and sends without assigning a false failure to the successor', async () => {
    await withIntegrationFixture('interrupt-and-send-delivery', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'interrupt-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'interrupt-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await heldA.received;
      await fixture.client.enqueueNew(chatId, 'interrupt-b');
      const eventCursor = fixture.client.markEvents();
      const heldB = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'interrupt-b' });

      const activeAborted = heldA.expectAbort();
      const interruptRequest = {
        chatId,
        clientRequestId: crypto.randomUUID(),
      };
      const interrupted = await fixture.client.interruptAndSend(interruptRequest);
      await activeAborted;
      const duplicateInterrupt = await fixture.client.interruptAndSend(interruptRequest);
      expect(interrupted.stopped).toBe(true);
      expect(duplicateInterrupt).toMatchObject({
        status: 'duplicate',
        stopped: true,
      });
      await heldB.received;
      await fixture.client.ping();
      const interruptEvents = fixture.client.eventsSince(eventCursor);
      expect(interruptEvents.filter((event) =>
        event.type === 'chat-session-stopped'
        && event.chatId === chatId
        && event.intent === 'interrupt-and-send')).toHaveLength(1);
      expect(interruptEvents.filter((event) =>
        event.type === 'queue-dispatching'
        && event.chatId === chatId
        && event.content === 'interrupt-b')).toHaveLength(1);

      const successorMessageEvent = await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage =>
          event.type === 'chat-messages'
          && event.chatId === chatId
          && event.messages.some((entry) =>
            entry.message.type === 'user-message' && entry.message.content === 'interrupt-b'),
        'interrupt successor user message',
        { afterIndex: eventCursor },
      );
      const successor = successorMessageEvent.messages.find((entry) =>
        entry.message.type === 'user-message' && entry.message.content === 'interrupt-b');
      const successorIdentity = await waitForQueuedTurnIdentity(
        fixture.client,
        chatId,
        'interrupt-b',
        eventCursor,
      );
      const clientRequestId = successor?.message.type === 'user-message'
        ? successor.message.metadata?.clientRequestId
        : undefined;
      expect(clientRequestId).toBe(successorIdentity.clientRequestId);
      expect(successor?.message.type === 'user-message'
        ? successor.message.metadata?.turnId
        : undefined).toBe(successorIdentity.turnId);
      expect(successorMessageEvent).toMatchObject({
        clientRequestId: successorIdentity.clientRequestId,
        turnId: successorIdentity.turnId,
      });
      expect(fixture.client.events().slice(eventCursor).filter((event) =>
        event.type === 'pending-user-input-status-updated'
        && event.chatId === chatId
        && event.clientRequestId === clientRequestId
        && event.deliveryStatus === 'failed')).toEqual([]);

      heldA.releaseText('stale response must be ignored');
      const finalCursor = fixture.client.markEvents();
      heldB.releaseEcho();
      await Promise.all([
        fixture.client.waitForEvent(
          (event): event is PendingUserInputClearedMessage =>
            event.type === 'pending-user-input-cleared'
            && event.chatId === chatId
            && event.clientRequestId === clientRequestId
            && event.reason === 'persisted',
          'interrupt successor persistence',
          { afterIndex: finalCursor },
        ),
        fixture.client.waitForTurnTerminal(chatId, successorIdentity.turnId, {
          afterIndex: finalCursor,
        }),
      ]);
      const transcript = await fixture.client.getMessages(chatId);
      expect(countUserContent(transcript.messages, 'interrupt-b')).toBe(1);
      expect(transcript.pendingUserInputs).toEqual([]);
      expect(fixture.client.events().filter((event) =>
        event.type === 'pending-user-input-status-updated'
        && event.chatId === chatId
        && event.clientRequestId === clientRequestId
        && event.deliveryStatus === 'failed')).toEqual([]);
    });
  });
});
