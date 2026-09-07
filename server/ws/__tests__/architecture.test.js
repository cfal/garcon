import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

describe('chat WebSocket architecture', () => {
  it('uses bounded replay pages without the temporary slow-replay watchdog', () => {
    const source = readFileSync('server/ws/chat.ts', 'utf8');

    expect(source).not.toContain('SLOW_REPLAY_WARNING_MS');
    expect(source).not.toContain('#watchSlowReplay');
    expect(source).not.toContain('chat-subscribe replay is still pending');
  });
});
