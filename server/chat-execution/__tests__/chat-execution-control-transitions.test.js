import { describe, expect, it } from 'bun:test';
import { emptyStoredChatExecutionControl } from '../control-state.ts';
import {
  clearQueue,
  consumeQueueSteer,
  createQueueEntry,
  dequeueNextQueueEntry,
  deleteQueueEntry,
  moveQueueEntry,
  pauseAfterDispatchFailure,
  pauseQueue,
  releaseQueueSteer,
  replaceQueueEntry,
  reserveQueueSteer,
  resumeQueue,
} from '../chat-execution-control-transitions.ts';

function context(tick = 1, unsettled = []) {
  return {
    now: `2026-08-12T00:00:0${tick}.000Z`,
    newId: () => `id-${tick}`,
    unsettledQueueReceiptKeys: () => new Set(unsettled),
  };
}

function initial() {
  return emptyStoredChatExecutionControl('server-1');
}

function value(transition) {
  expect(transition.outcome.status).toBe('ok');
  return transition.outcome.value;
}

function rejection(transition) {
  expect(transition.outcome.status).toBe('rejected');
  return transition.outcome.rejection;
}

function add(control, content, tick, input = {}) {
  return createQueueEntry(control, { content, ...input }, context(tick));
}

describe('chat execution control transitions', () => {
  it('creates, replaces, moves, and deletes queued entries by stable identity', () => {
    const first = add(initial(), 'first', 1);
    const firstId = value(first).entryId;
    const second = add(first.next, 'second', 2);
    const secondId = value(second).entryId;

    const replaced = replaceQueueEntry(second.next, {
      entryId: secondId,
      content: 'updated',
      expectedRevision: 1,
    }, context(3));
    expect(value(replaced).entry).toMatchObject({ id: secondId, content: 'updated', revision: 2 });

    const moved = moveQueueEntry(replaced.next, {
      entryId: secondId,
      targetEntryId: firstId,
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 2,
      expectedTargetRevision: 1,
    }, context(4));
    expect(value(moved).rebased).toBe(false);
    expect(moved.next.entries.map((entry) => entry.id)).toEqual([secondId, firstId]);

    const deleted = deleteQueueEntry(moved.next, { entryId: firstId }, context(5));
    expect(value(deleted)).toMatchObject({ entryId: firstId, entry: null });
    expect(deleted.next.entries.map((entry) => entry.id)).toEqual([secondId]);
  });

  it('deduplicates queued submissions and rejects content conflicts', () => {
    const submission = {
      clientMessageId: 'message-1',
      transcriptViewId: 'view-1',
      excludedResendOrdinals: [2, 4],
    };
    const created = add(initial(), 'same', 1, { submission });
    const duplicate = add(created.next, 'same', 2, { submission });
    expect(value(duplicate)).toMatchObject({ entryId: value(created).entryId, duplicate: true });
    expect(duplicate.changed).toBe(false);

    const conflict = add(created.next, 'different', 3, { submission });
    expect(rejection(conflict)).toEqual({
      code: 'IDEMPOTENCY_CONFLICT',
      clientMessageId: 'message-1',
    });
    expect(conflict.next).toEqual(created.next);
  });

  it('removes a dequeued entry immediately and records its former identity', () => {
    const first = add(initial(), 'first', 1);
    const firstId = value(first).entryId;
    const second = add(first.next, 'second', 2);

    const dequeued = dequeueNextQueueEntry(second.next, context(3));
    expect(value(dequeued).entry).toMatchObject({ id: firstId, status: 'queued' });
    expect(dequeued.next.entries.map((entry) => entry.content)).toEqual(['second']);
    expect(dequeued.next.recentlyDispatched).toEqual([
      { entryId: firstId, revision: 1, dispatchedAt: context(3).now },
    ]);
    expect(rejection(deleteQueueEntry(
      dequeued.next,
      { entryId: firstId },
      context(4),
    )).code).toBe('QUEUE_ENTRY_ALREADY_SENT');
  });

  it('treats pause as a dequeue gate and requires the current pause identity', () => {
    const created = add(initial(), 'first', 1);
    const paused = pauseQueue(created.next, context(2));
    expect(paused.next.pause).toMatchObject({ id: 'id-2', kind: 'manual' });
    expect(value(dequeueNextQueueEntry(paused.next, context(3)))).toBeNull();
    expect(rejection(resumeQueue(paused.next, 'stale', context(4))).code).toBe(
      'QUEUE_PAUSE_CHANGED',
    );
    const resumed = resumeQueue(paused.next, 'id-2', context(5));
    expect(resumed.next.pause).toBeNull();
    expect(value(dequeueNextQueueEntry(resumed.next, context(6))).entry.content).toBe('first');
  });

  it('reserves only the queue head for steering and consumes it atomically', () => {
    const first = add(initial(), 'first', 1);
    const firstId = value(first).entryId;
    const second = add(first.next, 'second', 2);
    const secondId = value(second).entryId;

    expect(rejection(reserveQueueSteer(second.next, {
      entryId: secondId,
      expectedRevision: 1,
      expectedReorderRevision: 0,
    }, context(3))).code).toBe('QUEUE_ENTRY_REORDER_CONFLICT');

    const reserved = reserveQueueSteer(second.next, {
      entryId: firstId,
      expectedRevision: 1,
      expectedReorderRevision: 0,
    }, context(4));
    expect(value(reserved).entry.status).toBe('steering');
    expect(value(dequeueNextQueueEntry(reserved.next, context(5)))).toBeNull();

    const released = releaseQueueSteer(reserved.next, firstId, context(6));
    expect(released.next.entries[0].status).toBe('queued');
    const reservedAgain = reserveQueueSteer(released.next, {
      entryId: firstId,
      expectedRevision: 1,
      expectedReorderRevision: 0,
    }, context(7));
    const consumed = consumeQueueSteer(reservedAgain.next, firstId, context(8));
    expect(consumed.next.entries.map((entry) => entry.id)).toEqual([secondId]);
    expect(consumed.next.recentlyDispatched.at(-1)?.entryId).toBe(firstId);
  });

  it('pauses only the remaining tail after a dequeued dispatch fails', () => {
    const only = add(initial(), 'only', 1);
    const onlyId = value(only).entryId;
    const empty = dequeueNextQueueEntry(only.next, context(2));
    const noTail = pauseAfterDispatchFailure(empty.next, onlyId, context(3));
    expect(noTail.changed).toBe(false);
    expect(noTail.next.pause).toBeNull();

    const withTail = add(only.next, 'tail', 2);
    const dequeued = dequeueNextQueueEntry(withTail.next, context(3));
    const failed = pauseAfterDispatchFailure(dequeued.next, onlyId, context(4));
    expect(failed.next.entries.map((entry) => entry.content)).toEqual(['tail']);
    expect(failed.next.pause).toMatchObject({
      kind: 'queued-turn-failed',
      entryId: onlyId,
    });
  });

  it('clears queue entries and pause state together', () => {
    const created = add(initial(), 'first', 1);
    const paused = pauseQueue(created.next, context(2));
    const cleared = clearQueue(paused.next, context(3));
    expect(cleared.next.entries).toEqual([]);
    expect(cleared.next.pause).toBeNull();
  });
});
