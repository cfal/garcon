import { describe, expect, it } from 'bun:test';
import {
  AntigravityAcpEventConverter,
  splitExecutorError,
} from '../antigravity-acp-event-converter.ts';

const SESSION = 'session-1';
const context = { chatId: 'chat-1', sessionId: SESSION, timestamp: '2026-01-01T00:00:00.000Z' };

function update(payload: Record<string, unknown>) {
  return { sessionId: SESSION, update: payload };
}

function toolCall(id: string, name: string, kind: string, rawInput: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return update({ sessionUpdate: 'tool_call', toolCallId: id, name, args: rawInput, status: 'in_progress', kind, title: name, rawInput, ...extra });
}

function plain(messages: readonly object[]) {
  return messages.map((message) => {
    const { timestamp: _timestamp, ...rest } = message as Record<string, unknown>;
    return rest;
  });
}

describe('AntigravityAcpEventConverter', () => {
  it('buffers text and thinking until a tool call or the end of the turn', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);

    expect(converter.fromSessionUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Consider' } }), context)).toEqual([]);
    expect(converter.fromSessionUpdate(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ing.' } }), context)).toEqual([]);
    // Message text after thinking publishes the thinking first.
    expect(plain(converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running ' } }), context)))
      .toEqual([{ type: 'thinking', content: 'Considering.' }]);
    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'it.' } }), context);

    const atTool = converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', {
      CommandLine: 'echo synthetic',
      toolSummary: 'Echo text',
      WaitMsBeforeAsync: 5000,
    }), context);
    expect(plain(atTool)).toEqual([
      { type: 'assistant-message', content: 'Running it.' },
      { type: 'bash-tool-use', toolId: 'tool-1', command: 'echo synthetic', description: 'Echo text' },
    ]);

    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }), context);
    expect(plain(converter.endTurn(SESSION, context))).toEqual([
      { type: 'assistant-message', content: 'Done.' },
    ]);
  });

  it('emits a tool row once and normalizes command output', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const input = { CommandLine: 'echo synthetic', WaitMsBeforeAsync: 5000 };
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', input), context);

    expect(converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', name: 'run_command', status: 'pending', rawInput: input,
    }), context)).toEqual([]);
    const output = 'Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:01Z\nCommand exited with code 0.\n\nCommand output:\nsynthetic\n';
    const completed = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      name: 'run_command',
      status: 'completed',
      kind: 'execute',
      rawInput: input,
      rawOutput: { output, exit_code: 0 },
      content: [{ type: 'content', content: { type: 'text', text: output } }],
    }), context);

    expect(plain(completed)).toEqual([{
      type: 'tool-result',
      toolId: 'tool-1',
      content: { raw: 'Command exited with code 0.\n\nCommand output:\nsynthetic\n' },
      isError: false,
    }]);
  });

  it('maps native file, search, and subagent tools to shared tool types', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = [
      toolCall('read', 'read_file', 'read', { Path: '/work/notes.txt', StartLine: 3, EndLine: 9 }),
      toolCall('write', 'write_file', 'edit', { Path: '/work/new.txt', Content: 'hello\n' }),
      toolCall('edit', 'edit_file', 'edit', { Path: '/work/notes.txt', Target: 'alpha', Replacement: 'beta' }),
      toolCall('search', 'search_web', 'search', { query: 'synthetic query' }),
      toolCall('task', 'invoke_subagent', 'other', { Role: 'reviewer', Prompt: 'Review it.', Model: 'gemini-test' }),
      toolCall('mcp', 'mcp_docs_lookup', 'other', { server: 'docs', tool: 'lookup', arguments: { term: 'x' } }),
      toolCall('ask', 'ask_question', 'other', { questions: [{ question: 'Pick one?', options: ['A', 'B'] }] }),
      toolCall('future', 'future_tool', 'other', { value: 1 }),
    ].flatMap((row) => converter.fromSessionUpdate(row, context));

    expect(plain(rows)).toEqual([
      { type: 'read-tool-use', toolId: 'read', filePath: '/work/notes.txt', offset: 3, limit: undefined, endLine: 9 },
      { type: 'write-tool-use', toolId: 'write', filePath: '/work/new.txt', content: 'hello\n' },
      { type: 'edit-tool-use', toolId: 'edit', filePath: '/work/notes.txt', oldString: 'alpha', newString: 'beta', changes: undefined },
      { type: 'web-search-tool-use', toolId: 'search', query: 'synthetic query' },
      { type: 'task-tool-use', toolId: 'task', subagentType: 'reviewer', description: 'reviewer', prompt: 'Review it.', model: 'gemini-test', resume: undefined },
      { type: 'mcp-tool-use', toolId: 'mcp', server: 'docs', tool: 'lookup', input: { term: 'x' } },
      {
        type: 'external-tool-use',
        toolId: 'ask',
        name: 'ask_question',
        input: { questions: [{ question: 'Pick one?', options: ['A', 'B'] }] },
        namespace: 'antigravity',
      },
      { type: 'external-tool-use', toolId: 'future', name: 'future_tool', input: { value: 1 }, namespace: 'antigravity' },
    ]);
  });

  it('maps alternate file, search, and fetch tools from other agy agents', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = [
      toolCall('view', 'view_file', 'read', { AbsolutePath: '/work/a.ts', StartLine: 2 }),
      toolCall('write', 'write_to_file', 'edit', { TargetFile: '/work/b.ts', CodeContent: 'b\n' }),
      toolCall('replace', 'replace_file_content', 'edit', { TargetFile: '/work/a.ts', TargetContent: 'x', ReplacementContent: 'y' }),
      toolCall('multi', 'multi_replace_file_content', 'edit', {
        TargetFile: '/work/a.ts', ReplacementChunks: [{ TargetContent: 'p', ReplacementContent: 'q' }],
      }),
      toolCall('grep', 'grep_search', 'search', { Query: 'needle', SearchPath: '/work' }),
      toolCall('glob', 'find_by_name', 'search', { Pattern: '*.ts', SearchDirectory: '/work' }),
      toolCall('list', 'list_dir', 'read', { DirectoryPath: '/work' }),
      toolCall('fetch', 'read_url_content', 'fetch', { Url: 'https://example.com' }),
    ].flatMap((row) => converter.fromSessionUpdate(row, context));

    expect(plain(rows)).toEqual([
      { type: 'read-tool-use', toolId: 'view', filePath: '/work/a.ts', offset: 2, limit: undefined, endLine: undefined },
      { type: 'write-tool-use', toolId: 'write', filePath: '/work/b.ts', content: 'b\n' },
      { type: 'edit-tool-use', toolId: 'replace', filePath: '/work/a.ts', oldString: 'x', newString: 'y', changes: undefined },
      { type: 'edit-tool-use', toolId: 'multi', filePath: '/work/a.ts', oldString: 'p', newString: 'q', changes: undefined },
      { type: 'grep-tool-use', toolId: 'grep', pattern: 'needle', path: '/work' },
      { type: 'glob-tool-use', toolId: 'glob', pattern: '*.ts', path: '/work' },
      { type: 'list-tool-use', toolId: 'list', path: '/work' },
      { type: 'web-fetch-tool-use', toolId: 'fetch', url: 'https://example.com', prompt: undefined },
    ]);
  });

  it('reports a call without a tool name as unknown, keyed by its kind', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'anon', status: 'in_progress', kind: 'other', rawInput: { value: 1 },
    }), context);
    expect(plain(rows)).toEqual([{ type: 'unknown-tool-use', toolId: 'anon', rawName: 'other', input: { value: 1 } }]);
  });

  it('keeps the original tool name when a terminal update omits it', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'echo x' }), context);
    const output = 'Created At: 2026-01-01T00:00:00Z\nCompleted At: 2026-01-01T00:00:01Z\nCommand output:\nx\n';
    const completed = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', kind: 'execute', rawOutput: { output },
    }), context);
    expect(plain(completed)).toEqual([
      { type: 'tool-result', toolId: 'tool-1', content: { raw: 'Command output:\nx\n' }, isError: false },
    ]);
  });

  it('reports failed tools as errors', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const input = { CommandLine: 'echo denied' };
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', input), context);

    const failed = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      name: 'run_command',
      status: 'failed',
      rawInput: input,
      rawOutput: { output: '' },
      content: [{ type: 'content', content: { type: 'text', text: '' } }],
    }), context);
    expect(plain(failed)).toEqual([
      { type: 'tool-result', toolId: 'tool-1', content: { status: 'failed' }, isError: true },
    ]);
  });

  it('emits the tool row first when a terminal update is the first frame for a call', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      name: 'read_file',
      status: 'completed',
      rawInput: { Path: '/work/notes.txt' },
    }), context);
    expect(plain(rows).map((row) => row.type)).toEqual(['read-tool-use', 'tool-result']);
  });

  it('turns the in-band executor error into a turn failure instead of assistant text', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\n⚠ agent executor error: generating and executing: Error 400, Message: API key not valid., Status: INVALID_ARGUMENT\n' },
    }), context);

    expect(converter.endTurn(SESSION, context)).toEqual([]);
    expect(converter.takeTurnFailure(SESSION)).toBe(
      'Antigravity agent executor error: generating and executing: Error 400, Message: API key not valid., Status: INVALID_ARGUMENT',
    );
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
  });

  it('keeps text that precedes the executor error in the same chunk', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Partial answer.\n⚠ agent executor error: Error 429\n' },
    }), context);

    expect(plain(converter.endTurn(SESSION, context))).toEqual([{ type: 'assistant-message', content: 'Partial answer.' }]);
    expect(converter.takeTurnFailure(SESSION)).toBe('Antigravity agent executor error: Error 429');
  });

  it('does not duplicate a tool row when a stopped turn reports late', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'sleep 5' }), context);
    converter.beginTurn(SESSION);

    const late = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', name: 'run_command', status: 'failed', rawOutput: { output: '' },
    }), context);
    expect(plain(late).map((row) => row.type)).toEqual(['tool-result']);
  });

  it('combines every region of a multi-region edit', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = converter.fromSessionUpdate(toolCall('multi', 'multi_replace_file_content', 'edit', {
      TargetFile: '/work/a.ts',
      ReplacementChunks: [
        { TargetContent: 'one', ReplacementContent: 'uno' },
        { TargetContent: 'two', ReplacementContent: 'dos' },
      ],
    }), context);
    expect(plain(rows)).toEqual([{
      type: 'edit-tool-use', toolId: 'multi', filePath: '/work/a.ts', oldString: 'one\n\ntwo', newString: 'uno\n\ndos', changes: undefined,
    }]);
  });

  it('waits for arguments before choosing a tool type', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    expect(converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: {},
    }), context)).toEqual([]);

    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress', kind: 'execute', rawInput: { CommandLine: 'echo late' },
    }), context);
    expect(plain(rows)).toEqual([{ type: 'bash-tool-use', toolId: 'tool-1', command: 'echo late', description: undefined }]);
  });

  it('ignores the marker when the model quotes it mid-reply', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'agy prints\n⚠ agent executor error: <detail>\nwhen a request fails.' },
    }), context);
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
  });

  it('does not recreate state for a session released before its final flush', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.releaseSession(SESSION);
    expect(converter.endTurn(SESSION, context)).toEqual([]);
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
  });

  it('keeps interleaved message and thought text in order', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = [
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'T' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } }),
    ].flatMap((row) => converter.fromSessionUpdate(row, context));
    rows.push(...converter.endTurn(SESSION, context));
    expect(plain(rows)).toEqual([
      { type: 'assistant-message', content: 'A' },
      { type: 'thinking', content: 'T' },
      { type: 'assistant-message', content: 'B' },
    ]);
  });

  it('publishes one result when a terminal update repeats', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'read_file', 'read', { Path: '/work/a' }), context);
    const terminal = update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', name: 'read_file', status: 'completed' });
    expect(plain(converter.fromSessionUpdate(terminal, context)).map((row) => row.type)).toEqual(['tool-result']);
    expect(converter.fromSessionUpdate(terminal, context)).toEqual([]);
  });

  it('recognizes a multi-line executor error that opens its chunk', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '\n⚠ agent executor error: Error 429\nDetails: quota\n' },
    }), context);
    expect(converter.takeTurnFailure(SESSION)).toBe('Antigravity agent executor error: Error 429\nDetails: quota');
    expect(converter.endTurn(SESSION, context)).toEqual([]);
  });

  it('treats a marker chunk followed by more output as ordinary text', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    for (const text of ['agy prints', '\n⚠ agent executor error: <detail>\n', 'when a request fails.']) {
      converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }), context);
    }
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
    expect(plain(converter.endTurn(SESSION, context))).toEqual([{
      type: 'assistant-message', content: 'agy prints\n⚠ agent executor error: <detail>\nwhen a request fails.',
    }]);
  });

  it('names a permission request from an earlier frame of the same call', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: {},
    }), context);
    const requested = converter.permissionToolUse({ toolCallId: 'tool-1', kind: 'execute', rawInput: { CommandLine: 'echo named' } }, context);
    expect(requested).toMatchObject({ type: 'bash-tool-use', command: 'echo named' });
  });

  it('reads snake_case multi-region edits from older agy builds', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = converter.fromSessionUpdate(toolCall('multi', 'multi_replace_file_content', 'edit', {
      target_file: '/work/a.ts', replacement_chunks: [{ target_content: 'old', replacement_content: 'new' }],
    }), context);
    expect(plain(rows)).toEqual([{
      type: 'edit-tool-use', toolId: 'multi', filePath: '/work/a.ts', oldString: 'old', newString: 'new', changes: undefined,
    }]);
  });

  it('drops state for released sessions', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Pending.' } }), context);
    converter.releaseSession(SESSION);
    expect(converter.endTurn(SESSION, context)).toEqual([]);
  });
});

describe('splitExecutorError', () => {
  it('matches only the complete marker chunk', () => {
    expect(splitExecutorError('agent executor error: quoted by the model').failure).toBeNull();
    expect(splitExecutorError('Note: ⚠ agent executor error: not at a line start').failure).toBeNull();
    expect(splitExecutorError('\n⚠ agent executor error: Error 429\n').failure).toBe('Antigravity agent executor error: Error 429');
  });
});
