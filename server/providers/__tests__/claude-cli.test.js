import { describe, it, expect } from 'bun:test';
import { convertCLIMessageToChatMessages } from '../claude-cli.js';

describe('convertCLIMessageToChatMessages', () => {
  it('returns empty array for non-assistant messages', () => {
    expect(convertCLIMessageToChatMessages({ type: 'system', content: [] })).toEqual([]);
  });

  it('converts text to assistant-message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant-message');
    expect(result[0].content).toBe('Hello world');
  });

  it('converts thinking to thinking message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'thinking', thinking: 'Internal reasoning' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('thinking');
    expect(result[0].content).toBe('Internal reasoning');
  });

  it('converts tool_use to tool-use message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/foo' } }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('Read');
    expect(result[0].toolId).toBe('tool-1');
  });

  it('converts tool_result to tool-result message', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-result');
    expect(result[0].toolId).toBe('tool-1');
    expect(result[0].isError).toBe(false);
  });

  it('converts all content types from a single assistant message', () => {
    const msg = {
      type: 'assistant',
      content: [
        { type: 'text', text: 'Some response text' },
        { type: 'thinking', thinking: 'Internal reasoning' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: '/tmp/foo' } },
      ],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(3);
    expect(result[0].type).toBe('assistant-message');
    expect(result[1].type).toBe('thinking');
    expect(result[2].type).toBe('tool-use');
  });

  it('reads content from message.content wrapper shape', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
      },
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('Bash');
  });

  it('skips empty or whitespace-only text parts', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'text', text: '   ' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(0);
  });

  it('passes EnterPlanMode as a regular tool-use', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'p1', name: 'EnterPlanMode', input: {} }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('EnterPlanMode');
    expect(result[0].toolId).toBe('p1');
  });

  it('passes ExitPlanMode as a regular tool-use with typed fields', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'p2', name: 'exit_plan_mode', input: { plan: 'Do X', allowedPrompts: [] } }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('exit_plan_mode');
    expect(result[0].plan).toBe('Do X');
  });

  it('falls back to UnknownToolUseMessage for non-object tool input', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'p2', name: 'exit_plan_mode', input: 'not-a-map' }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('exit_plan_mode');
    expect(result[0].plan).toBeUndefined();
  });

  it('preserves typed Edit fields from complex input', () => {
    const msg = {
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'nested-1',
        name: 'Edit',
        input: {
          file_path: '/tmp/foo.js',
          old_string: 'const a = 1;',
          new_string: 'const a = 2;',
          nested: { deep: { value: [1, 2, 3] } },
        },
      }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result[0].filePath).toBe('/tmp/foo.js');
    expect(result[0].oldString).toBe('const a = 1;');
    expect(result[0].newString).toBe('const a = 2;');
  });

  it('falls back to UnknownToolUseMessage for null tool input on Read', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'n1', name: 'Read', input: null }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('Read');
    expect(result[0].filePath).toBeUndefined();
  });

  it('falls back to UnknownToolUseMessage for array tool input on Read', () => {
    const msg = {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: [1, 2, 3] }],
    };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('Read');
    expect(result[0].filePath).toBeUndefined();
  });

  it('returns empty array when content is empty', () => {
    const msg = { type: 'assistant', content: [] };
    const result = convertCLIMessageToChatMessages(msg);
    expect(result).toHaveLength(0);
  });
});
