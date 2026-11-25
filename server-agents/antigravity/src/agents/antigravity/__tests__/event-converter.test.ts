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
  it('publishes agent-to-agent messages as tool calls, not assistant replies', () => {
    const converter = new AntigravityAcpEventConverter();
    expect(converter.fromSessionUpdate(toolCall('send', 'send_message', 'other', {
      Recipient: 'reviewer', Message: 'First line\nSecond line',
    }), context)).toMatchObject([{ type: 'agent-message-tool-use', toolId: 'send', recipient: 'reviewer', message: 'First line\nSecond line' }]);
    expect(converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'send',
      status: 'failed', rawOutput: { output: 'Recipient unavailable' } }), context))
      .toMatchObject([{ type: 'tool-result', toolId: 'send', isError: true, content: { raw: 'Recipient unavailable' } }]);
    const input = { Message: 'Missing destination' };
    expect(converter.fromSessionUpdate(toolCall('bad', 'send_message', 'other', input), context))
      .toMatchObject([{ type: 'external-tool-use', input }]);
  });

  it('converts a checklist snapshot even when the name and arguments arrive separately', () => {
    const converter = new AntigravityAcpEventConverter();
    expect(converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'plan', title: 'Run update_steps', kind: 'other',
    }), context)).toEqual([]);
    const statuses = ['pending', 'in_progress', 'done', 'skipped', 'failed'];
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'plan', status: 'completed',
      rawInput: { steps: statuses.map(status => ({ title: 'Check', status })) },
    }), context);
    expect(plain(rows)).toEqual([
      { type: 'update-plan-tool-use', toolId: 'plan', todos: statuses.map(status => ({
        content: 'Check', status: status === 'done' ? 'completed' : status,
      })) },
      { type: 'tool-result', toolId: 'plan', content: {}, isError: false },
    ]);
  });

  it('does not coerce unsupported plan steps or mistake an MCP title for a native checklist', () => {
    const converter = new AntigravityAcpEventConverter();
    const input = { steps: [{ title: 'Check', status: 'future' }] };
    expect(converter.fromSessionUpdate(toolCall('bad', 'update_steps', 'other', input), context))
      .toMatchObject([{ type: 'external-tool-use', input }]);
    expect(converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call', toolCallId: 'mcp',
      title: 'Run update_steps', _meta: { is_mcp_tool_call: true }, rawInput: { steps: [] } }), context))
      .toMatchObject([{ type: 'unknown-tool-use' }]);
  });

  it.each([
    [{ Action: 'list' }, { action: 'list' }],
    [{ Action: 'kill', TaskId: 'job-1' }, { action: 'stop', taskId: 'job-1' }],
    [{ action: 'status', task_id: 'job-1' }, { action: 'status', taskId: 'job-1' }],
    [{ Action: 'send_input', TaskId: 'job-1', Input: '\n' }, { action: 'send_input', taskId: 'job-1', input: '\n' }],
  ])('normalizes background task input %j', (input, expected) => {
    const converter = new AntigravityAcpEventConverter();
    const rows = converter.fromSessionUpdate(toolCall('call', 'manage_task', 'other', input), context);
    expect(rows).toMatchObject([{ type: 'background-task-tool-use', toolId: 'call', ...expected }]);
  });

  it.each([{ Action: 'kill' }, { Action: 'send_input', TaskId: 'job' }, { Action: 'stop', TaskId: 'job' }, { Action: 'future' }])(
    'keeps unsupported task input %j intact', (input) => {
      const converter = new AntigravityAcpEventConverter();
      expect(converter.fromSessionUpdate(toolCall('call', 'manage_task', 'other', input), context))
        .toMatchObject([{ type: 'external-tool-use', input }]);
    },
  );

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

  it.each([
    [{ _meta: { is_mcp_tool_call: true } }, { title: 'Run update_steps' }],
    [{ title: 'Run update_steps' }, { _meta: { is_mcp_tool_call: true } }],
    [{ kind: 'execute' }, { title: 'Run update_steps' }],
  ])('does not infer a native plan when another frame excludes it', (first, last) => {
    const converter = new AntigravityAcpEventConverter();
    expect(converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call', toolCallId: 'call', ...first }), context)).toEqual([]);
    const rows = converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'call',
      rawInput: { steps: [] }, status: 'completed', ...last }), context);
    expect(rows.map(row => row.type)).toEqual(['unknown-tool-use', 'tool-result']);
    if ('kind' in first) expect(rows[0]).toMatchObject({ rawName: 'execute' });
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

  it('does not lose a command exit failure when a progress frame has a blank name', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.fromSessionUpdate(toolCall('cmd', 'run_command', 'execute', { CommandLine: 'false' }), context);
    converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'cmd', name: '' }), context);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'cmd', status: 'completed', rawOutput: { exit_code: 1 },
    }), context);
    expect(rows).toMatchObject([{ type: 'tool-result', isError: true, content: { exitCode: 1 } }]);
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

  it('preserves a command failure and its diagnostic even when agy completed the invocation', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('command', 'run_command', 'execute', { CommandLine: 'exit 9' }), context);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'command', status: 'completed',
      rawOutput: { exit_code: 9, output: '' },
      content: [{ type: 'content', content: { type: 'text', text: 'Command exited with code 9.' } }],
    }), context);
    expect(plain(rows)).toEqual([{
      type: 'tool-result', toolId: 'command', content: { raw: 'Command exited with code 9.' }, isError: true,
    }]);
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
  });

  it.each([
    { name: 'run_command', exitCode: 9, content: { exitCode: 9 }, isError: true },
    { name: 'run_command', exitCode: 0, content: {}, isError: false },
    { name: 'command_status', exitCode: 9, content: {}, isError: false },
  ])('classifies a silent $name completion with exit code $exitCode', ({ name, exitCode, content, isError }) => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'silent', name, status: 'completed',
      rawOutput: { exit_code: exitCode },
    }), context);
    expect(plain(rows).at(-1)).toEqual({ type: 'tool-result', toolId: 'silent', content, isError });
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
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

    // The runtime takes the failure before the final flush.
    expect(converter.takeTurnFailure(SESSION)).toBe(
      'Antigravity agent executor error: generating and executing: Error 400, Message: API key not valid., Status: INVALID_ARGUMENT',
    );
    expect(converter.endTurn(SESSION, context)).toEqual([]);
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
  });

  it('keeps text that precedes the executor error in the same chunk', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Partial answer.\n⚠ agent executor error: Error 429\n' },
    }), context);

    expect(converter.takeTurnFailure(SESSION)).toBe('Antigravity agent executor error: Error 429');
    expect(plain(converter.endTurn(SESSION, context))).toEqual([{ type: 'assistant-message', content: 'Partial answer.' }]);
  });

  it('publishes a whole agent_message like streamed chunks', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message',
      content: { type: 'text', text: 'Complete answer.' },
    }), context);

    expect(plain(converter.endTurn(SESSION, context))).toEqual([{ type: 'assistant-message', content: 'Complete answer.' }]);
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

  it('keeps an answer whole when thought chunks interleave with it', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = [
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reviewing the merge.' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '**Merged** at `b62' } }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Checking ' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '20dd97`.' } }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'the hash.' } }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Not **deployed**.' } }),
    ].flatMap((row) => converter.fromSessionUpdate(row, context));
    rows.push(...converter.endTurn(SESSION, context));
    // Thinking before the answer is published as the answer starts; thinking
    // within it waits, so the answer stays one row.
    expect(plain(rows)).toEqual([
      { type: 'thinking', content: 'Reviewing the merge.' },
      { type: 'thinking', content: 'Checking the hash.' },
      { type: 'assistant-message', content: '**Merged** at `b6220dd97`. Not **deployed**.' },
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

  it('publishes an executor error that arrives after the turn ended as an error row', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ agent executor error: Error 429\n' },
    }), context);
    expect(plain(converter.endTurn(SESSION, context))).toEqual([{ type: 'error', content: 'Antigravity agent executor error: Error 429' }]);
  });

  it('keeps the failure when only a late update for an earlier call follows it', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'sleep 1' }), context);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ agent executor error: Error 429\n' },
    }), context);
    converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'failed' }), context);
    expect(converter.takeTurnFailure(SESSION)).toBe('Antigravity agent executor error: Error 429');
  });

  it('recognizes a late permission-call update by ID even without a tool name', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.permissionToolUse({ toolCallId: 'plan', title: 'Run update_steps', rawInput: { steps: [] } }, context);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n⚠ agent executor error: Error 429\n' },
    }), context);
    converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'plan', status: 'failed' }), context);
    expect(converter.takeTurnFailure(SESSION)).toBe('Antigravity agent executor error: Error 429');
  });

  it('gives a waiting row the arguments its permission request carried', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: {},
    }), context);
    converter.permissionToolUse({ toolCallId: 'tool-1', kind: 'execute', rawInput: { CommandLine: 'echo permitted' } }, context);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { output: 'permitted' },
    }), context);
    expect(plain(rows)[0]).toEqual({ type: 'bash-tool-use', toolId: 'tool-1', command: 'echo permitted', description: undefined });
  });

  it('releases held marker text ahead of a call whose first frame is an update', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agy prints\n⚠ agent executor error: <detail>' },
    }), context);
    const rows = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-9', name: 'run_command', kind: 'execute',
      status: 'completed', rawInput: { CommandLine: 'echo synthetic' }, rawOutput: { output: 'synthetic' },
    }), context);

    expect(rows.map((message) => message.type)).toEqual(['assistant-message', 'bash-tool-use', 'tool-result']);
    expect(converter.takeTurnFailure(SESSION)).toBeNull();
  });

  it('publishes the result of a call that arrives already settled', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    const rows = converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'echo synthetic' }, {
      status: 'completed', rawOutput: { output: 'synthetic' },
    }), context);

    expect(rows.map((message) => message.type)).toEqual(['bash-tool-use', 'tool-result']);
  });

  it('keeps a message whole across a progress update for an earlier call', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'echo synthetic' }), context);
    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Here is the' } }), context);
    const progress = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress',
    }), context);
    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' result.' } }), context);

    expect(progress).toEqual([]);
    expect(plain(converter.endTurn(SESSION, context))).toEqual([{ type: 'assistant-message', content: 'Here is the result.' }]);
  });

  it('keeps text that arrived before a call settles ahead of its result', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'echo synthetic' }), context);
    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking.' } }), context);
    const settled = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { output: 'synthetic' },
    }), context);

    expect(settled.map((message) => message.type)).toEqual(['assistant-message', 'tool-result']);
  });

  it('flushes text before a call whose row waits for arguments', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before.' } }), context);
    const bare = converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', name: 'run_command', kind: 'execute', status: 'pending', rawInput: {},
    }), context);
    expect(plain(bare)).toEqual([{ type: 'assistant-message', content: 'Before.' }]);
  });

  it('publishes a waiting row when the turn ends before its arguments arrive', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'execute', status: 'pending', rawInput: {},
    }), context);
    converter.permissionToolUse({ toolCallId: 'tool-1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'echo stopped' } }, context);

    expect(plain(converter.endTurn(SESSION, context))).toEqual([
      { type: 'bash-tool-use', toolId: 'tool-1', command: 'echo stopped', description: undefined },
    ]);
    expect(converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress', rawInput: { CommandLine: 'echo stopped' },
    }), context)).toEqual([]);
  });

  it('publishes a waiting row before output that follows it', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'first', name: 'run_command', kind: 'execute', status: 'pending', rawInput: {},
    }), context);
    const rows = converter.fromSessionUpdate(toolCall('second', 'read_file', 'read', { Path: '/work/a' }), context);
    expect(plain(rows).map((row) => row.toolId)).toEqual(['first', 'second']);
  });

  it('shows a permission request the arguments an earlier frame carried', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'rm -rf build' }), context);
    expect(converter.permissionToolUse({ toolCallId: 'tool-1' }, context))
      .toMatchObject({ type: 'bash-tool-use', command: 'rm -rf build' });
  });

  it('settles a cancelled call with an error result', () => {
    const converter = new AntigravityAcpEventConverter();
    converter.beginTurn(SESSION);
    converter.fromSessionUpdate(toolCall('tool-1', 'run_command', 'execute', { CommandLine: 'sleep 9' }), context);
    const rows = converter.fromSessionUpdate(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'cancelled' }), context);
    expect(plain(rows)).toEqual([{ type: 'tool-result', toolId: 'tool-1', content: { status: 'cancelled' }, isError: true }]);
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
