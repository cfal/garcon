import { afterEach, describe, expect, it, mock } from 'bun:test';
import { AgentEventBus } from '../event-bus.js';

const originalWarn = console.warn;
const originalLogLevel = process.env.GARCON_LOG_LEVEL;

afterEach(() => {
  console.warn = originalWarn;
  if (originalLogLevel === undefined) {
    delete process.env.GARCON_LOG_LEVEL;
  } else {
    process.env.GARCON_LOG_LEVEL = originalLogLevel;
  }
});

describe('AgentEventBus', () => {
  it('warns when turn metadata is overwritten before a terminal event', () => {
    process.env.GARCON_LOG_LEVEL = 'warn';
    console.warn = mock(() => undefined);
    const bus = new AgentEventBus({ list: () => [] });

    bus.trackTurn('chat-1', { clientRequestId: 'req-1' });
    bus.trackTurn('chat-1', { clientRequestId: 'req-2' });

    expect(console.warn).toHaveBeenCalledWith(
      '[agents:event-bus]',
      'agents: overwriting in-flight turn metadata for chat',
      'chat-1',
    );
  });
});
