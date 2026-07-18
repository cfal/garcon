import { describe, expect, test } from 'bun:test';
import type { ChatMessagesMessage } from '../../../common/ws-events.js';
import { GarconApiError } from '../../support/garcon-client.js';
import {
  assistantContents,
  countUserContent,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('queue lifecycle', () => {
  test('dispatches queued entries in FIFO order', async () => {
    await withIntegrationFixture('queue-fifo', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'fifo-a' });
      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'fifo-b' });
      const heldC = fixture.fakeOpenAi.holdNext({ lastUserText: 'fifo-c' });
      const acceptedA = await fixture.client.startDirectChat({
        chatId,
        content: 'fifo-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;

      const queuedB = await fixture.client.enqueueNew(chatId, 'fifo-b');
      const queuedC = await fixture.client.enqueueNew(chatId, 'fifo-c');
      expect(queuedB.entryId).not.toBe(queuedC.entryId);
      expect(queuedC.queue.entries.map((entry) => [entry.id, entry.content])).toEqual([
        [queuedB.entryId, 'fifo-b'],
        [queuedC.entryId, 'fifo-c'],
      ]);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual(['fifo-a']);

      heldA.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, acceptedA.turnId)).type).toBe('agent-run-finished');
      await heldB.received;
      heldB.releaseEcho();
      await heldC.received;
      const finalCursor = fixture.client.markEvents();
      heldC.releaseEcho();
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: finalCursor });

      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'fifo-a',
        'fifo-b',
        'fifo-c',
      ]);
      expect((await fixture.client.getQueue(chatId)).entries).toEqual([]);
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
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'edit-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'edit-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      const queuedB = await fixture.client.enqueueNew(chatId, 'original-b');
      const queuedC = await fixture.client.enqueueNew(chatId, 'delete-c');
      const entryB = queuedB.queue.entries.find((entry) => entry.id === queuedB.entryId)!;

      const replaced = await fixture.client.replaceQueued({
        clientRequestId: crypto.randomUUID(),
        chatId,
        entryId: entryB.id,
        content: 'edited-b',
        expectedRevision: entryB.revision,
      });
      const editedEntry = replaced.queue.entries.find((entry) => entry.id === entryB.id)!;
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
      expect(deleted.queue.entries.map((entry) => entry.id)).toEqual([entryB.id]);

      const heldEdited = fixture.fakeOpenAi.holdNext({ lastUserText: 'edited-b' });
      heldA.releaseEcho();
      await heldEdited.received;
      const cursor = fixture.client.markEvents();
      heldEdited.releaseEcho();
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
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
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'pause-a' });
      const acceptedA = await fixture.client.startDirectChat({
        chatId,
        content: 'pause-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      await fixture.client.enqueueNew(chatId, 'pause-b');

      const firstPause = await fixture.client.pauseQueue(chatId);
      expect(firstPause.queue.pause?.kind).toBe('manual');
      await fixture.client.resumeQueue(chatId, firstPause.queue.pause!.id);
      const secondPause = await fixture.client.pauseQueue(chatId);
      expect(secondPause.queue.pause?.id).not.toBe(firstPause.queue.pause?.id);

      let staleResume: unknown;
      try {
        await fixture.client.resumeQueue(chatId, firstPause.queue.pause!.id);
      } catch (error) {
        staleResume = error;
      }
      expect(staleResume).toBeInstanceOf(GarconApiError);
      expect((staleResume as GarconApiError).body).toMatchObject({ errorCode: 'QUEUE_PAUSE_CHANGED' });

      heldA.releaseEcho();
      expect((await fixture.client.waitForTurnTerminal(chatId, acceptedA.turnId)).type).toBe('agent-run-finished');
      const pausedQueue = await fixture.client.getQueue(chatId);
      expect(pausedQueue.entries.map((entry) => entry.content)).toEqual(['pause-b']);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual(['pause-a']);

      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'pause-b' });
      await fixture.client.resumeQueue(chatId, secondPause.queue.pause!.id);
      await heldB.received;
      const cursor = fixture.client.markEvents();
      heldB.releaseEcho();
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
      expect((await fixture.client.getQueue(chatId)).pause).toBeNull();
    });
  });

  test('stops active work and leaves queued input paused until resume', async () => {
    await withIntegrationFixture('queue-stop-resume', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'stop-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'stop-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      await fixture.client.enqueueNew(chatId, 'stop-b');

      const stopped = await fixture.client.stopChat({
        chatId,
        clientRequestId: crypto.randomUUID(),
      });
      expect(stopped.stopped).toBe(true);
      expect(stopped.queue.pause).not.toBeNull();
      expect(stopped.queue.entries.map((entry) => entry.content)).toEqual(['stop-b']);
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual(['stop-a']);

      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'stop-b' });
      await fixture.client.resumeQueue(chatId, stopped.queue.pause!.id);
      await heldB.received;
      const cursor = fixture.client.markEvents();
      heldB.releaseEcho();
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
      expect(fixture.fakeOpenAi.requests().map((request) => request.lastUserText)).toEqual([
        'stop-a',
        'stop-b',
      ]);
    });
  });

  test('interrupts and sends without assigning a false failure to the successor', async () => {
    await withIntegrationFixture('interrupt-and-send-delivery', async (fixture) => {
      const chatId = fixture.newChatId();
      const heldA = fixture.fakeOpenAi.holdNext({ lastUserText: 'interrupt-a' });
      await fixture.client.startDirectChat({
        chatId,
        content: 'interrupt-a',
        projectPath: fixture.dirs.project,
        provider: fixture.provider,
      });
      await heldA.received;
      await fixture.client.enqueueNew(chatId, 'interrupt-b');
      const eventCursor = fixture.client.markEvents();
      const heldB = fixture.fakeOpenAi.holdNext({ lastUserText: 'interrupt-b' });

      const interrupted = await fixture.client.interruptAndSend({
        chatId,
        clientRequestId: crypto.randomUUID(),
      });
      expect(interrupted.stopped).toBe(true);
      await heldB.received;

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
      const clientRequestId = successor?.message.type === 'user-message'
        ? successor.message.metadata?.clientRequestId
        : undefined;
      expect(clientRequestId).toBeString();
      expect(fixture.client.events().slice(eventCursor).filter((event) =>
        event.type === 'pending-user-input-status-updated'
        && event.chatId === chatId
        && event.clientRequestId === clientRequestId
        && event.deliveryStatus === 'failed')).toEqual([]);

      heldA.releaseEcho();
      const finalCursor = fixture.client.markEvents();
      heldB.releaseEcho();
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: finalCursor });
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
