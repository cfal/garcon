import { describe, expect, it, mock } from 'bun:test';
import { ChatProcessingActivity } from '../chat-processing-activity.ts';

function makeActivity({
  runningIds = [],
  reservedIds = [],
  stoppingIds = [],
} = {}) {
  const running = new Set(runningIds);
  const reserved = new Set(reservedIds);
  const stopping = new Set(stoppingIds);
  return new ChatProcessingActivity(
    {
      isChatRunning: mock((chatId) => running.has(chatId)),
      getRunningChatIdsSnapshot: mock(() => [...running]),
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
      { chatId: 'chat-a', phase: 'running' },
      { chatId: 'chat-shared', phase: 'stopping' },
      { chatId: 'chat-z', phase: 'running' },
    ]);
  });
});
