import { describe, expect, it, mock } from 'bun:test';
import { ChatProcessingActivity } from '../chat-processing-activity.ts';

function makeActivity({
  runningIds = [],
  reservedIds = [],
  stoppingIds = [],
  retryById = {},
} = {}) {
  const running = new Set(runningIds);
  const reserved = new Set(reservedIds);
  const stopping = new Set(stoppingIds);
  return new ChatProcessingActivity(
    {
      isChatRunning: mock((chatId) => running.has(chatId)),
      getRunningChatIdsSnapshot: mock(() => [...running]),
      turnRetryStatus: mock((chatId) => retryById[chatId] ?? null),
    },
    {
      isChatTurnReserved: mock((chatId) => reserved.has(chatId)),
      getTurnReservedChatIds: mock(() => [...reserved]),
      isChatStopInFlight: mock((chatId) => stopping.has(chatId)),
    },
  );
}

describe('ChatProcessingActivity', () => {
  it('projects provider runtimes and turn reservations as running', () => {
    const activity = makeActivity({
      runningIds: ['runtime-chat'],
      reservedIds: ['reserved-chat'],
    });

    expect(activity.phase('runtime-chat')).toBe('running');
    expect(activity.phase('reserved-chat')).toBe('running');
    expect(activity.phase('idle-chat')).toBeNull();
  });

  it('projects an active Stop latch as stopping', () => {
    const activity = makeActivity({
      runningIds: ['runtime-chat'],
      reservedIds: ['reserved-chat'],
      stoppingIds: ['runtime-chat', 'reserved-chat', 'idle-chat'],
    });

    expect(activity.phase('runtime-chat')).toBe('stopping');
    expect(activity.phase('reserved-chat')).toBe('stopping');
    expect(activity.phase('idle-chat')).toBeNull();
  });

  it('returns one sorted phase entry per active chat', () => {
    const activity = makeActivity({
      runningIds: ['chat-z', 'chat-shared'],
      reservedIds: ['chat-a', 'chat-shared'],
      stoppingIds: ['chat-shared'],
    });

    expect(activity.snapshot()).toEqual([
      { chatId: 'chat-a', phase: 'running', retry: null },
      { chatId: 'chat-shared', phase: 'stopping', retry: null },
      { chatId: 'chat-z', phase: 'running', retry: null },
    ]);
  });

  it('exposes retry detail only while the chat projects a phase', () => {
    const retry = { attempt: 2, message: 'Provider is overloaded', nextAttemptAt: null };
    const activity = makeActivity({
      runningIds: ['running-chat'],
      retryById: { 'running-chat': retry, 'idle-chat': retry },
    });

    expect(activity.retry('running-chat')).toEqual(retry);
    expect(activity.retry('idle-chat')).toBeNull();
    expect(activity.snapshot()).toEqual([
      { chatId: 'running-chat', phase: 'running', retry },
    ]);
  });
});
