import { expect, test } from 'bun:test';
import { AntigravityAcpEventConverter } from '../antigravity-acp-event-converter.ts';

const LIST_TASK = { name: 'manage_task', rawInput: { Action: 'list' } };

function textBlock(text: string) {
  return { type: 'content', content: { type: 'text', text } };
}

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

test('reports native plan activity with late arguments, but does not reinterpret MCP tools', () => {
  const s = session();
  expect(s.start('enter', { name: 'enter_plan_mode', rawInput: { reason: 'Check layout' } }))
    .toMatchObject([{ type: 'antigravity-enter-plan-mode-tool-use', reason: 'Check layout' }]);
  expect(s.start('exit', { name: 'exit_plan_mode', rawInput: { hint: true } })).toEqual([]);
  expect(s.patch('exit', { rawInput: { Plan: '    example\n' }, status: 'completed' })).toMatchObject([
    { type: 'antigravity-exit-plan-mode-tool-use', plan: '    example\n' }, { type: 'tool-result', content: {}, isError: false },
  ]);
  expect(s.start('mcp', { name: 'exit_plan_mode', _meta: { is_mcp_tool_call: true },
    rawInput: { plan: 'Example' }, status: 'completed' })[0]).toMatchObject({ type: 'external-tool-use' });
});

test('pairs delayed and cron schedule requests with provider results, not Garcon jobs', () => {
  const s = session();
  expect(s.start('timer', { name: 'schedule', rawInput: { DurationSeconds: 120, TimerCondition: 'sender' } })).toEqual([]);
  expect(s.patch('timer', { rawInput: { Prompt: '  Check\n' }, rawOutput: { id: 'timer-1' }, status: 'completed' })).toMatchObject([
    { type: 'schedule-tool-use', request: { action: 'wakeup', delaySeconds: 120, prompt: '  Check\n', timerCondition: 'sender' } },
    { type: 'tool-result', content: { rawOutput: { id: 'timer-1' } }, isError: false },
  ]);
  const cron = { cron_expression: '*/5 * * * *', prompt: 'Check', max_iterations: 1, is_daemon: false };
  expect(s.start('cron', { name: 'schedule', rawInput: cron })).toEqual([]);
  expect(s.patch('cron', { rawInput: { ExactTiming: true }, status: 'completed' })[0]).toEqual(expect.objectContaining({
    type: 'schedule-tool-use', request: { action: 'cron', expression: cron.cron_expression, prompt: 'Check',
      daemon: false, maxIterations: 1, exactTiming: true },
  }));
  const ambiguous = { ...cron, DurationSeconds: 60 };
  expect(s.start('invalid', { name: 'schedule', rawInput: ambiguous, status: 'failed' })).toMatchObject([
    { type: 'external-tool-use', input: ambiguous }, { type: 'tool-result', isError: true },
  ]);
});

test('keeps a schedule open for a cancellation condition or MCP address until publication', () => {
  const s = session();
  const timer = { DurationSeconds: 120, Prompt: 'Check' };
  expect(s.start('mcp', { name: 'schedule', rawInput: { ...timer, server: 'server' } })).toEqual([]);
  expect(s.patch('mcp', { rawInput: { tool: 'operation', arguments: { key: 1 } } })).toMatchObject([
    { type: 'mcp-tool-use', server: 'server', tool: 'operation' },
  ]);
  expect(s.start('timer', { name: 'schedule', rawInput: timer })).toEqual([]);
  expect(s.patch('timer', { rawInput: { TimerCondition: 'sender' } })).toEqual([]);
  expect(s.end()).toMatchObject([{ type: 'schedule-tool-use', request: { timerCondition: 'sender' } }]);
});

test('shows a repeated terminal schedule diagnostic alongside metadata without promoting cached progress', () => {
  const s = session();
  const content = [textBlock('Could not save this schedule')];
  const timer = { name: 'schedule', rawInput: { DurationSeconds: 1, Prompt: 'Check' }, content };
  const rawOutput = { attempts: 1 };
  s.start('reported', timer);
  expect(s.patch('reported', { status: 'failed', content, rawOutput }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', raw: 'Could not save this schedule', rawOutput }, isError: true,
  }));
  s.start('cached', timer);
  expect(s.patch('cached', { status: 'failed', rawOutput }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', items: content, rawOutput }, isError: true,
  }));
  const progress = { output: 'Preparing schedule', attempts: 1 };
  s.start('earlier-output', { ...timer, rawOutput: progress });
  expect(s.patch('earlier-output', { status: 'failed', content }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', raw: 'Could not save this schedule', rawOutput: progress }, isError: true,
  }));
});

test.each(['schedule', 'enter_plan_mode', 'exit_plan_mode'])('prioritizes explicit terminal output for %s over intervening progress', name => {
  const s = session();
  const rawInput = name === 'schedule' ? { DurationSeconds: 1, Prompt: 'Check' }
    : name === 'enter_plan_mode' ? { Reason: 'Check' } : { Plan: 'Check' };
  const rawOutput = { output: 'Operation refused' };
  const content = [textBlock('Checking limits')];
  s.start('call', { name, rawInput, rawOutput });
  s.patch('call', { content });
  expect(s.patch('call', { rawOutput, status: 'failed' }).at(-1)).toEqual(expect.objectContaining({
    content: { raw: 'Operation refused', items: content, status: 'failed' }, isError: true,
  }));
});

test('uses explicit completed schedule output before echoed progress and falls back to terminal blocks before cached data', () => {
  const s = session();
  const timer = { name: 'schedule', rawInput: { DurationSeconds: 1, Prompt: 'Check' } };
  const progress = [textBlock('Preparing')];
  const rawOutput = { output: 'Timer saved', id: 'job' };
  s.start('both', { ...timer, rawOutput });
  s.patch('both', { content: progress });
  expect(s.patch('both', { rawOutput, content: progress, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({
    content: { rawOutput, items: progress }, isError: false,
  }));
  const content = [textBlock('Timer saved')];
  s.start('text', { ...timer, content });
  expect(s.patch('text', { rawOutput: { id: 'job' }, content, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({
    content: { raw: 'Timer saved', rawOutput: { id: 'job' } }, isError: false,
  }));
});

test('retains every terminal block when a cached output is echoed alongside other text', () => {
  for (const rawOutput of [{ output: 'Operation refused' }, { output: 'Operation refused', attempts: 1 }]) {
    const s = session();
    const progress = textBlock('Checking limits');
    s.start('call', { name: 'schedule', rawInput: { DurationSeconds: 1, Prompt: 'Check' }, content: [progress] });
    s.patch('call', { rawOutput });
    const row = s.patch('call', { status: 'failed', content: [progress, textBlock('Operation refused')] }).at(-1);
    expect(row).toEqual(expect.objectContaining({ isError: true, content: {
      raw: 'Checking limits\nOperation refused', status: 'failed', ...('attempts' in rawOutput ? { rawOutput: { attempts: 1 } } : {}),
    } }));
  }
});

test('publishes a large aggregate echo only once and keeps interleaved attachments in order', () => {
  const s = session();
  const timer = { name: 'schedule', rawInput: { DurationSeconds: 60, Prompt: 'Check' } };
  const first = 'x'.repeat(9 * 1024 * 1024);
  const output = first + '\nOperation refused';
  s.start('aggregate', { ...timer, rawOutput: { output, attempts: 1 } });
  const row = s.patch('aggregate', { status: 'failed', content: [textBlock(first), textBlock('Operation refused')] }).at(-1);
  if (row?.type !== 'tool-result') throw new Error('Expected a tool result');
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(output.length + 1024);
  expect(row.content.raw === output).toBe(true);
  expect(row.content.rawOutput).toEqual({ attempts: 1 });

  const content = [textBlock('Checking'), { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
    textBlock('Operation refused')];
  s.start('mixed', { ...timer, rawOutput: { output: 'Operation refused', attempts: 1 } });
  expect(s.patch('mixed', { status: 'failed', content }).at(-1)).toEqual(expect.objectContaining({
    content: { status: 'failed', items: content, rawOutput: { attempts: 1 } },
  }));
});

test('retains the original arguments when a native schedule cannot be represented', () => {
  const s = session();
  for (const [index, rawInput] of [
    { DurationSeconds: -1 }, { DurationSeconds: 1.5 }, { DurationSeconds: 10, ExactTiming: true },
    { DurationSeconds: 10, TimerCondition: ' ' }, { CronExpression: '  ' },
    { CronExpression: '* * * * *', MaxIterations: -1 }, { CronExpression: '* * * * *', TimerCondition: 'any' },
    { DurationSeconds: 120, MaxIterations: 2 },
  ].entries()) {
    const input = { ...rawInput, Prompt: 'Check' };
    expect(s.start(String(index), { name: 'schedule', rawInput: input, status: 'failed' })[0])
      .toMatchObject({ type: 'external-tool-use', input });
  }
});

test('retains explicitly supplied timer defaults and daemon flags accepted by agy', () => {
  const s = session();
  for (const daemon of [true, false]) {
    const rawInput = { DurationSeconds: 1, Prompt: 'Check', IsDaemon: daemon, TimerCondition: '', ExactTiming: false };
    expect(s.start(String(daemon), { name: 'schedule', rawInput, status: 'completed' })[0])
      .toMatchObject({ type: 'schedule-tool-use', request: { daemon, timerCondition: '', exactTiming: false } });
  }
});

test('keeps unknown options and conflicting aliases from late frames in the raw schedule fallback', () => {
  const timer = { DurationSeconds: 30, Prompt: 'Check' };
  for (const patch of [{ FutureOption: 'fixture' }, { duration_seconds: 60 }]) {
    const s = session();
    expect(s.start('timer', { name: 'schedule', rawInput: timer })).toEqual([]);
    expect(s.patch('timer', { rawInput: patch, status: 'failed' })[0]).toMatchObject({
      type: 'external-tool-use', input: { ...timer, ...patch },
    });
  }
  expect(session().start('echo', { name: 'schedule', rawInput: { ...timer, duration_seconds: 30 }, status: 'completed' })[0])
    .toMatchObject({ type: 'schedule-tool-use', request: { action: 'wakeup', delaySeconds: 30, prompt: 'Check' } });
});

test('retains explicit inactive timer fields and an unlimited iteration count on a cron', () => {
  const rawInput = { CronExpression: '0 9 * * *', Prompt: 'Check', DurationSeconds: 0, TimerCondition: '', MaxIterations: 0 };
  expect(session().start('cron', { name: 'schedule', rawInput, status: 'completed' })[0]).toMatchObject({
    type: 'schedule-tool-use', request: { action: 'cron', expression: rawInput.CronExpression, prompt: 'Check',
      delaySeconds: 0, timerCondition: '', maxIterations: 0 },
  });
});

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
  expect(s.start('envelope', { title: 'Run update_steps', rawInput: { server: 'docs', tool: 'lookup', arguments: {}, steps: [] } }))
    .toMatchObject([{ type: 'mcp-tool-use', server: 'docs', tool: 'lookup' }]);
  expect(s.start('title', { title: 'Run update_steps', rawInput: { steps: [] } })).toEqual([]);
  expect(s.patch('title', { status: 'completed', _meta: { is_mcp_tool_call: true } }))
    .toMatchObject([{ type: 'unknown-tool-use' }, { type: 'tool-result' }]);
});

test('keeps reported structured and progress output without manufacturing a successful result body', () => {
  const s = session();
  const rawOutput = { tasks: [{ id: 'job' }] };
  expect(s.start('list', { ...LIST_TASK, rawOutput, status: 'completed' }).at(-1)).toMatchObject({ content: { rawOutput }, isError: false });
  s.start('progress', LIST_TASK);
  s.patch('progress', { content: [textBlock('Diagnostic')] });
  expect(s.patch('progress', { status: 'failed' })).toMatchObject([{ content: { raw: 'Diagnostic' }, isError: true }]);
  s.start('replace', { ...LIST_TASK, rawOutput: 'Old' });
  expect(s.patch('replace', { status: 'completed', rawOutput: 'Final' })).toMatchObject([{ content: { raw: 'Final' } }]);
  s.start('clear', { ...LIST_TASK, rawOutput: 'Old' });
  expect(s.patch('clear', { status: 'completed', content: [] })[0]).toEqual(expect.objectContaining({ content: { raw: 'Old' }, isError: false }));
  expect(s.start('empty', { ...LIST_TASK, status: 'completed' }).at(-1)).toEqual(expect.objectContaining({ content: {}, isError: false }));
  s.start('cmd', { name: 'run_command', rawInput: { CommandLine: 'false' } });
  s.patch('cmd', { rawOutput: { exit_code: 1 } });
  expect(s.patch('cmd', { status: 'completed' })).toMatchObject([{ content: { exitCode: 1 }, isError: true }]);
});

test.each(['raw first', 'blocks first'] as const)('stores an output echo only once alongside distinct text and attachments (%s)', order => {
  const s = session();
  const output = 'x'.repeat(8 * 1024 * 1024);
  const attachment = { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } };
  const update = textBlock('Still checking');
  const raw = { rawOutput: { output, count: 1 } };
  const blocks = { content: [textBlock(output + '\n'), update, attachment] };
  const [first, last] = order === 'raw first' ? [raw, blocks] : [blocks, raw];
  s.start('list', { ...LIST_TASK, ...first });
  const [result] = s.patch('list', { status: 'completed', ...last });
  if (result?.type !== 'tool-result') throw new Error('Expected a tool result');
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(output.length + 1024);
  expect(result.content).toEqual({ ...raw, items: [update, attachment] });
});

test('echoes confirm the primary output without turning repeated progress into a new diagnostic', () => {
  const s = session();
  const progress = textBlock('Sending '.repeat(500));
  const error = 'Operation refused';
  for (const rawOutput of [error, { output: error }, { output: error, attempt: 2 }]) {
    const id = JSON.stringify(rawOutput);
    s.start(id, { ...LIST_TASK, content: [progress] });
    s.patch(id, { rawOutput });
    const [row] = s.patch(id, { content: [progress, textBlock(error + '\n')], status: 'failed' });
    const primary = typeof rawOutput === 'object' && 'attempt' in rawOutput ? { rawOutput } : { raw: error };
    expect(row).toMatchObject({ content: { ...primary, items: [progress], status: 'failed' } });
  }
  s.start('confirmed', { ...LIST_TASK, rawOutput: 'Waiting', content: [textBlock('Waiting')] });
  expect(s.patch('confirmed', { status: 'failed', content: [textBlock('Waiting'), textBlock(error)] })[0])
    .toMatchObject({ content: { raw: error, rawOutput: 'Waiting' } });
});

test('drops an exact whitespace-only echo without discarding the structured provider payload', () => {
  const s = session();
  const output = ' '.repeat(8 * 1024 * 1024);
  const rawOutput = { output, count: 1 };
  s.start('list', { ...LIST_TASK, content: [textBlock(output), textBlock('Checking')] });
  const [row] = s.patch('list', { status: 'completed', rawOutput });
  if (row?.type !== 'tool-result') throw new Error('Expected a tool result');
  expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(output.length + 1024);
  expect(row.content).toEqual({ rawOutput, items: [textBlock('Checking')] });
});

test('merges rawOutput and content as independent ACP fields and treats null rawOutput as unchanged', () => {
  const s = session();
  const rawOutput = { tasks: ['one'] };
  s.start('task', { ...LIST_TASK, rawOutput, content: [textBlock('Earlier')] });
  expect(s.patch('task', { status: 'completed', rawOutput: null, content: [] })[0])
    .toEqual(expect.objectContaining({ content: { rawOutput }, isError: false }));
  s.start('text', { ...LIST_TASK, rawOutput: 'Previous', content: [textBlock('Diagnostic')] });
  expect(s.patch('text', { status: 'failed', rawOutput: {} })[0])
    .toEqual(expect.objectContaining({ content: { raw: 'Diagnostic', status: 'failed' }, isError: true }));
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
  s.start('late-name', { rawInput: { server: 'docs' } });
  expect(s.patch('late-name', { name: 'mcp_docs_lookup', rawInput: { tool: 'lookup' }, status: 'completed' }))
    .toMatchObject([{ type: 'mcp-tool-use', server: 'docs', tool: 'lookup' }, { type: 'tool-result' }]);
  s.start('late-args', { _meta: { is_mcp_tool_call: true }, rawInput: { server: 'docs' } });
  expect(s.patch('late-args', { rawInput: { tool: 'lookup' } })).toEqual([]);
  expect(s.patch('late-args', { rawInput: { arguments: { term: 'needle' } } }))
    .toMatchObject([{ type: 'mcp-tool-use', input: { term: 'needle' } }]);
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
  const send = { name: 'send_message', rawInput: { Recipient: 'peer', Message: 'Hello' } };
  const progress = { output: 'In progress' };
  s.start('send', { ...send, rawOutput: progress });
  expect(s.patch('send', { status: 'failed', content: [textBlock('Operation refused')] }))
    .toMatchObject([{ content: { raw: 'Operation refused', rawOutput: progress }, isError: true }]);
  s.start('sparse', { ...send, rawOutput: progress });
  s.patch('sparse', { content: [textBlock('Operation refused')] });
  expect(s.patch('sparse', { status: 'failed' })).toMatchObject([{ content: { raw: 'Operation refused', rawOutput: progress } }]);
  s.start('repeat-raw', { ...send, rawOutput: progress });
  expect(s.patch('repeat-raw', { status: 'failed', rawOutput: progress, content: [textBlock('Operation refused')] }))
    .toMatchObject([{ content: { raw: 'Operation refused', rawOutput: progress } }]);
  s.start('repeat-blocks', { ...send, content: [textBlock('In progress')] });
  expect(s.patch('repeat-blocks', { status: 'failed', rawOutput: 'Operation refused', content: [textBlock('In progress')] }))
    .toMatchObject([{ content: { raw: 'Operation refused', items: [textBlock('In progress')] } }]);
  s.start('structured', { ...send, content: [textBlock('In progress')] });
  expect(s.patch('structured', { status: 'failed', rawOutput: { reason: 'Operation refused' } })[0])
    .toEqual(expect.objectContaining({ content: { rawOutput: { reason: 'Operation refused' }, items: [textBlock('In progress')], status: 'failed' } }));
  s.start('repeated-data', { ...send, rawOutput: { delivered: 0 } });
  s.patch('repeated-data', { content: [textBlock('Operation refused')] });
  expect(s.patch('repeated-data', { status: 'failed', rawOutput: { delivered: 0 } })[0])
    .toEqual(expect.objectContaining({ content: { raw: 'Operation refused', rawOutput: { delivered: 0 }, status: 'failed' } }));
  s.start('retry', { ...send, rawOutput: { output: 'Operation refused', attempt: 1 } });
  s.patch('retry', { content: [textBlock('Retrying')] });
  expect(s.patch('retry', { status: 'failed', rawOutput: { output: 'Operation refused', attempt: 2 } })[0])
    .toEqual(expect.objectContaining({ content: { rawOutput: { output: 'Operation refused', attempt: 2 },
      items: [textBlock('Retrying')], status: 'failed' } }));
  s.start('cancel', { ...send, content: [textBlock('Sending')] });
  expect(s.patch('cancel', { status: 'cancelled' })[0])
    .toEqual(expect.objectContaining({ content: { raw: 'Sending', status: 'cancelled' }, isError: true }));
  s.start('reverse', { ...send, content: [textBlock('In progress')] });
  expect(s.patch('reverse', { status: 'failed', rawOutput: 'Operation refused' }))
    .toMatchObject([{ content: { raw: 'Operation refused', items: [textBlock('In progress')] }, isError: true }]);
  s.start('edit', { name: 'replace_file_content', rawInput: { TargetFile: '/work/file' }, rawOutput: progress });
  expect(s.patch('edit', { status: 'failed', content: [textBlock('Operation refused')] })[0])
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
  for (let i = 0; i < 513; i++) s.start(`job-${i}`, LIST_TASK);
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
  expect(s.patch('later', { ...LIST_TASK, status: 'completed' })).toMatchObject([
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
