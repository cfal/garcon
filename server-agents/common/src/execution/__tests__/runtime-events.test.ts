import { describe, expect, test } from 'bun:test';
import { AgentRuntimeEventChannel } from '../runtime-events.js';

describe('AgentRuntimeEventChannel', () => {
  test('forwards runtime events until unsubscribe', () => {
    const channel = new AgentRuntimeEventChannel();
    const events: unknown[] = [];
    const unsubscribe = channel.subscribe((event) => events.push(event));
    const event = {
      type: 'run-ended' as const,
      chatId: 'chat',
      runId: 'run-1',
      outcome: 'finished' as const,
    };

    channel.emit(event);
    unsubscribe();
    channel.emit({ ...event, runId: 'run-2' });

    expect(events).toEqual([event]);
  });
});
