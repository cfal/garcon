import { describe, expect, it } from 'bun:test';

import { getAmpPreview, loadAmpChatMessages } from '../loaders/amp-history-loader.js';

const THREAD_EXPORT_FIXTURE = {
  id: 'T-123',
  created: 1773796295774,
  title: 'Amp Thread',
  messages: [
    {
      role: 'user',
      messageId: 0,
      content: [
        { type: 'text', text: 'first prompt' },
      ],
      meta: { sentAt: 1773796295804 },
    },
    {
      role: 'assistant',
      messageId: 1,
      content: [
        { type: 'thinking', thinking: 'thinking text', provider: 'anthropic' },
        { type: 'text', text: 'assistant reply' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/example.ts' }, complete: true },
      ],
      usage: { timestamp: '2026-03-18T01:11:57.391Z' },
      state: { type: 'complete', stopReason: 'tool_use' },
    },
    {
      role: 'user',
      messageId: 2,
      content: [
        {
          type: 'tool_result',
          toolUseID: 'tool-1',
          run: {
            status: 'done',
            result: {
              absolutePath: '/tmp/example.ts',
              content: 'const value = 1;',
            },
          },
        },
      ],
    },
    {
      role: 'assistant',
      messageId: 3,
      content: [
        { type: 'text', text: 'final assistant message' },
      ],
      usage: { timestamp: '2026-03-18T01:12:00.000Z' },
      state: { type: 'complete', stopReason: 'end_turn' },
    },
  ],
};

describe('amp history loader', () => {
  it('normalizes Amp export messages into chat messages', () => {
    const messages = loadAmpChatMessages(THREAD_EXPORT_FIXTURE);

    expect(messages).toHaveLength(6);
    expect(messages[0].type).toBe('user-message');
    expect(messages[0].content).toBe('first prompt');
    expect(messages[1].type).toBe('thinking');
    expect(messages[1].content).toBe('thinking text');
    expect(messages[2].type).toBe('assistant-message');
    expect(messages[2].content).toBe('assistant reply');
    expect(messages[3].type).toBe('read-tool-use');
    expect(messages[3].filePath).toBe('/tmp/example.ts');
    expect(messages[4].type).toBe('tool-result');
    expect(messages[4].toolId).toBe('tool-1');
    expect(messages[4].content).toEqual({
      absolutePath: '/tmp/example.ts',
      content: 'const value = 1;',
    });
    expect(messages[5].type).toBe('assistant-message');
    expect(messages[5].content).toBe('final assistant message');
  });

  it('builds preview metadata from the export payload', () => {
    expect(getAmpPreview(THREAD_EXPORT_FIXTURE)).toEqual({
      firstMessage: 'first prompt',
      lastMessage: 'final assistant message',
      lastActivity: '2026-03-18T01:12:00.000Z',
      createdAt: new Date(1773796295774).toISOString(),
    });
  });
});
