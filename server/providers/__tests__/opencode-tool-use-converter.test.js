import { describe, it, expect } from 'bun:test';
import { convertOpenCodeToolUse } from '../converters/opencode-tool-use.js';
import {
  BashToolUseMessage,
  ReadToolUseMessage,
  EditToolUseMessage,
  WriteToolUseMessage,
  TodoWriteToolUseMessage,
  EnterPlanModeToolUseMessage,
  ExitPlanModeToolUseMessage,
  UnknownToolUseMessage,
} from '../../../common/chat-types.js';

const TS = '2026-03-01T00:00:00.000Z';

describe('convertOpenCodeToolUse', () => {
  it('maps Bash with command from state.input', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Bash',
      callID: 'oc-1',
      state: { input: { command: 'ls -la' } },
    });
    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('ls -la');
    expect(msg.toolId).toBe('oc-1');
  });

  it('maps Read with file_path', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Read',
      callID: 'oc-2',
      state: { input: { file_path: '/tmp/test.ts', offset: 10 } },
    });
    expect(msg).toBeInstanceOf(ReadToolUseMessage);
    expect(msg.filePath).toBe('/tmp/test.ts');
    expect(msg.offset).toBe(10);
  });

  it('maps Edit with diff fields', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Edit',
      callID: 'oc-3',
      state: { input: { file_path: '/f.ts', old_string: 'a', new_string: 'b' } },
    });
    expect(msg).toBeInstanceOf(EditToolUseMessage);
    expect(msg.filePath).toBe('/f.ts');
  });

  it('maps Write with file_path', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Write',
      callID: 'oc-4',
      state: { input: { file_path: '/out.ts', content: 'data' } },
    });
    expect(msg).toBeInstanceOf(WriteToolUseMessage);
    expect(msg.filePath).toBe('/out.ts');
  });

  it('maps TodoWrite with todos', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'TodoWrite',
      callID: 'oc-5',
      state: { input: { todos: [{ content: 'task' }] } },
    });
    expect(msg).toBeInstanceOf(TodoWriteToolUseMessage);
  });

  it('maps EnterPlanMode', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'EnterPlanMode',
      callID: 'oc-6',
      state: { input: {} },
    });
    expect(msg).toBeInstanceOf(EnterPlanModeToolUseMessage);
  });

  it('maps ExitPlanMode with plan', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'ExitPlanMode',
      callID: 'oc-7',
      state: { input: { plan: 'Do X', allowedPrompts: [] } },
    });
    expect(msg).toBeInstanceOf(ExitPlanModeToolUseMessage);
    expect(msg.plan).toBe('Do X');
  });

  it('falls back to Unknown for unrecognized tools', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'CustomTool',
      callID: 'oc-8',
      state: { input: { key: 'val' } },
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('CustomTool');
  });

  it('uses fallback id from part.id when callID is missing', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Bash',
      id: 'fallback-id',
      state: { input: { command: 'ls' } },
    });
    expect(msg.toolId).toBe('fallback-id');
  });

  it('handles null part gracefully', () => {
    const msg = convertOpenCodeToolUse(TS, null);
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
  });

  it('handles missing state.input', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'Bash',
      callID: 'oc-9',
      state: {},
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('Bash');
  });

  it('preserves non-object state.input as { raw: value }', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'CustomTool',
      callID: 'oc-10',
      state: { input: 'some string payload' },
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.input).toEqual({ raw: 'some string payload' });
  });

  it('parses JSON-string state.input that resolves to object', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: 'CustomTool',
      callID: 'oc-11',
      state: { input: '{"key":"val"}' },
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.input).toEqual({ key: 'val' });
  });

  it('handles non-string tool name without throwing', () => {
    const msg = convertOpenCodeToolUse(TS, {
      tool: { bad: true },
      callID: 'oc-12',
      state: { input: {} },
    });
    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('Unknown');
  });
});
