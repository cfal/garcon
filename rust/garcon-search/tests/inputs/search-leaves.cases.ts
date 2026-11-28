import { test } from 'bun:test';
import { projectSearchMessage, queryLatencySnapshot } from './search-leaves-oracle.ts';

const timestamp = '2026-11-28T00:00:00Z';
const user = (content: string, at = timestamp) => ({ type: 'user-message', timestamp: at, content });
const tool = (type: string, fields: Record<string, unknown>) => ({ type, timestamp, toolId: 'synthetic-tool', ...fields });
const result = (content: unknown, isError = false, primaryTextItems?: number[]) =>
  ({ ...tool('tool-result', { content, isError }), primaryTextItems });
const text = (body: string) => ({ type: 'text', text: body });
const wrapped = (body: string) => ({ type: 'content', content: text(body) });

test('projects roles, retained diagnostics and bounded bodies', () => {
  const complete = { outcome: 'finished', exitCode: 0, signal: null, capture: 'complete',
    cwd: { kind: 'reported', path: '/synthetic/project' } };
  const messages = [
    user('\uFEFF Synthetic\u00a0request\nwith spaces'),
    user('Boundary', 'é'.repeat(128)),
    user('Over boundary', 'é'.repeat(128) + 'x'),
    user('x'.repeat(63_999) + '\u{1f642}'),
    { type: 'assistant-message', timestamp, content: 'Synthetic response' },
    { type: 'thinking', timestamp, content: 'Synthetic reasoning' },
    { type: 'error', timestamp, content: 'Not searchable' },
    { type: 'transcript-notice', timestamp, content: 'Not searchable' },
    { type: 'compaction', timestamp, trigger: 'auto', summary: 'Synthetic context' },
    { type: 'agent-switch', timestamp, fromAgentId: 'codex', toAgentId: 'claude', fromModel: 'm1' },
    ...['stdout', 'stderr'].map(channel => ({
      type: 'command-output', timestamp, channel, commandId: 'fixture', offset: 0,
      format: 'plain', content: 'Synthetic output', context: null,
    })),
    ...[complete, { ...complete, exitCode: 7, outcome: 'failed', capture: 'incomplete' },
      { ...complete, cwd: { kind: 'unavailable', reason: 'Synthetic cwd failure' } }].map(result =>
      ({ type: 'command-result', timestamp, commandId: 'fixture', result })),
  ];
  for (const message of messages) projectSearchMessage(message);
});

test('walks nested tool values under character, depth and node budgets', () => {
  let deep: unknown = { excluded: 'Too deep' };
  for (let depth = 0; depth < 11; depth += 1) deep = { [`depth${depth}`]: deep };
  const messages = [
    tool('antigravity-enter-plan-mode-tool-use', { reason: '' }),
    tool('antigravity-exit-plan-mode-tool-use', { plan: 'Synthetic plan' }),
    tool('schedule-tool-use', { request: { action: 'wakeup', delaySeconds: 60.25, prompt: 'Check build', timerCondition: 'builder' } }),
    tool('schedule-tool-use', { request: { action: 'list' }, nativeName: 'CronList' }),
    tool('schedule-tool-use', { request: { action: 'cron', expression: '0 12 * * *', prompt: 'Run at noon', recurring: true, daemon: false } }),
    tool('background-task-tool-use', { action: 'send_input', taskId: 'task', input: 'Check logs' }),
    tool('agent-message-tool-use', { recipient: 'reviewer', message: 'Check tests' }),
    tool('pi-tool-search-tool-use', { query: 'issue tools' }),
    tool('claude-tool-search-tool-use', { query: 'select:Monitor' }),
    tool('claude-monitor-tool-use', { description: 'Synthetic watch', command: 'printf synthetic',
      webSocketUrl: 'ws://example.invalid/events', webSocketProtocols: ['events'], allowedDomains: ['example.invalid'] }),
    tool('ask-user-question-tool-use', {
      title: 'Synthetic question',
      questions: [{ id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'Testing' }], allowFreeText: true }],
    }),
    tool('cursor-create-plan-tool-use', {
      name: 'Synthetic plan', plan: 'Run tests',
      todos: [{ content: 'Write', status: 'in_progress', id: 'todo-1' }],
      phases: [{ name: 'Verify', todos: [{ content: 'Check', status: 'completed' }] }],
    }),
    tool('codex-subagent-tool-use', { action: 'spawn_agent',
      details: { targets: ['test'], message: 'Synthetic detail', forkContext: false, timeoutMs: 500,
        items: [{ type: 'text', text: 'Inspect tests' }],
        agentStates: { '10': { status: 'running' }, '2': { status: 'pendingInit' } } },
    }),
    tool('write-stdin-tool-use', { input: { '10': true, '2': 1e21, after: deep, code: 'printf synthetic' } }),
    tool('request-permissions-tool-use', {
      reason: 'Synthetic reason',
      permissions: { values: Array.from({ length: 513 }, () => null), notVisited: 'Outside node budget' },
    }),
    tool('wait-tool-use', { executionId: 'execution', yieldTimeMs: 2.75, maxTokens: 0, terminate: false }),
    { type: 'permission-request', timestamp, permissionOccurrenceId: 'permission',
      requestedTool: tool('read-tool-use', { filePath: '/synthetic/project/example.txt' }) },
    tool('mcp-tool-use', { server: 'fixture', tool: 'inspect', input: { a: 'x'.repeat(4500), b: 'unvisited' } }),
  ];
  for (const message of messages) projectSearchMessage(message);
});

test('keeps stored result diagnostics ahead of bulky progress and suppresses duplicate primary text', () => {
  for (const content of [
    { items: [] }, { content: [text(' \t\n')] }, { items: [wrapped(' ')] },
    { rawOutput: { output: ' ' } }, { items: [], count: 0 }, { content: [text('Done')] },
  ]) {
    projectSearchMessage(result(content));
    projectSearchMessage(result(content, true));
  }
  const working = 'working '.repeat(500);
  for (const content of [
    { rawOutput: { output: working }, raw: 'Operation refused' },
    { items: [text(working)], raw: 'Operation refused' },
    { rawOutput: { details: working, output: 'Operation refused' }, items: [text(working)], status: 'failed' },
    { rawOutput: { error: 'Operation refused', output: ' \t\n'.repeat(1000) }, items: [text(working)], status: 'failed' },
    { rawOutput: { error: 'Operation refused', output: 'Working' + ' '.repeat(3000) }, items: [text(working)] },
  ]) projectSearchMessage(result(content, true));
  for (const [progress, indices] of [[working, [2]], ['Checking', [0, 2]]] as const) {
    projectSearchMessage(result({ items: [wrapped(progress), {type: 'image', data: 'A'.repeat(5000)},
      wrapped('Operation refused')], rawOutput: { attempts: 1 } }, true, [...indices]));
  }
  for (const last of [' ', 'Operation refused']) {
    const items = Array.from({ length: 513 }, () => text(' \t\n'));
    projectSearchMessage(result({ items: [...items, text(last)] }, false, [items.length]));
  }
  projectSearchMessage(result('header' + 'x'.repeat(3000) + 'tail'));
  projectSearchMessage(result('a'.repeat(1999) + '\u{1f642}' + 'b'.repeat(2400) + '\u{1f642}' + 'c'.repeat(511)));
});

test('captures latency counts, independent quantiles and eviction', () => {
  queryLatencySnapshot([]);
  queryLatencySnapshot([['timed-out'], ['busy']]);
  queryLatencySnapshot([
    ['served', 25, 0, 25], ['served', 25, 0, 25], ['served', 0, 8, 8],
    ['served', 0, 8, 8], ['served', 10, 0, 10], ['served', 0, 10, 10],
  ]);
  queryLatencySnapshot([['served', 1.6, 2.6, 4.2], ['served', 1, 2, 8.6]]);
  queryLatencySnapshot([['served', 100_000, 100_000, 200_000],
    ...Array.from({ length: 512 }, (_, index) => ['served', index + 1, index + 1, (index + 1) * 2] as const)
      .map(op => [...op] as ['served', number, number, number]),
  ]);
  queryLatencySnapshot(Array.from({ length: 20 }, (_, index) => ['served', index, index, index * 2]));
});

test('orders integer indices before other provider keys', () => {
  projectSearchMessage(tool('unknown-tool-use', { rawName: 'custom', input: { b: 'bee', '10': 'ten', '2': 'two' } }));
  const states = { normal: { status: 'running' }, '10': { status: 'completed' }, '2': { status: 'pendingInit' } };
  projectSearchMessage(tool('codex-subagent-tool-use', { action: 'spawn_agent', details: { agentStates: states } }));
});
