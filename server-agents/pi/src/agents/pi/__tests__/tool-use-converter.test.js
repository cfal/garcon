import { describe, expect, it } from 'bun:test';

import { convertPiToolUse } from '../tool-use-converter.js';

describe('convertPiToolUse', () => {
  const ts = '2026-01-01T00:00:00.000Z';

  it('maps Pi built-in tools to canonical tool-use messages', () => {
    expect(convertPiToolUse(ts, 'tool-1', 'bash', { command: 'bun run test' })).toMatchObject({
      type: 'bash-tool-use',
      toolId: 'tool-1',
      command: 'bun run test',
    });
    expect(convertPiToolUse(ts, 'tool-2', 'read', { path: 'server/main.js', offset: '2', limit: 10 })).toMatchObject({
      type: 'read-tool-use',
      toolId: 'tool-2',
      filePath: 'server/main.js',
      offset: 2,
      limit: 10,
    });
    expect(convertPiToolUse(ts, 'tool-3', 'ls', { path: 'server' })).toMatchObject({
      type: 'list-tool-use',
      toolId: 'tool-3',
      path: 'server',
    });
    expect(convertPiToolUse(ts, 'tool-4', 'write', { path: 'out.txt', content: 'hello' })).toMatchObject({
      type: 'write-tool-use',
      toolId: 'tool-4',
      filePath: 'out.txt',
      content: 'hello',
    });
    expect(convertPiToolUse(ts, 'tool-5', 'edit', {
      path: 'src/file.ts',
      edits: [{ oldText: 'before', newText: 'after' }],
    })).toMatchObject({
      type: 'edit-tool-use',
      toolId: 'tool-5',
      filePath: 'src/file.ts',
      oldString: 'before',
      newString: 'after',
    });
    expect(convertPiToolUse(ts, 'tool-6', 'grep', { pattern: 'TODO', path: 'src' })).toMatchObject({
      type: 'grep-tool-use',
      toolId: 'tool-6',
      pattern: 'TODO',
      path: 'src',
    });
    expect(convertPiToolUse(ts, 'tool-7', 'find', { pattern: '**/*.ts', path: 'src' })).toMatchObject({
      type: 'glob-tool-use',
      toolId: 'tool-7',
      pattern: '**/*.ts',
      path: 'src',
    });
  });

  it('accepts Pi edit payloads whose edits are serialized JSON', () => {
    const message = convertPiToolUse(ts, 'tool-8', 'edit', {
      path: 'src/file.ts',
      edits: JSON.stringify([{ oldText: 'one', newText: 'two' }]),
    });

    expect(message).toMatchObject({
      type: 'edit-tool-use',
      filePath: 'src/file.ts',
      oldString: 'one',
      newString: 'two',
    });
  });

  it('keeps custom tools as unknown tool-use messages', () => {
    const message = convertPiToolUse(ts, 'tool-9', 'customTool', { answer: 42 });

    expect(message).toMatchObject({
      type: 'unknown-tool-use',
      toolId: 'tool-9',
      rawName: 'customTool',
      input: { answer: 42 },
    });
  });
});
