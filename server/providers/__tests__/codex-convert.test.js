import { describe, it, expect } from 'bun:test';
import { convertCodexEventToChatMessages } from '../codex.js';

describe('convertCodexEventToChatMessages', () => {
  it('returns empty array for null input', () => {
    expect(convertCodexEventToChatMessages(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(convertCodexEventToChatMessages(undefined)).toEqual([]);
  });

  it('returns empty array for non-item events', () => {
    expect(convertCodexEventToChatMessages({ type: 'status' })).toEqual([]);
  });

  it('converts agent_message to assistant-message', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'agent_message',
      message: { role: 'assistant', content: 'Hello world' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant-message');
    expect(result[0].content).toBe('Hello world');
  });

  it('skips agent_message with whitespace-only content', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'agent_message',
      message: { role: 'assistant', content: '   ' },
    });
    expect(result).toHaveLength(0);
  });

  it('converts reasoning to thinking message', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'reasoning',
      message: { content: 'Internal thought' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('thinking');
    expect(result[0].content).toBe('Internal thought');
  });

  it('converts command_execution to Bash tool-use and tool-result', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'command_execution',
      command: 'ls -la',
      output: 'file1\nfile2',
      exitCode: 0,
    });
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('Bash');
    expect(result[0].command).toBe('ls -la');
    expect(result[1].type).toBe('tool-result');
    expect(result[1].toolId).toBe(result[0].toolId);
    expect(result[1].isError).toBe(false);
  });

  it('marks command_execution with non-zero exit code as error', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'command_execution',
      command: 'false',
      output: '',
      exitCode: 1,
    });
    expect(result[1].isError).toBe(true);
  });

  it('converts file_change with completed status', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'file_change',
      changes: [{ path: '/tmp/x.js', kind: 'update' }],
      status: 'completed',
    });
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('tool-use');
    expect(result[0].rawName).toBe('Edit');
    expect(result[0].changes).toEqual([{ path: '/tmp/x.js', kind: 'update' }]);
    expect(result[1].type).toBe('tool-result');
    expect(result[1].content).toEqual({ raw: 'File changes applied' });
  });

  it('ignores unknown item types', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'unknown_item_type',
    });
    expect(result).toHaveLength(0);
  });

  it('converts web_search to WebSearch tool-use and tool-result', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'web_search',
      query: 'React performance tips',
    });
    expect(result).toHaveLength(2);
    expect(result[0].rawName).toBe('WebSearch');
    expect(result[0].query).toBe('React performance tips');
    expect(result[1].content.raw).toContain('React performance tips');
  });

  it('converts todo_list to TodoWrite tool-use and tool-result', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'todo_list',
      items: [{ text: 'task 1', done: false }],
    });
    expect(result).toHaveLength(2);
    expect(result[0].rawName).toBe('TodoWrite');
    expect(result[0].todos).toEqual([{ text: 'task 1', done: false }]);
  });

  it('converts error to error message', () => {
    const result = convertCodexEventToChatMessages({
      type: 'item',
      itemType: 'error',
      message: { content: 'something went wrong' },
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    expect(result[0].content).toBe('something went wrong');
  });
});
