import { describe, expect, test } from 'bun:test';
import { AssistantMessage, UserMessage } from '@garcon/common/chat-types';
import { normalizeNativeChildEvent, NATIVE_CHILD_EVENT_BYTES } from '../../index.js';

describe('native child notification validation', () => {
  test('reconstructs message instances and retains valid siblings around malformed rows', () => {
    const events = normalizeNativeChildEvent({ type: 'native-child-rows', childKey: 'child', rows: [
      { message: { type: 'user-message', timestamp: 'now', content: 'Task' } },
      { message: { type: 'unknown', timestamp: 'now' } },
      { message: { type: 'assistant-message', timestamp: 'now', content: 'Result' } },
    ] });
    expect(events).toHaveLength(2);
    const content = events[0]!;
    if (content.type !== 'native-child-rows') throw new Error('Expected rows');
    expect(content.rows[0]!.message).toBeInstanceOf(UserMessage);
    expect(content.rows[1]!.message).toBeInstanceOf(AssistantMessage);
    expect(events[1]).toEqual({ type: 'native-child-gap', childKey: 'child' });
  });

  test('splits batches and drops a single oversized row with one gap', () => {
    const events = normalizeNativeChildEvent({ type: 'native-child-rows', childKey: 'child', rows: [
      { message: new AssistantMessage('now', 'a'.repeat(600_000)) },
      { message: new AssistantMessage('now', 'b'.repeat(600_000)) },
      { message: new AssistantMessage('now', 'c'.repeat(NATIVE_CHILD_EVENT_BYTES)) },
    ] });
    expect(events.map(event => event.type)).toEqual(['native-child-rows', 'native-child-rows', 'native-child-gap']);
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(NATIVE_CHILD_EVENT_BYTES);
  });

  test('unknown child shapes become observation gaps rather than parent failures', () => {
    for (const event of [
      { type: 'native-child-created', child: {} },
      { type: 'native-child-detached', childKey: '' },
      { type: 'native-child-capture-ended', reason: 'unknown' },
      { type: 'native-child-unrecognized' },
    ]) expect(normalizeNativeChildEvent(event)).toEqual([{ type: 'native-child-gap', childKey: null }]);
  });
});
