import { expect, test } from 'bun:test';
import { AntigravityAcpEventConverter } from '../antigravity-acp-event-converter.ts';

function session() {
  const converter = new AntigravityAcpEventConverter();
  const context = { chatId: 'chat', sessionId: 'session', timestamp: 'now' };
  function frame(update: Record<string, unknown>) {
    return converter.fromSessionUpdate({ update }, context);
  }
  return {
    frame,
    start: (id: string, data: Record<string, unknown>) => frame({ toolCallId: id, sessionUpdate: 'tool_call', ...data }),
    patch: (id: string, data: Record<string, unknown>) => frame({ toolCallId: id, sessionUpdate: 'tool_call_update', ...data }),
    permission: (id: string, data = {}) => converter.permissionToolUse({ toolCallId: id, ...data }, context),
    end: () => converter.endTurn(context.sessionId, context),
  };
}

test('uses late identity and partial arguments without duplicating either tool row', () => {
  const s = session();
  expect(s.start('task', { rawInput: { Action: 'status', TaskId: 'job' } })).toEqual([]);
  expect(s.patch('task', { name: 'manage_task', status: 'completed' })).toMatchObject([
    { type: 'background-task-tool-use', action: 'status', taskId: 'job' }, { type: 'tool-result' },
  ]);
  expect(s.start('send', { name: 'send_message', rawInput: { Recipient: 'peer' } })).toEqual([]);
  expect(s.patch('send', { rawInput: { Message: 'Hello' }, status: 'completed' })).toMatchObject([
    { type: 'agent-message-tool-use', recipient: 'peer', message: 'Hello' }, { type: 'tool-result' },
  ]);
});

test('does not let interleaved prose overtake an incomplete checklist or discard its late arguments', () => {
  const s = session();
  expect(s.start('plan', { title: 'Run update_steps' })).toEqual([]);
  expect(s.frame({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Thinking' } })).toEqual([]);
  expect(s.frame({ sessionUpdate: 'agent_message_chunk', content: { text: 'Answer' } })).toEqual([]);
  expect(s.patch('plan', { rawInput: { steps: [] }, status: 'completed' })).toMatchObject([
    { type: 'update-plan-tool-use', todos: [] }, { type: 'thinking', content: 'Thinking' },
    { type: 'assistant-message', content: 'Answer' }, { type: 'tool-result' },
  ]);
  expect(s.start('clear', { name: 'update_steps', rawInput: { steps: [] } })).toMatchObject([{ type: 'update-plan-tool-use', todos: [] }]);
});

test('prefers explicit MCP metadata or envelopes over native names and provisional titles', () => {
  const s = session();
  expect(s.start('named', { name: 'update_steps', rawInput: { steps: [] }, _meta: { is_mcp_tool_call: true } })).toEqual([]);
  expect(s.end()).toMatchObject([{ type: 'external-tool-use', name: 'update_steps', input: { steps: [] } }]);
  expect(s.start('envelope', { title: 'Run update_steps', rawInput: { server: 'docs', tool: 'lookup', steps: [] } }))
    .toMatchObject([{ type: 'mcp-tool-use', server: 'docs', tool: 'lookup' }]);
  expect(s.start('title', { title: 'Run update_steps', rawInput: { steps: [] } })).toEqual([]);
  expect(s.patch('title', { status: 'completed', _meta: { is_mcp_tool_call: true } }))
    .toMatchObject([{ type: 'unknown-tool-use' }, { type: 'tool-result' }]);
});

test('keeps reported structured and progress output without manufacturing a successful result body', () => {
  const s = session();
  const list = { name: 'manage_task', rawInput: { Action: 'list' } };
  const rawOutput = { tasks: [{ id: 'job' }] };
  expect(s.start('list', { ...list, rawOutput, status: 'completed' }).at(-1)).toMatchObject({ content: { rawOutput }, isError: false });
  s.start('progress', list);
  s.patch('progress', { content: [{ type: 'content', content: { type: 'text', text: 'Diagnostic' } }] });
  expect(s.patch('progress', { status: 'failed' })).toMatchObject([{ content: { raw: 'Diagnostic' }, isError: true }]);
  s.start('replace', { ...list, rawOutput: 'Old' });
  expect(s.patch('replace', { status: 'completed', rawOutput: 'Final' })).toMatchObject([{ content: { raw: 'Final' } }]);
  s.start('clear', { ...list, rawOutput: 'Old' });
  expect(s.patch('clear', { status: 'completed', content: [] })[0]).toEqual(expect.objectContaining({ content: { raw: 'Old' }, isError: false }));
  expect(s.start('empty', { ...list, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({ content: {}, isError: false }));
  s.start('cmd', { name: 'run_command', rawInput: { CommandLine: 'false' } });
  s.patch('cmd', { rawOutput: { exit_code: 1 } });
  expect(s.patch('cmd', { status: 'completed' })).toMatchObject([{ content: { exitCode: 1 }, isError: true }]);
});

test('merges rawOutput and content as independent ACP fields and treats null rawOutput as unchanged', () => {
  const s = session();
  const list = { name: 'manage_task', rawInput: { Action: 'list' } };
  const rawOutput = { tasks: ['one'] };
  s.start('task', { ...list, rawOutput, content: [{ type: 'content', content: { type: 'text', text: 'Earlier' } }] });
  expect(s.patch('task', { status: 'completed', rawOutput: null, content: [] })[0])
    .toEqual(expect.objectContaining({ content: { rawOutput }, isError: false }));
  s.start('text', { ...list, rawOutput: 'Previous', content: [{ type: 'content', content: { type: 'text', text: 'Diagnostic' } }] });
  expect(s.patch('text', { status: 'failed', rawOutput: {} })[0])
    .toEqual(expect.objectContaining({ content: { raw: 'Diagnostic' }, isError: true }));
});

test('retains adjacent incomplete calls and their intervening prose until an actual row must publish', () => {
  const s = session();
  expect(s.start('send', { name: 'send_message', rawInput: { Recipient: 'peer' } })).toEqual([]);
  expect(s.frame({ sessionUpdate: 'agent_message_chunk', content: { text: 'Between calls' } })).toEqual([]);
  expect(s.start('plan', { name: 'update_steps' })).toEqual([]);
  expect(s.patch('send', { rawInput: { Message: 'Hello' } })).toMatchObject([{ type: 'agent-message-tool-use', message: 'Hello' }]);
  expect(s.patch('plan', { rawInput: { steps: [] }, status: 'completed' })).toMatchObject([
    { type: 'assistant-message', content: 'Between calls' }, { type: 'update-plan-tool-use' }, { type: 'tool-result', toolId: 'plan' },
  ]);
});

test('waits for the second half of an MCP envelope even after seeing its marker', () => {
  const s = session();
  s.start('mcp', { title: 'Run update_steps' });
  expect(s.patch('mcp', { _meta: { is_mcp_tool_call: true }, rawInput: { server: 'docs' } })).toEqual([]);
  expect(s.patch('mcp', { rawInput: { tool: 'lookup' }, status: 'completed' }))
    .toMatchObject([{ type: 'mcp-tool-use', server: 'docs', tool: 'lookup' }, { type: 'tool-result' }]);
});

test('does not present an inferred checklist as the identity of a permission request', () => {
  const s = session();
  s.start('preview', { title: 'Run update_steps', rawInput: { steps: [] } });
  expect(s.permission('preview')).toMatchObject({ type: 'unknown-tool-use', input: { steps: [] } });
  expect(s.patch('preview', { _meta: { is_mcp_tool_call: true }, rawInput: { server: 'docs', tool: 'lookup' }, status: 'completed' }))
    .toMatchObject([{ type: 'mcp-tool-use', server: 'docs', tool: 'lookup' }, { type: 'tool-result' }]);
  s.start('plan', { title: 'Run update_steps', rawInput: { steps: [] } });
  s.permission('plan');
  expect(s.end()).toMatchObject([{ type: 'update-plan-tool-use', todos: [] }]);
});

test('keeps the terminal diagnostic visible even when another output field reported progress', () => {
  const s = session();
  const blocks = (text: string) => [{ type: 'content', content: { type: 'text', text } }];
  const send = { name: 'send_message', rawInput: { Recipient: 'peer', Message: 'Hello' } };
  const progress = { output: 'In progress' };
  s.start('send', { ...send, rawOutput: progress });
  expect(s.patch('send', { status: 'failed', content: blocks('Operation refused') }))
    .toMatchObject([{ content: { raw: 'Operation refused', rawOutput: progress }, isError: true }]);
  s.start('sparse', { ...send, rawOutput: progress });
  s.patch('sparse', { content: blocks('Operation refused') });
  expect(s.patch('sparse', { status: 'failed' })).toMatchObject([{ content: { raw: 'Operation refused', rawOutput: progress } }]);
  s.start('reverse', { ...send, content: blocks('In progress') });
  expect(s.patch('reverse', { status: 'failed', rawOutput: 'Operation refused' }))
    .toMatchObject([{ content: { raw: 'Operation refused', items: blocks('In progress') }, isError: true }]);
  s.start('edit', { name: 'replace_file_content', rawInput: { TargetFile: '/work/file' }, rawOutput: progress });
  expect(s.patch('edit', { status: 'failed', content: blocks('Operation refused') })[0])
    .toEqual(expect.objectContaining({ content: { raw: 'Operation refused' }, isError: true }));
});

test('publishes the oldest incomplete call rather than losing it when the pending budget fills', () => {
  const s = session();
  for (let i = 0; i < 512; i++) expect(s.start(`call-${i}`, {})).toEqual([]);
  expect(s.start('overflow', {})).toMatchObject([{ type: 'unknown-tool-use', toolId: 'call-0' }]);
  const remaining = s.end();
  expect(remaining).toHaveLength(512);
  expect(remaining.at(-1)).toMatchObject({ toolId: 'overflow' });
});

test('ordinary progress at the active-call limit cannot evict an unpublished use row', () => {
  const s = session();
  for (let i = 0; i < 513; i++) s.start(`job-${i}`, { name: 'manage_task', rawInput: { Action: 'list' } });
  expect(s.start('plan', { title: 'Run update_steps' })).toEqual([]);
  // Recent calls publish no new rows on progress, even with the active cache full.
  for (let i = 1; i < 513; i++) expect(s.patch(`job-${i}`, { status: 'in_progress' })).toEqual([]);
  expect(s.patch('job-512', { status: 'completed' })).toMatchObject([
    { toolId: 'plan', type: 'external-tool-use' }, { toolId: 'job-512', type: 'tool-result' },
  ]);
});

test('does not store proposed edit diffs as successful or failed tool output', () => {
  const s = session();
  const edit = { name: 'replace_file_content', rawInput: { TargetFile: '/work/file', TargetContent: 'one', ReplacementContent: 'two' } };
  const content = [{ type: 'diff', path: '/work/file', oldText: 'one', newText: 'two' }];
  expect(s.start('edit', { ...edit, content, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({ content: {}, isError: false }));
  s.start('proposal', { ...edit, content });
  expect(s.patch('proposal', { status: 'failed' })[0]).toEqual(expect.objectContaining({ content: { status: 'failed' }, isError: true }));
  expect(s.start('native', { ...edit, status: 'completed', rawOutput: 'Opaque native payload' }).at(-1))
    .toEqual(expect.objectContaining({ content: {}, isError: false }));
});

test('publishes waiting calls before the first transcript frame for a permission-only ID', () => {
  const s = session();
  expect(s.start('earlier', { name: 'run_command' })).toEqual([]);
  s.permission('later');
  expect(s.patch('later', { name: 'manage_task', rawInput: { Action: 'list' }, status: 'completed' })).toMatchObject([
    { toolId: 'earlier', type: 'external-tool-use' }, { toolId: 'later', type: 'background-task-tool-use' },
    { toolId: 'later', type: 'tool-result' },
  ]);
});

test('permission-only IDs cannot evict a running command or turn its exit failure into success', () => {
  const s = session();
  s.start('cmd', { name: 'run_command', rawInput: { CommandLine: 'false' } });
  for (let i = 0; i < 513; i++) s.permission(`permission-${i}`);
  expect(s.patch('cmd', { status: 'completed', rawOutput: { exit_code: 1 } }))
    .toMatchObject([{ type: 'tool-result', content: { exitCode: 1 }, isError: true }]);
});
