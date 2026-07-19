import { describe, expect, test } from 'bun:test';
import { AgentExecutionEventChannel } from '../event-channel.js';

describe('AgentExecutionEventChannel', () => {
  test('forwards canonical events until unsubscribe', () => {
    const channel = new AgentExecutionEventChannel();
    const events: unknown[] = [];
    const unsubscribe = channel.subscribe((event) => events.push(event));
    const event = {
      type: 'processing' as const,
      chatId: 'chat',
      processing: true,
      operation: {
        commandType: 'agent-run' as const,
        clientRequestId: null,
        clientMessageId: null,
        turnId: 'turn',
      },
    };
    channel.emit(event);
    unsubscribe();
    channel.emit({ ...event, processing: false });
    expect(events).toEqual([event]);
  });
});
