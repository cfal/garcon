import { describe, expect, it } from 'bun:test';
import {
  clearQueue,
  createQueueEntry,
  deleteQueueEntry,
  moveQueueEntry,
  pauseQueue,
  popNextQueueEntry,
  removeSentQueueEntry,
  replaceQueueEntry,
  requeueAndPause,
  restoreStoppedQueueEntry,
  resumeQueue,
  returnUnsentQueueEntry,
} from '../chat-execution-control-transitions.ts';
import {
  MAX_STORED_APPLIED_QUEUE_COMMANDS,
  emptyStoredChatExecutionControl,
} from '../control-state.ts';

function context(start = 0, protectedKeys = new Set()) {
  let nextId = start;
  return {
    now: `2026-07-19T00:00:${String(start).padStart(2, '0')}.000Z`,
    newId: () => `id-${++nextId}`,
    unsettledQueueReceiptKeys: () => protectedKeys,
  };
}

function value(result) {
  expect(result.outcome.status).toBe('ok');
  return result.outcome.value;
}

function storedEntry(id, status = 'queued', revision = 1) {
  return {
    id,
    content: id,
    revision,
    status,
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}

describe('chat execution control transitions', () => {
  it('creates, replaces, dispatches, returns, and removes one entry without mutating inputs', () => {
    const initial = emptyStoredChatExecutionControl();
    const created = createQueueEntry(initial, { content: 'first' }, context());
    expect(initial).toEqual(emptyStoredChatExecutionControl());
    expect(created.next).toMatchObject({ version: 1, entries: [{ content: 'first', revision: 1 }] });

    const entryId = value(created).entryId;
    const replaced = replaceQueueEntry(created.next, {
      entryId,
      content: 'updated',
      expectedRevision: 1,
    }, context(1));
    expect(replaced.next.entries[0]).toMatchObject({ id: entryId, content: 'updated', revision: 2 });

    const popped = popNextQueueEntry(replaced.next, context(2));
    expect(value(popped).entry).toMatchObject({ id: entryId, status: 'sending' });
    expect(popped.next.entries[0].delivery).toEqual({
      clientRequestId: 'id-3',
      clientMessageId: 'id-4',
      turnId: 'id-5',
    });

    const returned = returnUnsentQueueEntry(popped.next, entryId, context(3));
    expect(returned.next.entries[0].status).toBe('queued');
    expect(returned.next.entries[0].delivery).toEqual(popped.next.entries[0].delivery);
    expect(returned.next.recentlyDispatched).toEqual([]);

    const sentAgain = popNextQueueEntry(returned.next, context(4));
    const removed = removeSentQueueEntry(sentAgain.next, entryId, context(5));
    expect(removed.next.entries).toEqual([]);
    expect(removed.next.version).toBe(6);
  });

  it('returns typed mutation rejections with the input state unchanged', () => {
    const created = createQueueEntry(
      emptyStoredChatExecutionControl(),
      { content: 'first' },
      context(),
    );
    const entryId = value(created).entryId;
    const stale = replaceQueueEntry(created.next, {
      entryId,
      content: 'updated',
      expectedRevision: 2,
    }, context(1));
    expect(stale).toMatchObject({
      changed: false,
      outcome: {
        status: 'rejected',
        rejection: { code: 'QUEUE_ENTRY_REVISION_CONFLICT', actualRevision: 1 },
      },
    });
    expect(stale.next).toEqual(created.next);

    const missing = deleteQueueEntry(created.next, { entryId: 'missing' }, context(1));
    expect(missing.outcome).toEqual({
      status: 'rejected',
      rejection: { code: 'QUEUE_ENTRY_NOT_FOUND', entryId: 'missing' },
    });
  });

  it('retains unresolved receipts while enforcing the receipt bound', () => {
    const current = emptyStoredChatExecutionControl();
    current.appliedCommands = Array.from(
      { length: MAX_STORED_APPLIED_QUEUE_COMMANDS + 3 },
      (_, index) => ({
        key: `old-${index}`,
        operation: 'create',
        entryId: `entry-${index}`,
        appliedAt: `2026-07-18T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
      }),
    );
    const protectedKeys = new Set(['old-0', 'old-1', 'old-2']);
    const transition = createQueueEntry(current, {
      content: 'new',
      command: { key: 'current', entryId: 'current-entry' },
    }, context(0, protectedKeys));

    const keys = new Set(transition.next.appliedCommands.map((receipt) => receipt.key));
    expect(keys).toContain('current');
    expect(keys).toContain('old-0');
    expect(keys).toContain('old-1');
    expect(keys).toContain('old-2');
    expect(transition.next.appliedCommands.length).toBe(MAX_STORED_APPLIED_QUEUE_COMMANDS);
  });

  it('replays queue command receipts without applying a mutation twice', () => {
    const command = { key: 'queue:create:request', entryId: 'entry-1' };
    const first = createQueueEntry(
      emptyStoredChatExecutionControl(),
      { content: 'first', command },
      context(0, new Set([command.key])),
    );
    const duplicate = createQueueEntry(
      first.next,
      { content: 'first', command },
      context(1, new Set([command.key])),
    );
    expect(value(duplicate)).toMatchObject({ entryId: 'entry-1', duplicate: true });
    expect(duplicate.changed).toBe(false);
    expect(duplicate.next).toEqual(first.next);
  });

  it('moves entries by stable target identity without changing entry revisions', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries = [
      storedEntry('a', 'queued', 2),
      storedEntry('b'),
      storedEntry('c', 'queued', 3),
    ];
    const moved = moveQueueEntry(current, {
      entryId: 'c',
      targetEntryId: 'a',
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 3,
      expectedTargetRevision: 2,
      command: { key: 'move-c', entryId: 'c' },
    }, context());

    expect(value(moved)).toMatchObject({ entryId: 'c', duplicate: false, rebased: false });
    expect(moved.next.entries.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
    expect(moved.next.entries.map((entry) => entry.revision)).toEqual([3, 2, 1]);
    expect(moved.next.reorderRevision).toBe(1);
    expect(moved.next.version).toBe(1);
    expect(current.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('records no-op moves and rejects stale reorder revisions', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries = [storedEntry('a'), storedEntry('b'), storedEntry('c')];
    const noOp = moveQueueEntry(current, {
      entryId: 'b',
      targetEntryId: 'a',
      placement: 'after',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
      command: { key: 'move-b', entryId: 'b' },
    }, context());
    expect(noOp.next.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(noOp.next.reorderRevision).toBe(0);
    expect(noOp.next.version).toBe(1);

    const duplicate = moveQueueEntry(noOp.next, {
      entryId: 'b',
      targetEntryId: 'a',
      placement: 'after',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
      command: { key: 'move-b', entryId: 'b' },
    }, context(1));
    expect(value(duplicate)).toMatchObject({ duplicate: true, rebased: null });
    expect(duplicate.changed).toBe(false);
    expect(duplicate.next).toEqual(noOp.next);

    const stale = moveQueueEntry(noOp.next, {
      entryId: 'c',
      targetEntryId: 'a',
      placement: 'before',
      expectedReorderRevision: 1,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
    }, context(2));
    expect(stale.outcome).toEqual({
      status: 'rejected',
      rejection: { code: 'QUEUE_ENTRY_REORDER_CONFLICT' },
    });
    expect(stale.next).toEqual(noOp.next);
  });

  it('rebases past a dispatching target while preserving its retry priority', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries = [
      storedEntry('target', 'sending'),
      storedEntry('a'),
      storedEntry('source'),
      storedEntry('b'),
    ];
    current.recentlyDispatched = [{
      entryId: 'target',
      revision: 1,
      dispatchedAt: '2026-07-19T00:00:00.000Z',
    }];
    const moved = moveQueueEntry(current, {
      entryId: 'source',
      targetEntryId: 'target',
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
      command: { key: 'move-source', entryId: 'source' },
    }, context());

    expect(value(moved).rebased).toBe(true);
    expect(moved.next.entries.map((entry) => entry.id)).toEqual(['target', 'source', 'a', 'b']);
    const failed = requeueAndPause(moved.next, {
      entryId: 'target',
      kind: 'queued-turn-failed',
    }, context(1));
    expect(failed.next.entries.map((entry) => entry.id)).toEqual(['target', 'source', 'a', 'b']);
    expect(failed.next.pause).toMatchObject({ kind: 'queued-turn-failed', entryId: 'target' });
    const resumed = resumeQueue(failed.next, failed.next.pause.id, context(2));
    expect(value(popNextQueueEntry(resumed.next, context(3))).entry.id).toBe('target');
  });

  it('rebases past a completed target only when its dispatched revision still matches', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries = [storedEntry('a'), storedEntry('source'), storedEntry('b')];
    current.recentlyDispatched = [{
      entryId: 'target',
      revision: 2,
      dispatchedAt: '2026-07-19T00:00:00.000Z',
    }];
    const moved = moveQueueEntry(current, {
      entryId: 'source',
      targetEntryId: 'target',
      placement: 'after',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 2,
    }, context());

    expect(value(moved).rebased).toBe(true);
    expect(moved.next.entries.map((entry) => entry.id)).toEqual(['source', 'a', 'b']);

    const changedTarget = moveQueueEntry(current, {
      entryId: 'source',
      targetEntryId: 'target',
      placement: 'after',
      expectedReorderRevision: 0,
      expectedSourceRevision: 1,
      expectedTargetRevision: 1,
    }, context());
    expect(changedTarget.outcome).toEqual({
      status: 'rejected',
      rejection: {
        code: 'QUEUE_ENTRY_REVISION_CONFLICT',
        entryId: 'target',
        actualRevision: 2,
      },
    });
    expect(changedTarget.next).toEqual(current);
  });

  it('rejects moved entries or targets whose content changed', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries = [storedEntry('a', 'queued', 2), storedEntry('b', 'queued', 3)];
    const sourceConflict = moveQueueEntry(current, {
      entryId: 'b',
      targetEntryId: 'a',
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 2,
      expectedTargetRevision: 2,
    }, context());
    expect(sourceConflict.outcome).toMatchObject({
      status: 'rejected',
      rejection: { code: 'QUEUE_ENTRY_REVISION_CONFLICT', entryId: 'b', actualRevision: 3 },
    });

    const targetConflict = moveQueueEntry(current, {
      entryId: 'b',
      targetEntryId: 'a',
      placement: 'before',
      expectedReorderRevision: 0,
      expectedSourceRevision: 3,
      expectedTargetRevision: 1,
    }, context());
    expect(targetConflict.outcome).toMatchObject({
      status: 'rejected',
      rejection: { code: 'QUEUE_ENTRY_REVISION_CONFLICT', entryId: 'a', actualRevision: 2 },
    });
  });

  it('restores pause stacks and rejects stale pause identities', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries.push({
      id: 'entry-1',
      content: 'queued',
      revision: 1,
      status: 'queued',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    current.pause = { id: 'automatic', kind: 'queued-turn-failed', pausedAt: null };
    current.resumePauses = [{ id: 'manual', kind: 'manual', pausedAt: null }];

    const stale = resumeQueue(current, 'stale', context());
    expect(stale.outcome).toEqual({ status: 'rejected', rejection: { code: 'QUEUE_PAUSE_CHANGED' } });
    const resumed = resumeQueue(current, 'automatic', context());
    expect(resumed.next.pause?.id).toBe('manual');
    expect(resumed.next.resumePauses).toBeUndefined();
  });

  it('applies stage-specific queue compensation without changing delivery identity', () => {
    const current = emptyStoredChatExecutionControl();
    current.entries.push({
      id: 'entry-1',
      content: 'queued',
      revision: 1,
      status: 'sending',
      delivery: { clientRequestId: 'request', clientMessageId: 'message', turnId: 'turn' },
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
    current.recentlyDispatched.push({
      entryId: 'entry-1',
      revision: 1,
      dispatchedAt: '2026-07-19T00:00:00.000Z',
    });

    const uncertain = requeueAndPause(current, {
      entryId: 'entry-1',
      kind: 'completion-uncertain',
    }, context());
    expect(uncertain.next.entries[0]).toMatchObject({
      status: 'queued',
      delivery: current.entries[0].delivery,
    });
    expect(uncertain.next.pause?.kind).toBe('completion-uncertain');

    const stopped = restoreStoppedQueueEntry(current, 'entry-1', context());
    expect(stopped.next.pause?.kind).toBe('manual');
    const cleared = clearQueue(uncertain.next, context(2));
    expect(cleared.next.entries).toEqual([]);
    expect(cleared.next.pause).toBeNull();
  });

  it('stages only the queue head with the supplied active delivery identity', () => {
    const initial = emptyStoredChatExecutionControl();
    const first = createQueueEntry(initial, {
      content: 'first',
      command: { key: 'first-command', entryId: 'first-entry' },
    }, context());
    const second = createQueueEntry(first.next, {
      content: 'second',
      command: { key: 'second-command', entryId: 'second-entry' },
    }, context(1));
    const delivery = {
      clientRequestId: 'active-request',
      clientMessageId: 'active-message',
      turnId: 'active-turn',
    };

    const skipped = popNextQueueEntry(second.next, context(2), {
      entryId: 'second-entry',
      delivery,
    });
    expect(value(skipped)).toBeNull();
    expect(skipped.changed).toBe(false);

    const staged = popNextQueueEntry(second.next, context(3), {
      entryId: 'first-entry',
      delivery,
    });
    expect(value(staged).entry).toMatchObject({
      id: 'first-entry',
      status: 'sending',
      delivery,
    });
    const blocked = popNextQueueEntry(staged.next, context(4));
    expect(value(blocked)).toBeNull();
    expect(blocked.changed).toBe(false);
  });

  it('preserves invariants through a deterministic transition sequence', () => {
    let seed = 0x5eed1234;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    let control = emptyStoredChatExecutionControl();
    let ordinal = 0;
    const knownIds = [];

    for (let index = 0; index < 500; index += 1) {
      const ctx = {
        now: new Date(Date.UTC(2026, 6, 19, 0, 0, index)).toISOString(),
        newId: () => `generated-${++ordinal}`,
        unsettledQueueReceiptKeys: () => new Set(),
      };
      const operation = random() % 8;
      let transition;
      if (operation <= 1 || knownIds.length === 0) {
        transition = createQueueEntry(control, { content: `message-${index}` }, ctx);
        if (transition.outcome.status === 'ok') knownIds.push(transition.outcome.value.entryId);
      } else if (operation === 2) {
        transition = pauseQueue(control, ctx);
      } else if (operation === 3 && control.pause) {
        transition = resumeQueue(control, control.pause.id, ctx);
      } else if (operation === 4) {
        transition = popNextQueueEntry(control, ctx);
      } else if (operation === 5) {
        const sending = control.entries.find((entry) => entry.status === 'sending');
        transition = sending
          ? returnUnsentQueueEntry(control, sending.id, ctx)
          : pauseQueue(control, ctx);
      } else if (operation === 6) {
        const queued = control.entries.find((entry) => entry.status === 'queued');
        transition = queued
          ? deleteQueueEntry(control, { entryId: queued.id }, ctx)
          : pauseQueue(control, ctx);
      } else {
        const sending = control.entries.find((entry) => entry.status === 'sending');
        transition = sending
          ? removeSentQueueEntry(control, sending.id, ctx)
          : pauseQueue(control, ctx);
      }

      const priorVersion = control.version;
      control = transition.next;
      const ids = control.entries.map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(control.entries.filter((entry) => entry.status === 'sending').length).toBeLessThanOrEqual(1);
      expect(control.version).toBe(priorVersion + (transition.changed ? 1 : 0));
      for (const entry of control.entries) {
        if (!entry.delivery) continue;
        expect(entry.delivery.clientRequestId).toBeTruthy();
        expect(entry.delivery.clientMessageId).toBeTruthy();
        expect(entry.delivery.turnId).toBeTruthy();
      }
    }
  });
});
