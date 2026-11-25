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
  expect(s.start('named', { name: 'update_steps', rawInput: { steps: [] }, _meta: { is_mcp_tool_call: true } }))
    .toMatchObject([{ type: 'external-tool-use', name: 'update_steps', input: { steps: [] } }]);
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
  expect(s.patch('clear', { status: 'completed', content: [] })[0]).toEqual(expect.objectContaining({ content: {}, isError: false }));
  expect(s.start('empty', { ...list, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({ content: {}, isError: false }));
  s.start('cmd', { name: 'run_command', rawInput: { CommandLine: 'false' } });
  s.patch('cmd', { rawOutput: { exit_code: 1 } });
  expect(s.patch('cmd', { status: 'completed' })).toMatchObject([{ content: { exitCode: 1 }, isError: true }]);
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
