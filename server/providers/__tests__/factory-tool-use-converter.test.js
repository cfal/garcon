import { describe, expect, it } from 'bun:test';

import { convertFactoryToolUse } from '../converters/factory-tool-use.js';

describe('convertFactoryToolUse', () => {
  const ts = '2026-03-29T00:00:00.000Z';

  it('maps LS to ListToolUseMessage', () => {
    const message = convertFactoryToolUse(ts, {
      id: 'tool-1',
      toolName: 'LS',
      parameters: { path: '/tmp' },
    });

    expect(message.type).toBe('list-tool-use');
    expect(message.path).toBe('/tmp');
  });

  it('maps Execute to BashToolUseMessage', () => {
    const message = convertFactoryToolUse(ts, {
      id: 'tool-2',
      toolName: 'Execute',
      parameters: { command: 'bun run test' },
    });

    expect(message.type).toBe('bash-tool-use');
    expect(message.command).toBe('bun run test');
  });

  it('maps TodoWrite string payloads into canonical todos', () => {
    const message = convertFactoryToolUse(ts, {
      id: 'tool-3',
      toolName: 'TodoWrite',
      parameters: {
        todos: '1. [completed] Review provider adapter\n2. [pending] Run tests',
      },
    });

    expect(message.type).toBe('todo-write-tool-use');
    expect(message.todos).toEqual([
      { content: 'Review provider adapter', status: 'completed' },
      { content: 'Run tests', status: 'pending' },
    ]);
  });

  it('falls back to UnknownToolUseMessage for unsupported tools', () => {
    const message = convertFactoryToolUse(ts, {
      id: 'tool-4',
      toolName: 'UnknownTool',
      parameters: { key: 'value' },
    });

    expect(message.type).toBe('unknown-tool-use');
    expect(message.rawName).toBe('UnknownTool');
    expect(message.input).toEqual({ key: 'value' });
  });
});
