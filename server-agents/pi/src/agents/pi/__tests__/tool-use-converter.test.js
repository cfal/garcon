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

  it('keeps truncated MCP names canonical without inventing a server identity', () => {
    const tool = `mcp__${'s'.repeat(50)}_01234567`;
    expect(tool).toHaveLength(64);
    expect(convertPiToolUse(ts, 'truncated', tool, { query: 'issues' })).toMatchObject({
      type: 'mcp-tool-use', server: '', tool, input: { query: 'issues' },
    });
  });

  it('normalizes codemode, tool discovery, PowerShell, and MCP tools on the server', () => {
    expect(convertPiToolUse(ts, 'code', 'codemode', { code: 'return 1;' })).toMatchObject({
      type: 'exec-tool-use', code: 'return 1;', language: 'javascript',
    });
    expect(convertPiToolUse(ts, 'shell', 'powershell', { command: 'Get-Location' })).toMatchObject({
      type: 'exec-tool-use', code: 'Get-Location', language: 'powershell',
    });
    expect(convertPiToolUse(ts, 'search', 'tool_search', { query: 'issues', limit: 3 })).toMatchObject({
      type: 'pi-tool-search-tool-use', query: 'issues', limit: 3,
    });
    expect(convertPiToolUse(ts, 'mcp', 'mcp__tracker__list_issues', { label: 'bug' })).toMatchObject({
      type: 'mcp-tool-use', server: 'tracker', tool: 'list_issues', input: { label: 'bug' },
    });
    for (const tool of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect(convertPiToolUse(ts, tool, tool, { server: 'docs', uri: 'resource://intro' })).toMatchObject({
        type: 'mcp-tool-use', server: 'docs', tool, input: { server: 'docs', uri: 'resource://intro' },
      });
    }
    expect(convertPiToolUse(ts, 'all', 'list_mcp_resources', {})).toMatchObject({
      type: 'mcp-tool-use', server: '', tool: 'list_mcp_resources',
    });
  });
});
