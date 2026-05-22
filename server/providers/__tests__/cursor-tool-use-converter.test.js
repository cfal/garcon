import { describe, expect, it } from 'bun:test';

import { convertCursorToolUse } from '../converters/cursor-tool-use.js';

describe('convertCursorToolUse', () => {
  const ts = '2026-05-22T00:00:00.000Z';

  it('maps wrapped live shell calls to BashToolUseMessage', () => {
    const message = convertCursorToolUse(ts, {
      type: 'tool_call',
      tool_call: {
        shellToolCall: {
          call_id: 'tool-1',
          args: { command: 'bun run test', description: 'Run tests' },
        },
      },
    });

    expect(message.type).toBe('bash-tool-use');
    expect(message.toolId).toBe('tool-1');
    expect(message.command).toBe('bun run test');
    expect(message.description).toBe('Run tests');
  });

  it('maps persisted ApplyPatch calls with string args to canonical patch messages', () => {
    const message = convertCursorToolUse(ts, {
      type: 'tool-call',
      toolName: 'ApplyPatch',
      toolCallId: 'patch-1',
      args: JSON.stringify({
        path: 'src/app.ts',
        patch: '*** Begin Patch\n*** Update File: src/app.ts\n+const value = 1;\n*** End Patch',
      }),
    });

    expect(message.type).toBe('apply-patch-tool-use');
    expect(message.filePath).toBe('src/app.ts');
    expect(message.patch).toContain('*** Begin Patch');
  });

  it('maps Cursor Glob glob_pattern args to canonical pattern', () => {
    const message = convertCursorToolUse(ts, {
      type: 'tool-call',
      toolName: 'Glob',
      toolCallId: 'glob-1',
      args: { glob_pattern: 'contracts/**/daml.yaml' },
    });

    expect(message.type).toBe('glob-tool-use');
    expect(message.toolId).toBe('glob-1');
    expect(message.pattern).toBe('contracts/**/daml.yaml');
  });

  it('maps Cursor Read path args to canonical filePath', () => {
    const message = convertCursorToolUse(ts, {
      type: 'tool-call',
      toolName: 'Read',
      toolCallId: 'read-1',
      args: { path: '/repo/contracts/ccip/core/daml.yaml' },
    });

    expect(message.type).toBe('read-tool-use');
    expect(message.toolId).toBe('read-1');
    expect(message.filePath).toBe('/repo/contracts/ccip/core/daml.yaml');
  });

  it('normalizes Cursor todo items into canonical todos', () => {
    const message = convertCursorToolUse(ts, {
      id: 'todo-1',
      name: 'TodoWrite',
      input: {
        items: [
          { text: 'Inspect Cursor integration', completed: true },
          { step: 'Run validation', status: 'in_progress' },
        ],
      },
    });

    expect(message.type).toBe('todo-write-tool-use');
    expect(message.todos).toEqual([
      { content: 'Inspect Cursor integration', status: 'completed' },
      { content: 'Run validation', status: 'in_progress' },
    ]);
  });

  it('falls back to UnknownToolUseMessage only for unsupported tools', () => {
    const message = convertCursorToolUse(ts, {
      id: 'tool-unknown',
      name: 'CursorInternalThing',
      input: '{"flag":true}',
    });

    expect(message.type).toBe('unknown-tool-use');
    expect(message.rawName).toBe('CursorInternalThing');
    expect(message.input).toEqual({ flag: true });
  });
});
