import { describe, expect, it } from 'bun:test';

import { convertPiMessage } from '../pi/message-converter.js';

describe('convertPiMessage', () => {
  it('converts user text and images', () => {
    const messages = convertPiMessage({
      role: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'user-message',
      timestamp: '2026-01-01T00:00:00.000Z',
      content: 'inspect this',
      images: [{ name: 'image-1', data: 'data:image/png;base64,aW1hZ2U=' }],
    });
  });

  it('converts assistant thinking, text, and tool calls in order', () => {
    const messages = convertPiMessage({
      role: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      content: [
        { type: 'thinking', thinking: 'checking files' },
        { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } },
        { type: 'text', text: 'done' },
      ],
    });

    expect(messages.map((message) => message.type)).toEqual([
      'thinking',
      'bash-tool-use',
      'assistant-message',
    ]);
    expect(messages[0].content).toBe('checking files');
    expect(messages[1].command).toBe('pwd');
    expect(messages[2].content).toBe('done');
  });

  it('converts persisted tool results', () => {
    const messages = convertPiMessage({
      role: 'toolResult',
      timestamp: '2026-01-01T00:00:02.000Z',
      toolCallId: 'tool-1',
      content: { stdout: 'ok' },
      isError: false,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'tool-result',
      toolId: 'tool-1',
      content: { stdout: 'ok' },
      isError: false,
    });
  });

  it('can suppress live user and tool-result echoes', () => {
    expect(convertPiMessage({ role: 'user', content: 'hello' }, { includeUser: false })).toEqual([]);
    expect(convertPiMessage({
      role: 'toolResult',
      toolCallId: 'tool-1',
      content: 'ok',
    }, { includeToolResults: false })).toEqual([]);

    const assistant = convertPiMessage({
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tool-2', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: 'finished' },
      ],
    }, { includeToolCalls: false });

    expect(assistant.map((message) => message.type)).toEqual(['assistant-message']);
    expect(assistant[0].content).toBe('finished');
  });
});
