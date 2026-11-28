import { expect, test } from 'bun:test';
import { projectProcessing } from './chat-processing.js';

const fixture = {
  running: ['runtime-chat', 'shared-chat', '\u{10000}', '\ue000'],
  reserved: ['reserved-chat', 'shared-chat'],
  stopping: ['shared-chat', 'idle-chat'],
  reconnecting: ['runtime-chat', 'shared-chat', 'idle-chat'],
};

test('projects processing separately from ownership and preserves UTF-16 snapshot order', () => {
  for (const [chatId, phase] of [
    ['runtime-chat', 'reconnecting'],
    ['shared-chat', 'stopping'],
    ['reserved-chat', 'running'],
    ['idle-chat', null],
  ] as const) {
    const result = projectProcessing(fixture, chatId);
    expect(result.phase).toBe(phase);
    expect(result.snapshot.map((entry) => entry.chatId)).toEqual([
      'reserved-chat', 'runtime-chat', 'shared-chat', '\u{10000}', '\ue000',
    ]);
  }
});

test('an active stop takes precedence for a reservation even before a run starts', () => {
  expect(projectProcessing({
    running: [], reserved: ['first'], stopping: ['first'], reconnecting: ['first'],
  }, 'first')).toEqual({ phase: 'stopping', snapshot: [{ chatId: 'first', phase: 'stopping' }] });
});
